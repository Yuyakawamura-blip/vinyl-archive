(() => {
  const config = window.VINYL_CLOUD_CONFIG || {};
  const configured = Boolean(
    config.url && config.publishableKey && window.supabase?.createClient,
  );
  let client = null;
  let currentUser = null;
  let recordsChannel = null;
  let pullTimer = null;
  let pulling = false;
  let syncing = false;
  let rerun = false;
  let authMode = "login";
  let activeUserId = null;
  let authTransition = Promise.resolve();
  const lastCloudUserKey = "vinyl-archive-last-cloud-user";
  const pendingDeleteKey = "vinyl-archive-pending-deletes";
  const localModeKey = "vinyl-archive-local-mode";
  const $ = (selector) => document.querySelector(selector);

  function updateStatus(state, label) {
    const button = $("#syncStatus");
    if (!button) return;
    button.className = `sync-status ${state}`;
    button.querySelector("span").textContent = label;
    button.title = label;
  }
  function localRecords() {
    return (window.vinylApp?.getRecords?.() || []).filter(
      (record) => !String(record.id).startsWith("demo-"),
    );
  }
  function dataUrlToBlob(dataUrl) {
    const [meta, data] = dataUrl.split(","),
      mime = meta.match(/data:(.*?);/)?.[1] || "image/jpeg",
      bytes = atob(data),
      array = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) array[i] = bytes.charCodeAt(i);
    return new Blob([array], { type: mime });
  }
  function cleanRecord(record) {
    const copy = { ...record };
    delete copy.cover;
    delete copy.coverPath;
    delete copy.syncStatus;
    delete copy.aiRetryRequested;
    delete copy.coverUrlExpiresAt;
    return copy;
  }
  function pendingDeletes() {
    try {
      return JSON.parse(localStorage.getItem(pendingDeleteKey) || "[]");
    } catch {
      return [];
    }
  }
  function setPendingDeletes(ids) {
    localStorage.setItem(pendingDeleteKey, JSON.stringify([...new Set(ids)]));
  }

  async function uploadRecord(record, existingRecord = null) {
    let coverPath = existingRecord?.cover_path || record.coverPath || null;
    if (!existingRecord && record.cover?.startsWith("data:image/")) {
      const blob = dataUrlToBlob(record.cover),
        extension =
          {
            "image/png": "png",
            "image/webp": "webp",
            "image/heic": "heic",
            "image/heif": "heif",
          }[blob.type] || "jpg";
      coverPath = `${currentUser.id}/${record.id}.${extension}`;
      const { error: uploadError } = await client.storage
        .from("record-covers")
        .upload(coverPath, blob, {
          contentType: blob.type || "image/jpeg",
          upsert: true,
        });
      if (uploadError) throw uploadError;
    }
    if (!existingRecord) {
      const now = new Date().toISOString();
      const { error } = await client.from("records").upsert(
        {
          id: record.id,
          user_id: currentUser.id,
          data: cleanRecord(record),
          cover_path: coverPath,
          ai_status: record.aiStatus || "pending",
          updated_at: now,
        },
        { onConflict: "id" },
      );
      if (error) throw error;
    } else if (!coverPath && record.cover?.startsWith("data:image/")) {
      const blob = dataUrlToBlob(record.cover);
      const extension =
        { "image/png": "png", "image/webp": "webp" }[blob.type] || "jpg";
      coverPath = `${currentUser.id}/${record.id}.${extension}`;
      const { error: uploadError } = await client.storage
        .from("record-covers")
        .upload(coverPath, blob, {
          contentType: blob.type || "image/jpeg",
          upsert: true,
        });
      if (uploadError) throw uploadError;
      const { error } = await client
        .from("records")
        .update({ cover_path: coverPath, updated_at: new Date().toISOString() })
        .eq("id", record.id);
      if (error) throw error;
    }
    record.coverPath = coverPath;
    record.syncStatus = "synced";
    record.aiRetryRequested = false;
  }

  async function requestAnalysis(record) {
    const now = new Date().toISOString();
    record.aiStatus = "processing";
    record.aiError = null;
    window.vinylApp?.replaceRecords?.(window.vinylApp.getRecords());
    const { error: statusError } = await client
      .from("records")
      .update({ ai_status: "processing", ai_error: null, updated_at: now })
      .eq("id", record.id);
    if (statusError) throw statusError;

    const { error: analysisError } = await client.functions.invoke(
      "analyze-record",
      { body: { recordId: record.id } },
    );
    if (!analysisError) return;

    let message = analysisError.message || "AI解析の呼び出しに失敗しました";
    if (analysisError.context instanceof Response) {
      try {
        const text = await analysisError.context.clone().text();
        try {
          const body = JSON.parse(text);
          message = body?.error || body?.message || message;
        } catch {
          if (text.trim()) message = text.slice(0, 500);
        }
      } catch {}
    }
    record.aiStatus = "error";
    record.aiError = message;
    const { error: persistError } = await client
      .from("records")
      .update({
        ai_status: "error",
        ai_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", record.id);
    if (persistError)
      console.error("Could not persist AI analysis error", persistError);
    window.vinylApp?.replaceRecords?.(window.vinylApp.getRecords());
    console.warn(
      "AI analysis request failed; the record will be retried on the next sync",
      analysisError,
    );
  }

  async function removePendingRecords() {
    const pending = pendingDeletes().map((item) =>
      typeof item === "string" ? { id: item, coverPath: null } : item,
    );
    if (!pending.length) return;
    const { error } = await client
      .from("records")
      .delete()
      .in(
        "id",
        pending.map((item) => item.id),
      );
    if (error) throw error;
    const paths = pending.map((item) => item.coverPath).filter(Boolean);
    if (paths.length) await client.storage.from("record-covers").remove(paths);
    setPendingDeletes([]);
  }

  async function downloadRecords() {
    const { data, error } = await client
      .from("records")
      .select("id,data,cover_path,ai_status,ai_error,updated_at")
      .order("created_at", { ascending: false });
    if (error) throw error;
    const existingById = new Map(localRecords().map((record) => [record.id, record]));
    const hydrated = await Promise.all(
      (data || []).map(async (row) => {
        let cover = "";
        let coverUrlExpiresAt = 0;
        if (row.cover_path) {
          const cached = existingById.get(row.id);
          if (
            cached?.coverPath === row.cover_path &&
            cached.cover &&
            !cached.cover.startsWith("data:image/") &&
            Number(cached.coverUrlExpiresAt) > Date.now() + 60 * 1000
          ) {
            cover = cached.cover;
            coverUrlExpiresAt = Number(cached.coverUrlExpiresAt);
          } else {
            const { data: signed } = await client.storage
              .from("record-covers")
              .createSignedUrl(row.cover_path, 60 * 60 * 24 * 7);
            cover = signed?.signedUrl || "";
            coverUrlExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
          }
        }
        return {
          ...row.data,
          id: row.id,
          cover,
          coverPath: row.cover_path,
          coverUrlExpiresAt,
          aiStatus: row.ai_status,
          aiError: row.ai_error,
          syncStatus: "synced",
        };
      }),
    );
    const remoteIds = new Set(hydrated.map((record) => record.id));
    const localOnly = localRecords().filter(
      (record) =>
        !remoteIds.has(record.id) &&
        (record.syncStatus === "pending" || record.cover?.startsWith("data:image/")),
    );
    window.vinylApp?.replaceRecords?.([...localOnly, ...hydrated]);
  }

  function subscribeToRecords(userId) {
    if (recordsChannel) client.removeChannel(recordsChannel);
    recordsChannel = client
      .channel(`records-sync-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "records",
          filter: `user_id=eq.${userId}`,
        },
        () => {
          clearTimeout(pullTimer);
          pullTimer = setTimeout(async () => {
            if (syncing || pulling || !currentUser || currentUser.id !== userId) return;
            pulling = true;
            try {
              await downloadRecords();
            } catch (error) {
              console.warn("Could not refresh records from Realtime", error);
            } finally {
              pulling = false;
            }
          }, 350);
        },
      )
      .subscribe((status, error) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT")
          console.warn("Realtime record sync is unavailable", error || status);
      });
  }

  async function resetStaleAnalyses(items) {
    const staleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data, error } = await client
      .from("records")
      .update({
        ai_status: "pending",
        ai_error: "解析が長時間完了しなかったため再試行します",
        updated_at: new Date().toISOString(),
      })
      .eq("ai_status", "processing")
      .lt("updated_at", staleBefore)
      .select("id");
    if (error) throw error;
    const staleIds = new Set((data || []).map((row) => row.id));
    for (const record of items) {
      if (staleIds.has(record.id)) {
        record.aiStatus = "pending";
        record.aiError = "解析が長時間完了しなかったため再試行します";
      }
    }
  }

  async function syncAll() {
    if (!configured || !currentUser || !navigator.onLine) return;
    if (syncing) {
      rerun = true;
      return;
    }
    syncing = true;
    updateStatus("syncing", "同期中…");
    try {
      await removePendingRecords();
      const items = localRecords();
      await resetStaleAnalyses(items);
      const { data: remoteRows, error: remoteError } = await client
        .from("records")
        .select("id,cover_path,ai_status");
      if (remoteError) throw remoteError;
      const remoteById = new Map((remoteRows || []).map((row) => [row.id, row]));
      const failedUploads = [];
      const analyses = [];
      for (const record of items) {
        const existingRecord = remoteById.get(record.id) || null;
        if (
          existingRecord &&
          !record.aiRetryRequested &&
          !["pending", "error"].includes(existingRecord.ai_status)
        )
          continue;
        try {
          const shouldAnalyze = Boolean(
            record.aiRetryRequested ||
              (!existingRecord && ["pending", "error"].includes(record.aiStatus || "pending")) ||
              (existingRecord && ["pending", "error"].includes(existingRecord.ai_status)),
          );
          await uploadRecord(record, existingRecord);
          if (shouldAnalyze && record.coverPath)
            analyses.push(requestAnalysis(record));
        } catch (error) {
          console.error(`Could not sync record ${record.id}`, error);
          record.syncStatus = "pending";
          failedUploads.push(record);
        }
      }
      // Upload every photo and persist every record before starting potentially
      // long-running AI requests. iOS may suspend the page as soon as it locks.
      await Promise.all(analyses);
      await downloadRecords();
      if (failedUploads.length) {
        const downloaded = window.vinylApp?.getRecords?.() || [];
        const failedIds = new Set(failedUploads.map((record) => record.id));
        window.vinylApp?.replaceRecords?.([
          ...failedUploads,
          ...downloaded.filter((record) => !failedIds.has(record.id)),
        ]);
        updateStatus("error", "一部を同期できません");
        window.vinylApp?.notify?.(
          `${failedUploads.length}件を同期できませんでした。ネットワーク復帰後に再試行します`,
        );
      } else {
        updateStatus("synced", "同期済み");
      }
    } catch (error) {
      console.error(error);
      updateStatus("error", "同期を再試行");
      const message = error?.message || "原因を特定できませんでした";
      window.vinylApp?.notify?.(
        `同期できませんでした: ${message.slice(0, 180)}。次回同期時に再試行します`,
      );
    } finally {
      syncing = false;
      if (rerun) {
        rerun = false;
        syncAll();
      }
    }
  }

  function showRequiredLogin(force = false) {
    const dialog = $("#syncDialog");
    if (!force && localStorage.getItem(localModeKey) === "true") {
      updateStatus("local", "端末内のみ");
      return;
    }
    setAuthMode("login");
    if (dialog && !dialog.open) dialog.showModal();
    updateStatus("required", "ログインが必要");
  }
  function setAuthMode(mode) {
    authMode = mode;
    const isSignup = mode === "signup",
      isReset = mode === "reset",
      isUpdate = mode === "update",
      isAccount = mode === "account";
    $("#authModeSwitch").hidden = isUpdate || isAccount;
    $("#syncAuthForm").hidden = isAccount;
    $("#accountPanel").hidden = !isAccount;
    $("#continueLocal").hidden = isUpdate || isAccount;
    $("#localOnlyNote").hidden = isUpdate || isAccount;
    $("#authLoginMode").classList.toggle("active", mode === "login");
    $("#authSignupMode").classList.toggle("active", isSignup);
    $("#authLoginMode").setAttribute("aria-selected", String(mode === "login"));
    $("#authSignupMode").setAttribute("aria-selected", String(isSignup));
    $("#syncAuthEmailField").hidden = isUpdate || isAccount;
    $("#syncAuthEmail").required = !isUpdate;
    if (isUpdate) $("#syncAuthEmail").value = currentUser?.email || "";
    $("#syncAuthPasswordField").hidden = isReset || isAccount;
    $("#syncAuthPassword").required = !isReset && !isAccount;
    $("#syncAuthPassword").minLength = isSignup || isUpdate ? 6 : 0;
    $("#syncAuthPassword").autocomplete =
      isSignup || isUpdate ? "new-password" : "current-password";
    $("#syncAuthSubmit").textContent = isSignup
      ? "アカウントを作成"
      : isReset
        ? "再設定メールを送る"
        : isUpdate
          ? "パスワードを更新"
          : "ログイン";
    $("#syncAuthReset").hidden = mode !== "login";
    $("#accountEmail").textContent =
      currentUser?.email || "メールアドレス未設定";
    $("#syncAuthMessage").hidden = isAccount;
    $("#syncAuthMessage").textContent = isSignup
      ? "新しいアカウントを作成します。"
      : isReset
        ? "登録メールアドレスに再設定リンクを送ります。"
        : isUpdate
          ? "新しいパスワードを設定してください。"
          : "メールアドレスとパスワードでログインしてください。";
  }
  function authErrorMessage(error) {
    const message = String(error?.message || "");
    if (/already registered|already exists/i.test(message))
      return "このメールアドレスは登録済みです。ログインするか、パスワードを再設定してください。";
    if (/invalid login credentials/i.test(message))
      return "メールアドレスまたはパスワードが正しくありません。";
    return `認証できませんでした: ${message || "不明なエラー"}`;
  }
  async function submitAuth(event) {
    event.preventDefault();
    const form = event.currentTarget,
      button = $("#syncAuthSubmit"),
      formData = new FormData(form),
      email = String(formData.get("email") || "").trim(),
      password = formData.get("password");
    const redirectTo = `${location.origin}${location.pathname}`;
    button.disabled = true;
    try {
      if (authMode === "reset") {
        const { error } = await client.auth.resetPasswordForEmail(email, {
          redirectTo,
        });
        if (error) throw error;
        $("#syncAuthMessage").textContent =
          "パスワード再設定メールを送信しました。メール内のリンクを開いてください。";
      } else if (authMode === "update") {
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
        $("#syncAuthMessage").textContent =
          "パスワードを更新しました。同期を開始します。";
      } else if (authMode === "signup") {
        const { data, error } = await client.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: redirectTo },
        });
        if (error) throw error;
        if (data.session)
          $("#syncAuthMessage").textContent =
            "アカウントを作成しました。同期を開始します。";
        else if (
          data.user &&
          Array.isArray(data.user.identities) &&
          data.user.identities.length === 0
        )
          $("#syncAuthMessage").textContent =
            "このメールアドレスは既に登録済みです。ログインするか、パスワード再設定をしてください。";
        else
          $("#syncAuthMessage").textContent =
            "登録要求を受け付けました。確認メールが届かない場合は迷惑メールを確認してください。届かない状態が続く場合、SupabaseのSMTP設定または登録済みアカウントをご確認ください。";
      } else {
        const { error } = await client.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        $("#syncAuthMessage").textContent =
          "ログインしました。同期を開始します。";
      }
    } catch (error) {
      $("#syncAuthMessage").textContent = authErrorMessage(error);
    } finally {
      button.disabled = false;
    }
  }

  async function initCloudSync() {
    if (!configured) {
      updateStatus("setup", "同期設定中");
      return;
    }
    client = window.supabase.createClient(config.url, config.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
    client.auth.onAuthStateChange((event, session) => {
      authTransition = authTransition.then(async () => {
        const nextUser = session?.user || null;
        if (event === "PASSWORD_RECOVERY" && nextUser) {
          currentUser = nextUser;
          $("#accountStatus").hidden = false;
          if (!$("#syncDialog")?.open) $("#syncDialog")?.showModal();
          setAuthMode("update");
          return;
        }
        if (nextUser) {
          if (activeUserId === nextUser.id) {
            currentUser = nextUser;
            return;
          }
          const previousUserId = localStorage.getItem(lastCloudUserKey);
          const preserveLocal =
            !previousUserId || localStorage.getItem(localModeKey) === "true";
          await window.vinylApp?.selectCloudCollection?.(
            nextUser.id,
            preserveLocal,
          );
          localStorage.removeItem(localModeKey);
          localStorage.setItem(lastCloudUserKey, nextUser.id);
          activeUserId = nextUser.id;
          currentUser = nextUser;
          subscribeToRecords(nextUser.id);
          $("#accountStatus").hidden = false;
          $("#syncDialog")?.close();
          await syncAll();
          return;
        }
        currentUser = null;
        if (recordsChannel) {
          client.removeChannel(recordsChannel);
          recordsChannel = null;
        }
        clearTimeout(pullTimer);
        if (activeUserId)
          await window.vinylApp?.selectCloudCollection?.(null, false);
        activeUserId = null;
        $("#accountStatus").hidden = true;
        showRequiredLogin();
      }).catch((error) => {
        console.error("Could not switch the active cloud account", error);
        showRequiredLogin();
      });
    });
    const { data } = await client.auth.getSession();
    authTransition = authTransition.then(async () => {
      const session = data.session;
      const nextUser = session?.user || null;
      if (!nextUser) {
        if (!activeUserId) showRequiredLogin();
        return;
      }
      if (activeUserId === nextUser.id) return;
      const previousUserId = localStorage.getItem(lastCloudUserKey);
      const preserveLocal =
        !previousUserId || localStorage.getItem(localModeKey) === "true";
      await window.vinylApp?.selectCloudCollection?.(
        nextUser.id,
        preserveLocal,
      );
      localStorage.removeItem(localModeKey);
      localStorage.setItem(lastCloudUserKey, nextUser.id);
      activeUserId = nextUser.id;
      currentUser = nextUser;
      subscribeToRecords(nextUser.id);
      $("#accountStatus").hidden = false;
      await syncAll();
    }).catch((error) => {
      console.error("Could not initialize the active cloud account", error);
      showRequiredLogin();
    });
    await authTransition;
  }

  window.queueCloudSync = () => {
    if (configured && currentUser) syncAll();
    else if (configured) showRequiredLogin();
  };
  $("#continueLocal")?.addEventListener("click", async () => {
    try {
      localStorage.setItem(localModeKey, "true");
      $("#syncDialog")?.close();
      updateStatus("local", "端末内のみ");
      window.vinylApp?.notify?.("端末内モードで続けます。同期は行われません");
    } catch (error) {
      window.vinylApp?.notify?.(
        `端末内モードに切り替えられませんでした: ${error?.message || "保存エラー"}`,
      );
    }
  });
  window.retryCloudAnalysis = (recordId) => {
    const record = localRecords().find((item) => item.id === recordId);
    if (!record?.coverPath || !currentUser) {
      window.vinylApp?.notify?.("ログインとジャケット写真が必要です");
      return;
    }
    if (
      !window.confirm(
        "画像をGeminiへ送り、Google検索で落札履歴を探したうえで候補の商品詳細ページも読み込み、B面の曲目と市場価格を調査します。1回の調査で複数の検索リクエストが発生し、商品ページの読み取りにもAI使用量がかかります。月5,000回の無料検索枠を超えた場合などに課金対象となる可能性があります。再調査しますか？",
      )
    )
      return;
    record.aiStatus = "pending";
    record.aiError = null;
    record.aiRetryRequested = true;
    window.vinylApp?.replaceRecords?.(window.vinylApp.getRecords());
    document.querySelector("#detailDialog")?.close();
    syncAll();
  };
  window.deleteCloudRecord = (id, coverPath) => {
    setPendingDeletes([...pendingDeletes(), { id, coverPath }]);
    window.queueCloudSync();
  };
  window.initCloudSync = initCloudSync;
  window.addEventListener("online", () => window.queueCloudSync());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") window.queueCloudSync();
  });
  $("#syncDialog")?.addEventListener("cancel", (event) =>
    event.preventDefault(),
  );
  $("#authLoginMode")?.addEventListener("click", () => setAuthMode("login"));
  $("#authSignupMode")?.addEventListener("click", () => setAuthMode("signup"));
  $("#syncAuthReset")?.addEventListener("click", () => setAuthMode("reset"));
  $("#syncAuthForm")?.addEventListener("submit", submitAuth);
  $("#accountStatus")?.addEventListener("click", () => {
    setAuthMode("account");
    $("#syncDialog")?.showModal();
  });
  $("#accountClose")?.addEventListener("click", () =>
    $("#syncDialog")?.close(),
  );
  $("#accountLogout")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      setAuthMode("login");
      const { error } = await client.auth.signOut();
      if (error) throw error;
      $("#syncAuthMessage").textContent =
        "ログアウトしました。別のアカウントでログインするか、新規登録してください。";
      $("#syncAuthPassword").value = "";
      $("#accountStatus").hidden = true;
    } catch (error) {
      setAuthMode("account");
      window.vinylApp?.notify?.(
        `ログアウトできませんでした: ${error?.message || "通信エラー"}`,
      );
    } finally {
      button.disabled = false;
    }
  });
  $("#syncStatus")?.addEventListener("click", () => {
    if (!configured)
      return window.vinylApp?.notify?.("クラウド同期の接続設定中です");
    if (currentUser) syncAll();
    else showRequiredLogin(true);
  });
})();
