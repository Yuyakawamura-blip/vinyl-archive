const KEY = "vinyl-archive-records-v1";
const demo = [
  {
    id: "demo-1",
    artist: "Miles Davis",
    title: "Kind of Blue",
    year: 1959,
    genre: "Jazz",
    condition: "Very Good+",
    marketPrice: 6800,
    purchasePrice: 4200,
    catalogNo: "CBS/Sony 25AP 755",
    notes: "日本盤。帯なし。",
    cover:
      "https://upload.wikimedia.org/wikipedia/en/9/9c/MilesDavisKindofBlue.jpg",
    added: "2026-10-10",
    trend: 8,
  },
  {
    id: "demo-2",
    artist: "YMO",
    title: "Solid State Survivor",
    year: 1979,
    genre: "Electronic",
    condition: "Near Mint",
    marketPrice: 5400,
    purchasePrice: 3500,
    catalogNo: "ALR-6022",
    notes: "イエロー・ヴィニール。",
    cover:
      "https://upload.wikimedia.org/wikipedia/en/8/8b/Solid_State_Survivor.jpg",
    added: "2026-10-09",
    trend: 4,
  },
  {
    id: "demo-3",
    artist: "Stevie Wonder",
    title: "Songs in the Key of Life",
    year: 1976,
    genre: "Soul",
    condition: "Very Good",
    marketPrice: 4200,
    purchasePrice: 2800,
    catalogNo: "T13-340C2",
    notes: "2LP。7インチEP付き。",
    cover:
      "https://upload.wikimedia.org/wikipedia/en/e/e2/Songs_in_the_key_of_life.jpg",
    added: "2026-10-08",
    trend: -2,
  },
  {
    id: "demo-4",
    artist: "The Clash",
    title: "London Calling",
    year: 1979,
    genre: "Rock",
    condition: "Very Good+",
    marketPrice: 7600,
    purchasePrice: 5100,
    catalogNo: "25·3P-139~140",
    notes: "日本盤。",
    cover:
      "https://upload.wikimedia.org/wikipedia/en/0/00/TheClashLondonCallingalbumcover.jpg",
    added: "2026-10-07",
    trend: 11,
  },
];
let records = [];
let filter = "All";
let coverData = "";
let cameraStream = null;
let cameraMode = "manual";
let batchPhotos = [];
let db = null;
let databaseCollectionKey = "records";
let viewMode = localStorage.getItem("vinyl-archive-view") || "grid";
const $ = (s) => document.querySelector(s),
  yen = (n) => "¥" + Number(n || 0).toLocaleString("ja-JP");
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("vinyl-archive-db", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("archive"))
        request.result.createObjectStore("archive", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function readDatabase() {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("archive", "readonly")
      .objectStore("archive")
      .get(databaseCollectionKey);
    request.onsuccess = () => resolve(request.result?.value || null);
    request.onerror = () => reject(request.error);
  });
}
function writeDatabase() {
  if (!db) return;
  const tx = db.transaction("archive", "readwrite");
  tx.objectStore("archive").put({
    id: databaseCollectionKey,
    value: records,
    updatedAt: new Date().toISOString(),
  });
  tx.onerror = () => toast("端末内データベースへの保存に失敗しました");
}
async function initApp() {
  try {
    db = await openDatabase();
    const stored = await readDatabase();
    records = stored || JSON.parse(localStorage.getItem(KEY) || "null") || demo;
    writeDatabase();
    localStorage.removeItem(KEY);
  } catch (error) {
    records = JSON.parse(localStorage.getItem(KEY) || "null") || demo;
    toast("データベースを開けないため一時保存で起動しました");
  }
  render();
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("./sw.js").catch(() => {});
}
function save() {
  writeDatabase();
  render();
  window.queueCloudSync?.();
}
function render() {
  const value = records.reduce((s, r) => s + Number(r.marketPrice || 0), 0),
    paid = records.reduce((s, r) => s + Number(r.purchasePrice || 0), 0),
    genres = new Set(records.map((r) => r.genre));
  $("#stats").innerHTML =
    `<div class="stat"><strong>${records.length}</strong><span>RECORDS</span></div><div class="stat"><strong>${genres.size}</strong><span>GENRES</span></div><div class="stat"><strong>${yen(value)}</strong><span>MARKET VALUE</span></div><div class="stat"><strong>${value - paid >= 0 ? "+" : ""}${yen(value - paid)}</strong><span>VALUE CHANGE</span></div>`;
  const all = ["All", ...genres];
  $("#genreRow").innerHTML = all
    .map(
      (g) =>
        `<button class="chip ${filter === g ? "active" : ""}" data-genre="${g}">${g === "All" ? "すべて" : g}</button>`,
    )
    .join("");
  document.querySelectorAll(".chip").forEach(
    (b) =>
      (b.onclick = () => {
        filter = b.dataset.genre;
        render();
      }),
  );
  const q = $("#searchInput").value.toLowerCase(),
    sort = $("#sortSelect").value;
  let shown = records.filter(
    (r) =>
      (filter === "All" || r.genre === filter) &&
      [r.artist, r.title, r.year, r.genre].join(" ").toLowerCase().includes(q),
  );
  shown.sort((a, b) =>
    sort === "artist"
      ? a.artist.localeCompare(b.artist)
      : sort === "year"
        ? b.year - a.year
        : sort === "price"
          ? b.marketPrice - a.marketPrice
          : String(b.added).localeCompare(a.added),
  );
  $("#recordGrid").innerHTML = shown.map(card).join("");
  $("#recordGrid").classList.toggle("list-view", viewMode === "list");
  $("#gridViewBtn").classList.toggle("active", viewMode === "grid");
  $("#listViewBtn").classList.toggle("active", viewMode === "list");
  $("#emptyState").classList.toggle("hidden", records.length > 0);
  $("#recordGrid").classList.toggle("hidden", records.length === 0);
  document
    .querySelectorAll(".card")
    .forEach((c) => (c.onclick = () => showDetail(c.dataset.id)));
  renderMarket(value, paid);
  renderNews();
}
function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone === true
  );
}
function newsUrl(r) {
  return `https://news.google.com/search?q=${encodeURIComponent([r.artist, r.title].filter(Boolean).join(" "))}&hl=ja&gl=JP&ceid=JP:ja`;
}
function renderNews() {
  const section = $("#newsSection"),
    list = $("#newsList");
  if (!section || !list) return;
  section.classList.toggle("hidden", isStandalone());
  if (isStandalone()) return;
  const seen = new Set(),
    items = records
      .filter((r) => r.artist && !seen.has(r.artist) && seen.add(r.artist))
      .slice(0, 4);
  list.innerHTML = items.length
    ? items
        .map(
          (r, i) =>
            `<a class="news-item" href="${newsUrl(r)}" target="_blank" rel="noopener"><span class="news-no">0${i + 1}</span><div><small>${esc(r.artist)}</small><strong>${esc(r.title)}</strong><p>このアーティスト・作品の最新ニュースを検索</p></div><b>↗</b></a>`,
        )
        .join("")
    : `<div class="news-empty"><strong>ニュース対象のレコードがありません</strong><p>コレクションにレコードを追加すると、関連ニュースへの入口がここに表示されます。</p></div>`;
}
function trackSummary(r) {
  if (!r.aTitle && !r.bTitle) return "";
  return `<div class="mini-tracklist">${r.aTitle ? `<span><b>A</b>${esc(r.aTitle)}</span>` : ""}${r.bTitle ? `<span><b>B</b>${esc(r.bTitle)}</span>` : ""}</div>`;
}
function card(r) {
  const aiLabel =
    r.aiStatus === "processing"
      ? "AI解析中"
      : r.aiStatus === "review"
        ? "AI確認待ち"
        : r.aiStatus === "error"
          ? "AI再試行待ち"
          : r.aiStatus === "pending"
            ? "AI解析待ち"
            : r.aiStatus === "no_resources"
              ? "AIリソースなし"
              : "";
  return `<article class="card" data-id="${r.id}"><div class="cover"><img src="${r.cover || placeholder(r)}" alt="${esc(r.title)}のジャケット"><span class="condition">${r.condition}</span>${aiLabel ? `<span class="ai-status ${r.aiStatus}">${aiLabel}</span>` : ""}</div><div class="card-meta"><p>${esc(r.artist)} · ${r.year || "—"}</p><h3>${esc(r.title)}</h3>${trackSummary(r)}<div class="price-row"><span>${r.genre}</span><b>${yen(r.marketPrice)}</b></div></div></article>`;
}
function placeholder(r) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#1d2e43"/><circle cx="430" cy="170" r="190" fill="#e94f28"/><text x="42" y="465" font-size="54" fill="#f2eee5" font-family="serif">${esc(r.title).slice(0, 16)}</text><text x="45" y="515" font-size="21" fill="#dfba62" font-family="sans-serif">${esc(r.artist)}</text></svg>`)}`;
}
function searchTerms(r) {
  return [r.artist, r.title, r.catalogNo].filter(Boolean).join(" ");
}
function yahooUrl(r) {
  return `https://auctions.yahoo.co.jp/closedsearch/closedsearch/${encodeURIComponent(searchTerms(r))}/0/`;
}
function mercariUrl(r) {
  return `https://jp.mercari.com/search?keyword=${encodeURIComponent(searchTerms(r))}`;
}
function youtubeSearch(r, track) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent([r.artist, track].filter(Boolean).join(" "))}`;
}
function soundcloudSearch(r, track) {
  return `https://soundcloud.com/search/sounds?q=${encodeURIComponent([r.artist, track].filter(Boolean).join(" "))}`;
}
function appleMusicSearch(r, track) {
  return `https://music.apple.com/jp/search?term=${encodeURIComponent([r.artist, track].filter(Boolean).join(" "))}`;
}
function spotifySearch(r, track) {
  return `https://open.spotify.com/search/${encodeURIComponent([r.artist, track].filter(Boolean).join(" "))}`;
}
function safeAudioUrl(url) {
  return /^https?:\/\//i.test(url || "") ? url : "";
}
function trackRow(r, side, title, directUrl) {
  if (!title)
    return `<div class="track-row empty-track"><b>${side}</b><span>曲名未登録</span></div>`;
  const direct = safeAudioUrl(directUrl);
  return `<div class="track-row"><b>${side}</b><span>${esc(title)}</span><div class="listen-links"><a class="listen-apple" href="${appleMusicSearch(r, title)}" target="_blank" rel="noopener"> Music ↗</a><a class="listen-spotify" href="${spotifySearch(r, title)}" target="_blank" rel="noopener">Spotify</a>${direct ? `<a href="${esc(direct)}" target="_blank" rel="noopener">登録音源</a>` : ""}<a href="${youtubeSearch(r, title)}" target="_blank" rel="noopener">YouTube</a><a href="${soundcloudSearch(r, title)}" target="_blank" rel="noopener">SoundCloud</a></div></div>`;
}
function renderMarket(value, paid) {
  const diff = value - paid;
  $("#marketSummary").innerHTML =
    `<div><strong>${yen(value)}</strong><span>コレクション推定総額</span></div><div><strong>${yen(paid)}</strong><span>購入総額</span></div><div><strong style="color:${diff >= 0 ? "#70c7a8" : "#ef8f78"}">${diff >= 0 ? "+" : ""}${yen(diff)}</strong><span>差額</span></div>`;
  $("#marketList").innerHTML = records
    .slice()
    .sort((a, b) => b.marketPrice - a.marketPrice)
    .map(
      (r) =>
        `<div class="market-item"><img src="${r.cover || placeholder(r)}"><div><strong>${esc(r.title)}</strong><br><small>${esc(r.artist)} · ${r.year}</small><div class="market-links"><a href="${yahooUrl(r)}" target="_blank" rel="noopener">ヤフオク落札相場 ↗</a><a href="${mercariUrl(r)}" target="_blank" rel="noopener">メルカリ出品相場 ↗</a></div></div><strong>${yen(r.marketPrice)}</strong><span class="trend ${r.trend >= 0 ? "up" : ""}">${r.trend >= 0 ? "↑" : "↓"} ${Math.abs(r.trend || 0)}%</span><small class="source">参考相場 · 確認 ${r.priceChecked || r.added}</small></div>`,
    )
    .join("");
}
function esc(s = "") {
  return String(s).replace(
    /[&<>"']/g,
    (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[m],
  );
}
function showDetail(id) {
  const r = records.find((x) => x.id === id);
  $("#detailContent").innerHTML =
    `<div class="dialog-head"><p class="eyebrow">7-INCH ARCHIVE DETAIL</p><button class="close" onclick="detailDialog.close()">×</button></div><div class="detail-grid"><img src="${r.cover || placeholder(r)}"><div><p>${r.genre} · ${r.year}</p><h2>${esc(r.title)}</h2><h3>${esc(r.artist)}</h3>${r.aiStatus === "error" ? `<p class="ai-error">AI解析に失敗しました: ${esc(r.aiError || "次回同期時に再試行します")}</p>` : ""}<div class="tracklist"><p class="eyebrow">TRACKS & LISTEN</p>${trackRow(r, "A", r.aTitle, r.aAudioUrl)}${trackRow(r, "B", r.bTitle, r.bAudioUrl)}</div><div class="detail-data"><div><span>MARKET</span><b>${yen(r.marketPrice)}</b></div><div><span>PURCHASE</span><b>${yen(r.purchasePrice)}</b></div><div><span>CONDITION</span><b>${r.condition}</b></div><div><span>CATALOG NO.</span><b>${esc(r.catalogNo || "—")}</b></div></div><div class="price-source"><span>国内相場を確認</span><p>「${esc(searchTerms(r))}」で検索します</p><div class="source-buttons"><a class="source-yahoo" href="${yahooUrl(r)}" target="_blank" rel="noopener">Yahoo!オークション<br><b>落札相場を見る ↗</b></a><a class="source-mercari" href="${mercariUrl(r)}" target="_blank" rel="noopener">メルカリ<br><b>出品相場を見る ↗</b></a></div></div><p>${esc(r.notes || "メモはありません。")}</p><button class="delete-btn" onclick="removeRecord('${r.id}')">このレコードを削除</button></div></div>`;
  $("#detailDialog").showModal();
}
window.removeRecord = (id) => {
  if (confirm("このレコードをコレクションから削除しますか？")) {
    const removed = records.find((r) => r.id === id);
    records = records.filter((r) => r.id !== id);
    writeDatabase();
    render();
    window.deleteCloudRecord?.(id, removed?.coverPath);
    $("#detailDialog").close();
    toast("削除しました。ほかの端末にも自動反映します");
  }
};
function toast(t) {
  $("#toast").textContent = t;
  $("#toast").classList.add("show");
  setTimeout(() => $("#toast").classList.remove("show"), 2200);
}
const addDialog = $("#addDialog");
let captureFeedbackTimer = null;
function stopCamera() {
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  $("#cameraVideo").srcObject = null;
  $("#cameraPanel").classList.remove("active", "just-captured");
  $("#recordForm").classList.remove("batch-camera-active");
  $("#closeCamera").textContent = "キャンセル";
  $("#captureStatus").classList.remove("active", "count-pop");
  $("#shotConfirmation").classList.remove("active");
  $("#lastShot").classList.remove("active");
}
function captureMessage(message, isError = false) {
  const box = $("#captureMessage");
  box.textContent = message;
  box.classList.toggle("error", isError);
}
function openNativeCamera() {
  captureMessage(
    "iPhoneの標準カメラを開きます。撮影後、この画面に戻って続けて撮影できます。",
  );
  $("#nativeCameraInput").click();
}
async function startCamera(mode = "manual") {
  cameraMode = mode;
  captureMessage("カメラを起動しています…");
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    captureMessage(
      "アプリ内カメラを利用できないため、iPhoneの標準カメラに切り替えました。",
      true,
    );
    openNativeCamera();
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1920 },
      },
      audio: false,
    });
    $("#cameraVideo").srcObject = cameraStream;
    await $("#cameraVideo").play();
    $("#cameraPanel").classList.add("active");
    $("#uploadZone").classList.add("hidden");
    captureMessage("");
    if (mode === "batch") {
      $("#recordForm").classList.add("batch-camera-active");
      $("#closeCamera").textContent = "撮影完了";
      $("#captureStatus").textContent = `${batchPhotos.length}枚撮影`;
      $("#captureStatus").classList.add("active");
    }
  } catch (error) {
    const denied =
      error.name === "NotAllowedError" || error.name === "SecurityError";
    captureMessage(
      denied
        ? "カメラの許可がありません。iPhoneの設定でChromeのカメラを許可してください。標準カメラに切り替えます。"
        : "アプリ内カメラを起動できません。標準カメラに切り替えます。",
      true,
    );
    openNativeCamera();
  }
}
function cameraImage() {
  const video = $("#cameraVideo"),
    canvas = $("#cameraCanvas"),
    max = 1400,
    ratio = Math.min(1, max / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * ratio);
  canvas.height = Math.round(video.videoHeight * ratio);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.86);
}
function showCaptureFeedback(image) {
  const panel = $("#cameraPanel"),
    flash = $("#cameraFlash"),
    status = $("#captureStatus"),
    confirmation = $("#shotConfirmation"),
    lastShot = $("#lastShot"),
    shutter = $("#takePhoto");
  clearTimeout(captureFeedbackTimer);
  panel.classList.remove("just-captured");
  flash.classList.remove("active");
  status.classList.remove("count-pop");
  confirmation.classList.remove("active");
  shutter.classList.remove("pressed");
  void panel.offsetWidth;
  panel.classList.add("just-captured");
  flash.classList.add("active");
  status.classList.add("count-pop");
  confirmation.classList.add("active");
  shutter.classList.add("pressed");
  lastShot.querySelector("img").src = image;
  lastShot.classList.add("active");
  navigator.vibrate?.([25, 20, 35]);
  captureFeedbackTimer = setTimeout(() => {
    panel.classList.remove("just-captured");
    flash.classList.remove("active");
    status.classList.remove("count-pop");
    confirmation.classList.remove("active");
    shutter.classList.remove("pressed");
  }, 620);
}
function capturePhoto() {
  const image = cameraImage();
  if (cameraMode === "batch") {
    batchPhotos.push(image);
    $("#captureStatus").textContent = `${batchPhotos.length}枚撮影`;
    showCaptureFeedback(image);
    return;
  }
  coverData = image;
  showCaptureFeedback(image);
  setTimeout(() => {
    $("#coverPreview").src = coverData;
    $("#uploadZone").classList.remove("hidden");
    $("#uploadZone").classList.add("has-image");
    stopCamera();
    toast("写真をアプリ内に取り込みました");
  }, 420);
}
function renderCaptureQueue() {
  $("#queueCount").textContent = `${batchPhotos.length}枚`;
  $("#saveBatch").disabled = !batchPhotos.length;
  $("#captureQueue").innerHTML = batchPhotos.length
    ? batchPhotos
        .map(
          (src, i) =>
            `<div class="queue-photo"><img src="${src}" alt="撮影したレコード ${i + 1}"><button type="button" data-remove-photo="${i}" aria-label="${i + 1}枚目を削除">×</button><span>${i + 1}</span></div>`,
        )
        .join("")
    : "<p>まだ写真はありません</p>";
  document.querySelectorAll("[data-remove-photo]").forEach(
    (button) =>
      (button.onclick = () => {
        batchPhotos.splice(Number(button.dataset.removePhoto), 1);
        renderCaptureQueue();
      }),
  );
}
function addBatchFiles(files) {
  [...files].forEach((file) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      batchPhotos.push(reader.result);
      renderCaptureQueue();
    };
    reader.readAsDataURL(file);
  });
}
function saveBatch() {
  if (!batchPhotos.length) return;
  const today = new Date().toISOString().slice(0, 10),
    created = batchPhotos.map((cover, i) => ({
      id: crypto.randomUUID(),
      artist: "AI解析待ち",
      title: `未解析レコード ${records.filter((r) => r.aiStatus === "pending").length + i + 1}`,
      year: 0,
      genre: "Other",
      condition: "Very Good+",
      marketPrice: 0,
      purchasePrice: 0,
      catalogNo: "",
      notes: "ジャケット画像を登録済み。自動解析を開始します。",
      cover,
      added: today,
      priceChecked: today,
      trend: 0,
      aiStatus: "pending",
      syncStatus: "pending",
    }));
  records.unshift(...created);
  batchPhotos = [];
  renderCaptureQueue();
  save();
  stopCamera();
  addDialog.close();
  toast(`${created.length}枚を保存しました。自動同期を開始します`);
}
$("#openAdd").onclick = $("#emptyAdd").onclick = () => {
  renderCaptureQueue();
  captureMessage("");
  addDialog.showModal();
};
$("#closeDialog").onclick = $("#cancelDialog").onclick = () => {
  stopCamera();
  addDialog.close();
};
$("#startBatchCamera").onclick = () => startCamera("batch");
$("#batchPhotoInput").onchange = (e) => {
  addBatchFiles(e.target.files);
  captureMessage(`${e.target.files.length}枚を読み込んでいます…`);
  e.target.value = "";
};
$("#nativeCameraInput").onchange = (e) => {
  if (e.target.files[0]) {
    addBatchFiles(e.target.files);
    captureMessage(
      "写真を追加しました。続けて撮影する場合は「連続撮影を開始」をもう一度タップしてください。",
    );
  }
  e.target.value = "";
};
$("#saveBatch").onclick = saveBatch;
$("#openCamera").onclick = (e) => {
  e.stopPropagation();
  startCamera("manual");
};
$("#choosePhoto").onclick = (e) => {
  e.stopPropagation();
  $("#coverInput").click();
};
$("#closeCamera").onclick = () => {
  const wasBatch = cameraMode === "batch";
  stopCamera();
  $("#uploadZone").classList.remove("hidden");
  if (wasBatch) {
    renderCaptureQueue();
    toast(
      `${batchPhotos.length}枚を撮影しました。まとめてアップロードできます`,
    );
  }
};
$("#takePhoto").onclick = capturePhoto;
$("#coverInput").onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    coverData = reader.result;
    $("#coverPreview").src = coverData;
    $("#uploadZone").classList.add("has-image");
  };
  reader.readAsDataURL(f);
};
$("#recordForm").onsubmit = (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target)),
    today = new Date().toISOString().slice(0, 10);
  records.unshift({
    ...d,
    id: crypto.randomUUID(),
    year: Number(d.year),
    marketPrice: Number(d.marketPrice),
    purchasePrice: Number(d.purchasePrice),
    cover: coverData,
    added: today,
    priceChecked: today,
    trend: 0,
  });
  save();
  e.target.reset();
  coverData = "";
  $("#uploadZone").classList.remove("has-image");
  addDialog.close();
  toast("コレクションに追加しました");
};
function setViewMode(mode) {
  viewMode = mode;
  localStorage.setItem("vinyl-archive-view", mode);
  render();
}
$("#gridViewBtn").onclick = () => setViewMode("grid");
$("#listViewBtn").onclick = () => setViewMode("list");
$("#searchInput").oninput = render;
$("#sortSelect").onchange = render;
document.querySelectorAll(".nav-link").forEach(
  (b) =>
    (b.onclick = () => {
      document
        .querySelectorAll(".nav-link")
        .forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      $("#collectionView").classList.toggle(
        "hidden",
        b.dataset.view !== "collection",
      );
      $("#marketView").classList.toggle("hidden", b.dataset.view !== "market");
    }),
);
$("#exportBtn").onclick = () => {
  const blob = new Blob([JSON.stringify(records, null, 2)], {
      type: "application/json",
    }),
    a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "vinyl-archive-backup.json";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("バックアップを書き出しました");
};
window.vinylApp = {
  getRecords: () => records,
  selectCloudCollection: async (userId, preserveCurrent = false) => {
    const nextKey = userId ? `records:user:${userId}` : "records:guest";
    if (nextKey === databaseCollectionKey) return;
    if (preserveCurrent && databaseCollectionKey === "records") {
      const tx = db.transaction("archive", "readwrite");
      tx.objectStore("archive").put({
        id: nextKey,
        value: records,
        updatedAt: new Date().toISOString(),
      });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }
    databaseCollectionKey = nextKey;
    records = (await readDatabase()) || [];
    render();
  },
  replaceRecords: (next) => {
    records = next;
    writeDatabase();
    render();
  },
  notify: toast,
};
initApp().then(() => window.initCloudSync?.());
