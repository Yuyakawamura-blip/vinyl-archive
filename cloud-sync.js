import config from "./cloud-config.js";

const configured = Boolean(
  config.url && config.publishableKey && window.supabase?.createClient,
);
// Set by initCloudSync: the app's records, local photos, collection switch and toasts.
let app = null;
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
const syncHintDismissedKey = "vinyl-archive-sync-hint-dismissed";
const $ = (selector) => document.querySelector(selector);

function updateStatus(state, label) {
  const button = $("#syncStatus");
  if (!button) return;
  button.className = `sync-status ${state}`;
  button.querySelector("span").textContent = label;
  button.title = label;
}
function localRecords() {
  return app?.getRecords() || [];
}
// Photo taken on this device that has not reached the cloud yet.
function localCover(record) {
  return app?.getLocalCover(record.id) || null;
}
async function uploadCover(record, blob) {
  const extension =
      {
        "image/png": "png",
        "image/webp": "webp",
        "image/heic": "heic",
        "image/heif": "heif",
      }[blob.type] || "jpg",
    coverPath = `${currentUser.id}/${record.id}.${extension}`;
  const { error } = await client.storage
    .from("record-covers")
    .upload(coverPath, blob, {
      contentType: blob.type || "image/jpeg",
      upsert: true,
    });
  if (error) throw error;
  return coverPath;
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
// Must match COVER_CACHE in sw.js.
const coverCacheName = "vinyl-archive-covers";
function forgetCachedCovers(paths) {
  if (!window.caches || !paths.length) return;
  caches
    .open(coverCacheName)
    .then((cache) =>
      Promise.all(
        paths.map((path) =>
          cache.delete(`${config.url}/storage/v1/object/sign/record-covers/${path}`),
        ),
      ),
    )
    .catch(() => {});
}
// Deleted records wait this long before leaving the cloud, so the delete can be undone.
export const deleteUndoMs = 8000;
// Each entry is { id, coverPath, at }; the oldest app versions stored bare ids.
function pendingDeletes() {
  try {
    return JSON.parse(localStorage.getItem(pendingDeleteKey) || "[]").map((item) =>
      typeof item === "string" ? { id: item, coverPath: null } : item,
    );
  } catch {
    return [];
  }
}
function setPendingDeletes(items) {
  localStorage.setItem(pendingDeleteKey, JSON.stringify(items));
}

async function uploadRecord(record, existingRecord = null) {
  let coverPath = existingRecord?.cover_path || record.coverPath || null;
  const blob = localCover(record);
  if (!existingRecord && blob) coverPath = await uploadCover(record, blob);
  if (!existingRecord) {
    const now = new Date().toISOString();
    const { error } = await client.from("records").upsert(
      {
        id: record.id,
        user_id: currentUser.id,
        data: cleanRecord(record),
        cover_path: coverPath,
        // Records without a photo have nothing for the AI to read.
        ai_status: record.aiStatus || (coverPath ? "pending" : "complete"),
        updated_at: now,
      },
      { onConflict: "id" },
    );
    if (error) throw error;
  } else if (!coverPath && blob) {
    coverPath = await uploadCover(record, blob);
    const { error } = await client
      .from("records")
      .update({ cover_path: coverPath, updated_at: new Date().toISOString() })
      .eq("id", record.id);
    if (error) throw error;
  }
  if (existingRecord && record.syncStatus === "pending") {
    const { error } = await client
      .from("records")
      .update({
        data: cleanRecord(record),
        ai_status: record.aiStatus || existingRecord.ai_status,
        ai_error: record.aiError || null,
        updated_at: record.updatedAt || new Date().toISOString(),
      })
      .eq("id", record.id);
    if (error) throw error;
  }
  if (existingRecord && record.aiRetryRequested) {
    // Back to pending gives the server queue a fresh set of attempts.
    const { error } = await client
      .from("records")
      .update({ ai_status: "pending", ai_error: null, updated_at: new Date().toISOString() })
      .eq("id", record.id);
    if (error) throw error;
  }
  record.coverPath = coverPath;
  record.syncStatus = "synced";
  record.aiRetryRequested = false;
}

// The server analyzes pending records on its own (pg_cron, every minute);
// this only asks it to start right away, so a failure here is not an error.
async function startAnalysis(record) {
  const { error } = await client.functions.invoke("analyze-record", {
    body: { recordId: record.id },
  });
  if (error)
    console.warn("Could not start AI analysis now; the server will pick it up", error);
}

async function removePendingRecords() {
  const pending = pendingDeletes().filter(
    (item) => !item.at || Date.now() - item.at >= deleteUndoMs,
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
  forgetCachedCovers(paths);
  const removed = new Set(pending.map((item) => item.id));
  setPendingDeletes(pendingDeletes().filter((item) => !removed.has(item.id)));
}

async function downloadRecords() {
  const { data, error } = await client
    .from("records")
    .select("id,data,cover_path,ai_status,ai_error,updated_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const existingById = new Map(localRecords().map((record) => [record.id, record]));
  // A record deleted on this device stays hidden until its cloud delete runs.
  const deleting = new Set(pendingDeletes().map((item) => item.id));
  const hydrated = await Promise.all(
    (data || []).filter((row) => !deleting.has(row.id)).map(async (row) => {
      let cover = "";
      let coverUrlExpiresAt = 0;
      if (row.cover_path) {
        const cached = existingById.get(row.id);
        if (
          cached?.coverPath === row.cover_path &&
          cached.cover?.startsWith("https:") &&
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
  // Keep local edits made while this download was in flight; the queued
  // sync rerun pushes them.
  const merged = hydrated.map((record) => {
    const local = existingById.get(record.id);
    return local?.syncStatus === "pending" ? local : record;
  });
  const remoteIds = new Set(hydrated.map((record) => record.id));
  const localOnly = localRecords().filter(
    (record) =>
      !remoteIds.has(record.id) &&
      (record.syncStatus === "pending" || localCover(record)),
  );
  app.replaceRecords([...localOnly, ...merged]);
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
    const { data: remoteRows, error: remoteError } = await client
      .from("records")
      .select("id,cover_path,ai_status");
    if (remoteError) throw remoteError;
    const remoteById = new Map((remoteRows || []).map((row) => [row.id, row]));
    const failedUploads = [];
    const analyses = [];
    for (const record of items) {
      const existingRecord = remoteById.get(record.id) || null;
      const edited = Boolean(existingRecord) && record.syncStatus === "pending";
      const missingCover = Boolean(existingRecord && !existingRecord.cover_path && localCover(record));
      if (existingRecord && !edited && !record.aiRetryRequested && !missingCover) continue;
      try {
        // A manual edit must not trigger an AI pass that would overwrite it.
        const shouldAnalyze =
          record.aiRetryRequested || (!edited && (!existingRecord || missingCover));
        await uploadRecord(record, existingRecord);
        if (shouldAnalyze && record.coverPath) analyses.push(startAnalysis(record));
      } catch (error) {
        console.error(`Could not sync record ${record.id}`, error);
        record.syncStatus = "pending";
        failedUploads.push(record);
      }
    }
    // Upload every photo and persist every record before asking the server to
    // start; iOS may suspend the page as soon as it locks.
    await Promise.all(analyses);
    await downloadRecords();
    if (failedUploads.length) {
      const downloaded = app.getRecords();
      const failedIds = new Set(failedUploads.map((record) => record.id));
      app.replaceRecords([
        ...failedUploads,
        ...downloaded.filter((record) => !failedIds.has(record.id)),
      ]);
      updateStatus("error", "一部を同期できません");
      app.notify(
        `${failedUploads.length}件を同期できませんでした。ネットワーク復帰後に再試行します`,
      );
    } else {
      updateStatus("synced", "同期済み");
    }
  } catch (error) {
    console.error(error);
    updateStatus("error", "同期を再試行");
    const message = error?.message || "原因を特定できませんでした";
    app.notify(
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

// Signed out, the app keeps working on this device only; login is offered,
// never forced. The local-mode flag keeps the existing rule for carrying this
// device's records into the account on the next login.
function enterLocalMode() {
  localStorage.setItem(localModeKey, "true");
  updateStatus("local", "ログインして同期");
  updateSyncHint();
}
function openLogin() {
  const dialog = $("#syncDialog");
  setAuthMode("login");
  if (dialog && !dialog.open) dialog.showModal();
}
// Suggest syncing once the device holds records, until the user dismisses it.
function updateSyncHint() {
  const hint = $("#syncHint");
  if (!hint) return;
  hint.hidden =
    !configured ||
    Boolean(currentUser) ||
    localStorage.getItem(syncHintDismissedKey) === "true" ||
    !localRecords().length;
}
function setAuthMode(mode) {
  authMode = mode;
  const isReset = mode === "reset",
    isUpdate = mode === "update",
    isAccount = mode === "account";
  $("#syncAuthForm").hidden = isAccount;
  $("#accountPanel").hidden = !isAccount;
  $("#continueLocal").hidden = isUpdate || isAccount;
  $("#localOnlyNote").hidden = isUpdate || isAccount;
  $("#syncAuthEmailField").hidden = isUpdate || isAccount;
  $("#syncAuthEmail").required = !isUpdate;
  if (isUpdate) $("#syncAuthEmail").value = currentUser?.email || "";
  $("#syncAuthPasswordField").hidden = isReset || isAccount;
  $("#syncAuthPassword").required = !isReset && !isAccount;
  $("#syncAuthPassword").minLength = isUpdate ? 6 : 0;
  $("#syncAuthPassword").autocomplete = isUpdate ? "new-password" : "current-password";
  $("#syncAuthSubmit").textContent = isReset
    ? "再設定メールを送る"
    : isUpdate
      ? "パスワードを更新"
      : "ログイン";
  $("#syncAuthReset").hidden = mode !== "login" && !isReset;
  $("#syncAuthReset").textContent = isReset ? "ログインに戻る" : "パスワードを忘れた場合";
  $("#accountEmail").textContent =
    currentUser?.email || "メールアドレス未設定";
  $("#syncAuthMessage").hidden = isAccount;
  $("#syncAuthMessage").textContent = isReset
    ? "登録メールアドレスに再設定リンクを送ります。"
    : isUpdate
      ? "新しいパスワードを設定してください。"
      : "メールアドレスとパスワードでログインしてください。";
}
function authErrorMessage(error) {
  const message = String(error?.message || "");
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

export async function initCloudSync(appApi) {
  app = appApi;
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
        await app.selectCloudCollection(
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
        updateSyncHint();
        await syncAll();
        return;
      }
      currentUser = null;
      if (recordsChannel) {
        client.removeChannel(recordsChannel);
        recordsChannel = null;
      }
      clearTimeout(pullTimer);
      if (activeUserId) {
        // Don't leave the previous account's photos on a shared device.
        await window.caches?.delete(coverCacheName).catch(() => {});
        await app.selectCloudCollection(null, false);
      }
      activeUserId = null;
      $("#accountStatus").hidden = true;
      enterLocalMode();
    }).catch((error) => {
      console.error("Could not switch the active cloud account", error);
      enterLocalMode();
    });
  });
  const { data } = await client.auth.getSession();
  authTransition = authTransition.then(async () => {
    const session = data.session;
    const nextUser = session?.user || null;
    if (!nextUser) {
      if (!activeUserId) enterLocalMode();
      return;
    }
    if (activeUserId === nextUser.id) return;
    const previousUserId = localStorage.getItem(lastCloudUserKey);
    const preserveLocal =
      !previousUserId || localStorage.getItem(localModeKey) === "true";
    await app.selectCloudCollection(
      nextUser.id,
      preserveLocal,
    );
    localStorage.removeItem(localModeKey);
    localStorage.setItem(lastCloudUserKey, nextUser.id);
    activeUserId = nextUser.id;
    currentUser = nextUser;
    subscribeToRecords(nextUser.id);
    $("#accountStatus").hidden = false;
    updateSyncHint();
    await syncAll();
  }).catch((error) => {
    console.error("Could not initialize the active cloud account", error);
    enterLocalMode();
  });
  await authTransition;
}

export function queueCloudSync() {
  if (configured && currentUser) syncAll();
  else updateSyncHint();
}
$("#continueLocal")?.addEventListener("click", () => $("#syncDialog")?.close());
$("#syncClose")?.addEventListener("click", () => $("#syncDialog")?.close());
$("#syncHintLogin")?.addEventListener("click", openLogin);
$("#syncHintClose")?.addEventListener("click", () => {
  localStorage.setItem(syncHintDismissedKey, "true");
  updateSyncHint();
});
export function retryCloudAnalysis(recordId) {
  const record = localRecords().find((item) => item.id === recordId);
  if (!record?.coverPath || !currentUser) {
    app.notify("ログインとジャケット写真が必要です");
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
  app.replaceRecords(app.getRecords());
  document.querySelector("#detailDialog")?.close();
  syncAll();
}
export function deleteCloudRecord(id, coverPath) {
  setPendingDeletes([...pendingDeletes(), { id, coverPath, at: Date.now() }]);
  setTimeout(queueCloudSync, deleteUndoMs + 100);
}
export function cancelCloudDelete(id) {
  setPendingDeletes(pendingDeletes().filter((item) => item.id !== id));
}
window.addEventListener("online", queueCloudSync);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") queueCloudSync();
});
// New sign-ups are disabled in Supabase Auth; this app has a single owner account.
$("#syncAuthReset")?.addEventListener("click", () =>
  setAuthMode(authMode === "reset" ? "login" : "reset"),
);
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
      "ログアウトしました。";
    $("#syncAuthPassword").value = "";
    $("#accountStatus").hidden = true;
  } catch (error) {
    setAuthMode("account");
    app.notify(
      `ログアウトできませんでした: ${error?.message || "通信エラー"}`,
    );
  } finally {
    button.disabled = false;
  }
});
$("#syncStatus")?.addEventListener("click", () => {
  if (!configured)
    return app?.notify("クラウド同期の接続設定中です");
  if (currentUser) syncAll();
  else openLogin();
});
