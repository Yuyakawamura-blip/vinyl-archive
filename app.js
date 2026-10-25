import { initCloudSync, queueCloudSync, deleteCloudRecord, retryCloudAnalysis } from "./cloud-sync.js";

const KEY = "vinyl-archive-records-v1";
// Earlier versions seeded four sample records with these ids; drop them on load.
const withoutSamples = (list) =>
  (list || []).filter((record) => !String(record.id).startsWith("demo-"));
// Older versions stored these placeholders as names until the AI filled them in.
const placeholderArtists = ["AI解析待ち", "AIリソースなし"];
const withoutPlaceholderNames = (list) =>
  list.map((record) =>
    placeholderArtists.includes(record.artist) || /^未解析レコード \d+$/.test(record.title || "")
      ? {
          ...record,
          artist: placeholderArtists.includes(record.artist) ? "" : record.artist,
          title: /^未解析レコード \d+$/.test(record.title || "") ? "" : record.title,
        }
      : record,
  );
// Records added from a photo have no names until the AI reads them; show a label instead.
const awaitingAi = (r) => ["pending", "processing"].includes(r.aiStatus);
const displayArtist = (r) => r.artist || (awaitingAi(r) ? "解析待ち" : "アーティスト不明");
const displayTitle = (r) => r.title || (awaitingAi(r) ? "解析待ち" : "タイトル不明");
let records = [];
let filter = "All";
let sortDirection = "desc";
let artistFilter = "All";
let coverData = "";
let cameraStream = null;
let cameraMode = "manual";
let batchPhotos = [];
let db = null;
let databaseCollectionKey = "records";
let viewMode = localStorage.getItem("vinyl-archive-view") || "grid";
const $ = (s) => document.querySelector(s),
  yen = (n) => "¥" + Number(n || 0).toLocaleString("ja-JP");
// Dates and numbers start with the newest or highest; names start from A.
const defaultDirection = (sort) => (["added", "year", "price"].includes(sort) ? "desc" : "asc");
const isEstimatedPrice = (record) => record.marketPriceBasis === "estimate";
const priceBasisLabels = { evidence: "相場", estimate: "AI概算", manual: "手入力" };
const marketPriceLabel = (record) =>
  Number(record.marketPrice) > 0
    ? `${isEstimatedPrice(record) ? "≈" : ""}${yen(record.marketPrice)}`
    : "未調査";
const marketPriceHtml = (record) =>
  isEstimatedPrice(record) && Number(record.marketPrice) > 0
    ? `<b class="price-estimate" title="AIによる概算">${marketPriceLabel(record)}</b>`
    : `<b>${marketPriceLabel(record)}</b>`;
const formatArchiveDate = (value) => {
  if (!value) return "日付不明";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? new Date(`${value}T00:00:00`)
    : new Date(value);
  return Number.isNaN(date.getTime())
    ? "日付不明"
    : date.toLocaleDateString("ja-JP", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "Asia/Tokyo",
      });
};
const tokyoToday = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
// IndexedDB layout (v2): one row per record in "records" and one Blob per
// unsynced photo in "covers", both keyed by "<collection>/<id>". Only rows that
// changed are written. v1 stored each collection as a single array with photos
// inlined as data URLs; it is migrated on upgrade and left in "archive" as a backup.
const rowKey = (collection, id) => `${collection}/${id}`;
const localCovers = new Map(); // record id -> { blob, url } for photos not yet in the cloud
const persistedRecords = new Map(); // record id -> { json, seq } as last written
const persistedCovers = new Set(); // record ids whose photo Blob is stored
function dataUrlToBlob(dataUrl) {
  const [meta, data] = dataUrl.split(","),
    mime = meta.match(/data:(.*?);/)?.[1] || "image/jpeg",
    bytes = atob(data),
    array = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) array[i] = bytes.charCodeAt(i);
  return new Blob([array], { type: mime });
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
// Photos are stored as Blobs, so a record keeps only a displayable URL in memory.
function storedRecord(record) {
  const copy = { ...record };
  if (!/^https:/.test(copy.cover || "")) delete copy.cover;
  return copy;
}
function adoptDataUrlCovers() {
  for (const record of records) {
    if (!record.cover?.startsWith("data:image/")) continue;
    const blob = dataUrlToBlob(record.cover),
      url = URL.createObjectURL(blob);
    localCovers.set(record.id, { blob, url });
    record.cover = url;
  }
}
const requestResult = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
function migrateArchive(tx) {
  const recordStore = tx.objectStore("records"),
    coverStore = tx.objectStore("covers"),
    seqBase = Date.now() * 1000;
  tx.objectStore("archive").getAll().onsuccess = (event) => {
    for (const { id: collection, value } of event.target.result) {
      (value || []).forEach((record, index) => {
        const key = rowKey(collection, record.id);
        if (record.cover?.startsWith("data:image/"))
          coverStore.put({ key, collection, blob: dataUrlToBlob(record.cover) });
        recordStore.put({ key, collection, seq: seqBase - index, record: storedRecord(record) });
      });
    }
  };
}
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("vinyl-archive-db", 2);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      if (event.oldVersion < 2) {
        database.createObjectStore("records", { keyPath: "key" }).createIndex("collection", "collection");
        database.createObjectStore("covers", { keyPath: "key" }).createIndex("collection", "collection");
      }
      if (event.oldVersion === 1) migrateArchive(request.transaction);
    };
    request.onblocked = () => toast("ほかのタブで開いているVINYL ARCHIVEを閉じてください");
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}
async function loadCollection() {
  const tx = db.transaction(["records", "covers"]),
    [rows, coverRows] = await Promise.all([
      requestResult(tx.objectStore("records").index("collection").getAll(databaseCollectionKey)),
      requestResult(tx.objectStore("covers").index("collection").getAll(databaseCollectionKey)),
    ]);
  localCovers.forEach(({ url }) => URL.revokeObjectURL(url));
  localCovers.clear();
  persistedRecords.clear();
  persistedCovers.clear();
  for (const { key, blob } of coverRows) {
    const id = key.slice(databaseCollectionKey.length + 1);
    localCovers.set(id, { blob, url: URL.createObjectURL(blob) });
    persistedCovers.add(id);
  }
  rows.sort((a, b) => b.seq - a.seq);
  for (const { record, seq } of rows)
    persistedRecords.set(record.id, { json: JSON.stringify(record), seq });
  records = rows.map(({ record }) => ({
    ...record,
    cover: localCovers.get(record.id)?.url || record.cover || "",
  }));
}
function writeDatabase() {
  adoptDataUrlCovers();
  // A local photo is kept only while the record still shows it; once the
  // record carries the cloud URL the Blob is released.
  for (const [id, { url }] of localCovers) {
    if (records.find((record) => record.id === id)?.cover === url) continue;
    URL.revokeObjectURL(url);
    localCovers.delete(id);
  }
  if (!db) return Promise.resolve();
  const collection = databaseCollectionKey,
    tx = db.transaction(["records", "covers"], "readwrite"),
    recordStore = tx.objectStore("records"),
    coverStore = tx.objectStore("covers"),
    seqBase = Date.now() * 1000,
    current = new Set();
  records.forEach((record, index) => {
    const key = rowKey(collection, record.id),
      stored = storedRecord(record),
      json = JSON.stringify(stored),
      previous = persistedRecords.get(record.id);
    current.add(record.id);
    if (previous?.json !== json) {
      const seq = previous?.seq ?? seqBase - index;
      recordStore.put({ key, collection, seq, record: stored });
      persistedRecords.set(record.id, { json, seq });
    }
    const local = localCovers.get(record.id);
    if (local && !persistedCovers.has(record.id)) {
      coverStore.put({ key, collection, blob: local.blob });
      persistedCovers.add(record.id);
    } else if (!local && persistedCovers.has(record.id)) {
      coverStore.delete(key);
      persistedCovers.delete(record.id);
    }
  });
  for (const id of persistedRecords.keys()) {
    if (current.has(id)) continue;
    recordStore.delete(rowKey(collection, id));
    coverStore.delete(rowKey(collection, id));
    persistedRecords.delete(id);
    persistedCovers.delete(id);
  }
  return new Promise((resolve) => {
    tx.oncomplete = resolve;
    tx.onerror = () => {
      toast("端末内データベースへの保存に失敗しました");
      resolve();
    };
  });
}
async function initApp() {
  try {
    db = await openDatabase();
    await loadCollection();
    // Records from before IndexedDB lived in localStorage.
    if (!records.length) records = JSON.parse(localStorage.getItem(KEY) || "null") || [];
    records = withoutPlaceholderNames(withoutSamples(records));
    writeDatabase();
    localStorage.removeItem(KEY);
  } catch (error) {
    console.error(error);
    records = withoutPlaceholderNames(withoutSamples(JSON.parse(localStorage.getItem(KEY) || "null")));
    adoptDataUrlCovers();
    toast("データベースを開けないため一時保存で起動しました");
  }
  // Restore filters from the URL before the first render writes them back.
  applyRoute();
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("./sw.js").catch(() => {});
}
function save() {
  writeDatabase();
  render();
  queueCloudSync();
}
// render() rebuilds the genre chips, cards and table; these attributes find the
// rebuilt copy of whatever had keyboard focus.
const focusKeys = ["data-genre", "data-id", "data-sort"];
function focusedRenderKey() {
  const element = document.activeElement;
  if (!element?.closest("#genreRow, #recordGrid")) return null;
  const name = focusKeys.find((key) => element.hasAttribute(key));
  return name ? `[${name}="${CSS.escape(element.getAttribute(name))}"]` : null;
}
function render() {
  const refocus = focusedRenderKey();
  const pricedRecords = records.filter((r) => Number(r.marketPrice) > 0),
    value = pricedRecords.reduce((s, r) => s + Number(r.marketPrice), 0),
    estimatedValue = pricedRecords
      .filter(isEstimatedPrice)
      .reduce((s, r) => s + Number(r.marketPrice), 0),
    genres = new Set(records.map((r) => r.genre));
  $("#stats").innerHTML =
    `<div class="stat"><strong>${records.length}</strong><span>RECORDS</span></div><div class="stat"><strong>${genres.size}</strong><span>GENRES</span></div><div class="stat"><strong>${yen(value)}</strong><span>MARKET VALUE · ${pricedRecords.length}/${records.length}件調査済み${estimatedValue ? ` · うちAI概算 ${yen(estimatedValue)}` : ""}</span></div>`;
  // Keep a filter from the URL selectable even before matching records have synced.
  const withSelected = (values, selected) =>
    selected === "All" || values.includes(selected) ? values : [selected, ...values];
  const all = ["All", ...withSelected([...genres], filter)];
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
  const artistSelect = $("#artistFilter"),
    artists = withSelected([...new Set(records.map((r) => r.artist).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")), artistFilter);
  artistSelect.innerHTML = `<option value="All">すべて</option>${artists.map((artist) => `<option value="${esc(artist)}">${esc(artist)}</option>`).join("")}`;
  artistSelect.value = artistFilter;
  const listMode = viewMode === "list";
  $("#sortDirection").textContent = sortDirection === "desc" ? "降順 ↓" : "昇順 ↑";
  const shown = records.filter(
    (r) =>
      (filter === "All" || r.genre === filter) &&
      (artistFilter === "All" || r.artist === artistFilter) &&
      [r.artist, r.title, r.year, r.genre].join(" ").toLowerCase().includes(q),
  );
  const compare = (a, b) => {
    if (sort === "artist") return (a.artist || "").localeCompare(b.artist || "", "ja");
    if (sort === "genre") return (a.genre || "").localeCompare(b.genre || "", "ja");
    if (sort === "title") return (a.title || "").localeCompare(b.title || "", "ja");
    if (sort === "catalogNo") return (a.catalogNo || "").localeCompare(b.catalogNo || "", "ja");
    if (sort === "year") return Number(a.year || 0) - Number(b.year || 0);
    if (sort === "price") return Number(a.marketPrice || 0) - Number(b.marketPrice || 0);
    return String(a.added || "").localeCompare(String(b.added || ""));
  };
  const direction = sortDirection === "desc" ? -1 : 1,
    // Records without the sorted name (e.g. still being analyzed) go last either way.
    blank = (r) => ["artist", "title", "catalogNo"].includes(sort) && !r[sort];
  shown.sort((a, b) => blank(a) - blank(b) || compare(a, b) * direction);
  const filtered = Boolean(q) || filter !== "All" || artistFilter !== "All";
  $("#resultCount").textContent = filtered ? `${shown.length} / ${records.length} 枚` : `${records.length} 枚`;
  $("#clearFilters").hidden = !filtered;
  $("#recordGrid").innerHTML = listMode
    ? listTable(shown, sort)
    : shown.map(card).join("");
  $("#recordGrid").classList.toggle("list-view", viewMode === "list");
  for (const [button, mode] of [[$("#gridViewBtn"), "grid"], [$("#listViewBtn"), "list"]]) {
    button.classList.toggle("active", viewMode === mode);
    button.setAttribute("aria-pressed", String(viewMode === mode));
  }
  $("#emptyState").classList.toggle("hidden", records.length > 0);
  $("#recordGrid").classList.toggle("hidden", records.length === 0);
  // Cards and table rows open the record by click, Enter or Space.
  document.querySelectorAll(".card, .record-table tbody tr[data-id]").forEach((item) => {
    item.onclick = () => navigate(`record/${item.dataset.id}`);
    item.onkeydown = (event) => {
      if (event.target !== item || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      navigate(`record/${item.dataset.id}`);
    };
  });
  document.querySelectorAll(".record-table [data-sort]").forEach((button) => {
    button.onclick = () => {
      const nextSort = button.dataset.sort;
      if (sort === nextSort) sortDirection = sortDirection === "asc" ? "desc" : "asc";
      else {
        $("#sortSelect").value = nextSort;
        sortDirection = defaultDirection(nextSort);
      }
      render();
    };
  });
  if (refocus) document.querySelector(`#genreRow ${refocus}, #recordGrid ${refocus}`)?.focus();
  syncRouteQuery();
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
          ? "AI解析エラー"
          : r.aiStatus === "pending"
            ? "AI解析待ち"
            : r.aiStatus === "no_resources"
              ? "AIリソースなし"
              : "";
  return `<article class="card" data-id="${esc(r.id)}" tabindex="0" role="button" aria-label="${esc(displayArtist(r))} - ${esc(displayTitle(r))}"><div class="cover"><img src="${r.cover || placeholder(r)}" alt="${esc(displayTitle(r))}のジャケット">${aiLabel ? `<span class="ai-status ${r.aiStatus}">${aiLabel}</span>` : ""}</div><div class="card-meta"><p${r.artist ? "" : ' class="unknown-name"'}>${esc(displayArtist(r))} · ${r.year || "—"}</p><h3${r.title ? "" : ' class="unknown-name"'}>${esc(displayTitle(r))}</h3>${trackSummary(r)}<div class="price-row"><span>${r.genre}</span>${marketPriceHtml(r)}</div><small class="added-date">追加日 ${esc(formatArchiveDate(r.added))}</small></div></article>`;
}
function listTable(shown, sort) {
  const columns = [
    ["title", "タイトル"],
    ["artist", "アーティスト"],
    ["year", "リリース年"],
    ["added", "追加日"],
    ["genre", "ジャンル"],
    ["price", "参考価格"],
    ["catalogNo", "カタログ番号"],
  ];
  const headers = columns.map(([key, label]) => {
    const active = sort === key;
    const arrow = active ? (sortDirection === "asc" ? " ↑" : " ↓") : "";
    return `<th scope="col" aria-sort="${active ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}"><button type="button" data-sort="${key}"${active ? ' class="sorted"' : ""}>${label}${arrow}</button></th>`;
  }).join("");
  const rows = shown.map((r) => `<tr data-id="${esc(r.id)}" tabindex="0" aria-label="${esc(displayArtist(r))} - ${esc(displayTitle(r))}">
    <td class="record-table-cover"><img src="${r.cover || placeholder(r)}" alt="${esc(displayTitle(r))}のジャケット"></td>
    <td class="record-table-title"><strong${r.title ? "" : ' class="unknown-name"'}>${esc(displayTitle(r))}</strong>${r.aiStatus === "processing" ? '<small class="record-table-status">AI解析中</small>' : ""}</td>
    <td${r.artist ? "" : ' class="unknown-name"'}>${esc(displayArtist(r))}</td><td>${r.year || "—"}</td>
    <td>${esc(formatArchiveDate(r.added))}</td><td>${esc(r.genre || "—")}</td>
    <td>${marketPriceHtml(r)}</td><td>${esc(r.catalogNo || "—")}</td>
  </tr>`).join("");
  return `<div class="record-table-scroll"><table class="record-table"><thead><tr><th class="cover-heading" scope="col">写真</th>${headers}</tr></thead><tbody>${rows || '<tr><td class="table-no-results" colspan="8">条件に合うレコードがありません</td></tr>'}</tbody></table></div>`;
}
function placeholder(r) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#1d2e43"/><circle cx="430" cy="170" r="190" fill="#e94f28"/><text x="42" y="465" font-size="54" fill="#f2eee5" font-family="serif">${esc(displayTitle(r)).slice(0, 16)}</text><text x="45" y="515" font-size="21" fill="#dfba62" font-family="sans-serif">${esc(displayArtist(r))}</text></svg>`)}`;
}
function youtubeSearch(r, track) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent([r.artist, track].filter(Boolean).join(" "))}`;
}
function appleMusicSearch(r, track) {
  return `music://music.apple.com/jp/search?term=${encodeURIComponent([r.artist, track].filter(Boolean).join(" "))}`;
}
function trackRow(r, side, title) {
  if (!title)
    return `<div class="track-row empty-track"><b>${side}</b><span>${side === "B" ? "未確認" : "曲名未登録"}</span></div>`;
  const review = side === "B" && r.bTitleVerified !== true;
  return `<div class="track-row"><b>${side}</b><span>${esc(title)}${review ? "（要確認）" : ""}</span><div class="listen-links"><a class="listen-apple" href="${appleMusicSearch(r, title)}" aria-label="Apple Musicアプリで検索"> Music ↗</a><a href="${youtubeSearch(r, title)}" target="_blank" rel="noopener">YouTube</a></div></div>`;
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
function aiSourceList(sources = []) {
  if (!Array.isArray(sources) || !sources.length) return "";
  const links = sources
    .map((source) => {
      try {
        const url = new URL(source.url);
        if (url.protocol !== "https:") return "";
        const host = url.hostname.toLowerCase();
        if (
          host.includes("auctions.yahoo.co.jp") ||
          host === "jp.mercari.com" ||
          host.endsWith(".mercari.com")
        ) return "";
        return `<li><a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(source.title || url.hostname)} ↗</a></li>`;
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("");
  return links ? `<div class="ai-sources"><span>AI調査の出典</span><ul>${links}</ul></div>` : "";
}
const genreOptions = ["Jazz", "Rock", "Soul", "Electronic", "Hip-Hop", "Classical", "Pop", "Other"];
function detailEditor(r) {
  const genres = genreOptions.includes(r.genre) || !r.genre ? genreOptions : [...genreOptions, r.genre];
  return `<form class="detail-edit" id="detailEditForm" novalidate>
    <div class="fields">
      <label>アーティスト名<input name="artist" required value="${esc(r.artist)}"></label>
      <label>タイトル<input name="title" required value="${esc(r.title)}"></label>
      <label class="side-field side-a">A面 曲名<input name="aTitle" value="${esc(r.aTitle)}"></label>
      <label class="side-field side-b">B面 曲名<input name="bTitle" value="${esc(r.bTitle)}"></label>
      <label>発売年<input name="year" type="number" min="1900" max="2099" value="${Number(r.year) > 0 ? Number(r.year) : ""}"></label>
      <label>ジャンル<select name="genre">${genres.map((g) => `<option${g === (r.genre || "Other") ? " selected" : ""}>${esc(g)}</option>`).join("")}</select></label>
      <label>市場価格（円）<input name="marketPrice" type="number" min="0" step="100" value="${Number(r.marketPrice) > 0 ? Number(r.marketPrice) : ""}"></label>
    </div>
    <label>メモ<textarea name="notes" rows="3">${esc(r.notes)}</textarea></label>
    <p class="detail-edit-error" role="alert"></p>
    <div class="dialog-actions"><button type="button" class="secondary" id="cancelEdit">キャンセル</button><button class="add-btn" type="submit">保存</button></div>
  </form>`;
}
function saveRecordEdit(r, form) {
  const d = Object.fromEntries(new FormData(form)),
    artist = d.artist.trim(),
    title = d.title.trim(),
    bTitle = d.bTitle.trim(),
    price = d.marketPrice === "" ? null : Number(d.marketPrice),
    currentPrice = Number(r.marketPrice) > 0 ? Number(r.marketPrice) : null;
  if (!artist || !title) {
    form.querySelector(".detail-edit-error").textContent = "アーティスト名とタイトルを入力してください";
    return;
  }
  // A B-side typed by the user counts as confirmed; an unchanged one keeps its AI verification state.
  if (bTitle !== (r.bTitle || "")) r.bTitleVerified = Boolean(bTitle);
  if (price !== currentPrice) {
    r.marketPrice = price;
    r.marketPriceBasis = price === null ? "" : "manual";
    r.marketPriceNotes = price === null ? "" : "手入力の市場価格です。";
    r.marketPriceChecked = price === null ? "" : tokyoToday();
    r.marketPriceConfidence = null;
  }
  Object.assign(r, {
    artist,
    title,
    bTitle,
    aTitle: d.aTitle.trim(),
    year: Number(d.year) || 0,
    genre: d.genre,
    notes: d.notes.trim(),
  });
  // Saving an edit means the user has reviewed the record, so clear AI review states.
  if (["review", "no_resources", "error"].includes(r.aiStatus)) {
    r.aiStatus = "complete";
    r.aiError = null;
    r.aiNeedsReview = false;
  }
  r.updatedAt = new Date().toISOString();
  r.syncStatus = "pending";
  save();
  leaveRoute(`record/${r.id}`);
  toast("変更を保存しました");
}
function showDetail(id, editing = false) {
  const r = records.find((x) => x.id === id);
  if (!r) return;
  const aiBusy = awaitingAi(r);
  const editButton = editing
    ? ""
    : `<button type="button" class="secondary edit-btn" id="editRecord"${aiBusy ? ' disabled title="AI解析が終わると編集できます"' : ""}>編集</button>`;
  const body = editing
    ? `<div><p class="eyebrow">EDIT RECORD</p>${detailEditor(r)}</div>`
    : `<div><p>${r.genre} · ${r.year || "年代不明"}</p><h2${r.title ? "" : ' class="unknown-name"'}>${esc(displayTitle(r))}</h2><h3${r.artist ? "" : ' class="unknown-name"'}>${esc(displayArtist(r))}</h3><p class="record-added">追加日 <time>${esc(formatArchiveDate(r.added))}</time></p>${r.aiStatus === "error" ? `<p class="ai-error">AI解析に失敗しました: ${esc(r.aiError || "自動で再試行します")}</p>` : ""}<div class="tracklist"><p class="eyebrow">TRACKS & LISTEN</p>${trackRow(r, "A", r.aTitle)}${trackRow(r, "B", r.bTitle)}</div><div class="detail-data"><div><span>MARKET${priceBasisLabels[r.marketPriceBasis] && Number(r.marketPrice) > 0 ? ` · ${priceBasisLabels[r.marketPriceBasis]}` : ""}</span>${marketPriceHtml(r)}</div></div><div class="market-research"><span>ウェブ調査</span><p>${esc(r.marketPriceNotes || (Number(r.marketPrice) > 0 ? "市場価格を記録済みです。" : "市場価格はまだ調査されていません。"))}</p><small>調査日 ${esc(r.marketPriceChecked || "—")}</small></div>${r.aiNotes ? `<div class="market-research"><span>AI解析メモ</span><p>${esc(r.aiNotes)}</p></div>` : ""}${aiSourceList(r.aiSources)}${r.coverPath ? `<button type="button" class="ai-retry" id="retryAnalysis">AIで市場価格・曲目を再調査</button>` : ""}<p>${esc(r.notes || "メモはありません。")}</p><button type="button" class="delete-btn" id="deleteRecord">このレコードを削除</button></div>`;
  $("#detailContent").innerHTML =
    `<div class="dialog-head"><p class="eyebrow">7-INCH ARCHIVE DETAIL</p><div class="detail-head-actions">${editButton}<button type="button" class="close" id="closeDetail" aria-label="閉じる">×</button></div></div><div class="detail-grid"><img src="${r.cover || placeholder(r)}" alt="${esc(displayTitle(r))}のジャケット">${body}</div>`;
  $("#closeDetail").onclick = () => $("#detailDialog").close();
  if (editing) {
    const form = $("#detailEditForm");
    form.onsubmit = (event) => {
      event.preventDefault();
      saveRecordEdit(r, form);
    };
    $("#cancelEdit").onclick = () => leaveRoute(`record/${id}`);
    form.querySelector("input").focus();
  } else {
    if (!aiBusy) $("#editRecord").onclick = () => navigate(`record/${id}/edit`);
    $("#deleteRecord").onclick = () => removeRecord(id);
    if (r.coverPath) $("#retryAnalysis").onclick = () => retryCloudAnalysis(id);
  }
  if (!$("#detailDialog").open) $("#detailDialog").showModal();
}
function removeRecord(id) {
  if (confirm("このレコードをコレクションから削除しますか？")) {
    const removed = records.find((r) => r.id === id);
    records = records.filter((r) => r.id !== id);
    writeDatabase();
    render();
    deleteCloudRecord(id, removed?.coverPath);
    $("#detailDialog").close();
    toast("削除しました。ほかの端末にも自動反映します");
  }
}
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
  const today = tokyoToday(),
    created = batchPhotos.map((cover) => ({
      id: crypto.randomUUID(),
      artist: "",
      title: "",
      year: 0,
      genre: "Other",
      condition: "Very Good+",
      marketPrice: null,
      purchasePrice: 0,
      catalogNo: "",
      notes: "",
      cover,
      added: today,
      priceChecked: "",
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
function openAddDialog() {
  renderCaptureQueue();
  captureMessage("");
  addDialog.showModal();
}
const addTabs = [...document.querySelectorAll("[data-add-tab]")];
function showAddTab(name) {
  for (const tab of addTabs) {
    const selected = tab.dataset.addTab === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`#${tab.getAttribute("aria-controls")}`).hidden = !selected;
  }
}
// Switching tabs rewrites the route instead of adding history, like filters do.
function selectAddTab(name) {
  stopCamera();
  $("#uploadZone").classList.remove("hidden");
  history.replaceState(history.state, "", routeUrl(name === "manual" ? "add/manual" : "add"));
  showAddTab(name);
}
addTabs.forEach((tab, index) => {
  tab.onclick = () => selectAddTab(tab.dataset.addTab);
  tab.onkeydown = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const next = addTabs[(index + (event.key === "ArrowRight" ? 1 : addTabs.length - 1)) % addTabs.length];
    selectAddTab(next.dataset.addTab);
    next.focus();
  };
});
$("#openAdd").onclick = $("#emptyAdd").onclick = () => navigate("add");
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
    today = tokyoToday();
  records.unshift({
    ...d,
    id: crypto.randomUUID(),
    year: Number(d.year),
    marketPrice: d.marketPrice === "" ? null : Number(d.marketPrice),
    marketPriceBasis: d.marketPrice === "" ? "" : "manual",
    marketPriceNotes: d.marketPrice === "" ? "" : "手入力の市場価格です。",
    marketPriceChecked: d.marketPrice === "" ? "" : today,
    purchasePrice: Number(d.purchasePrice || 0),
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
$("#sortSelect").onchange = (e) => {
  sortDirection = defaultDirection(e.target.value);
  render();
};
$("#artistFilter").onchange = (e) => {
  artistFilter = e.target.value;
  render();
};
$("#sortDirection").onclick = () => {
  sortDirection = sortDirection === "desc" ? "asc" : "desc";
  render();
};
$("#clearFilters").onclick = () => {
  artistFilter = "All";
  $("#searchInput").value = "";
  filter = "All";
  render();
};
$("#exportBtn").onclick = async () => {
  // Photos not yet in the cloud are embedded so the backup stays self-contained.
  const exported = await Promise.all(
    records.map(async (record) => {
      const local = localCovers.get(record.id);
      return local ? { ...record, cover: await blobToDataUrl(local.blob) } : record;
    }),
  );
  const blob = new Blob([JSON.stringify(exported, null, 2)], {
      type: "application/json",
    }),
    a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "vinyl-archive-backup.json";
  a.click();
  URL.revokeObjectURL(a.href);
  toast("バックアップを書き出しました");
};
// URL routing. Routes live in the hash so they work on GitHub Pages:
//   #/?q=..&genre=..&artist=..&sort=..&dir=asc&view=list
//   #/record/<id>   #/record/<id>/edit   #/add   #/add/manual
// Supabase auth redirects also use the hash (#access_token=...), so only
// hashes starting with "#/" are treated as routes.
const sortValues = [...$("#sortSelect").options].map((option) => option.value);
function parseRoute() {
  const hash = location.hash;
  if (hash && !hash.startsWith("#/")) return null;
  const [path, query = ""] = hash.slice(2).split("?");
  return { path: path.split("/").filter(Boolean), params: new URLSearchParams(query) };
}
function routeUrl(path) {
  const params = new URLSearchParams(),
    q = $("#searchInput").value.trim(),
    sort = $("#sortSelect").value;
  if (q) params.set("q", q);
  if (filter !== "All") params.set("genre", filter);
  if (artistFilter !== "All") params.set("artist", artistFilter);
  if (sort !== "added") params.set("sort", sort);
  if (sortDirection !== defaultDirection(sort)) params.set("dir", sortDirection);
  if (viewMode === "list") params.set("view", "list");
  const query = params.toString(),
    hash = path || query ? `#/${path}${query ? `?${query}` : ""}` : "";
  return location.pathname + location.search + hash;
}
// Filters and view changes rewrite the current entry instead of adding history.
function syncRouteQuery() {
  const route = parseRoute();
  if (!route) return;
  const url = routeUrl(route.path.join("/"));
  if (url !== location.pathname + location.search + location.hash)
    history.replaceState(history.state, "", url);
}
// Opening a dialog adds a history entry so the back button/gesture closes it.
function navigate(path) {
  history.pushState({ inApp: true }, "", routeUrl(path));
  applyRoute();
}
// Leave a dialog route: step back if this app pushed it, otherwise (opened
// from a shared link) replace it so back doesn't leave the app.
function leaveRoute(fallbackPath = "") {
  if (history.state?.inApp) history.back();
  else {
    history.replaceState(null, "", routeUrl(fallbackPath));
    applyRoute();
  }
}
function applyRoute() {
  const route = parseRoute();
  if (!route) return render();
  const { path, params } = route,
    sort = params.get("sort");
  $("#searchInput").value = params.get("q") || "";
  // "lgenre" was the list view's separate genre filter in older links.
  filter = params.get("genre") || params.get("lgenre") || "All";
  $("#sortSelect").value = sortValues.includes(sort) ? sort : "added";
  // Without any route the remembered view mode applies.
  if (location.hash) viewMode = params.get("view") === "list" ? "list" : "grid";
  const dir = params.get("dir");
  sortDirection = dir === "asc" || dir === "desc" ? dir : defaultDirection($("#sortSelect").value);
  artistFilter = params.get("artist") || "All";
  render();

  const [page, id, mode] = path,
    record = page === "record" ? records.find((r) => r.id === id) : null;
  if (record) {
    const busy = awaitingAi(record);
    if (mode === "edit" && busy) history.replaceState(history.state, "", routeUrl(`record/${id}`));
    showDetail(id, mode === "edit" && !busy);
  } else if ($("#detailDialog").open) $("#detailDialog").close();
  if (page === "add") {
    showAddTab(id === "manual" ? "manual" : "photo");
    if (!addDialog.open) openAddDialog();
  } else if (addDialog.open) addDialog.close();
}
window.addEventListener("popstate", applyRoute);
// Closing a dialog by ×, Esc, save or delete leaves its route. When the route
// already changed (back button), there is nothing left to do.
$("#detailDialog").addEventListener("close", () => {
  if (parseRoute()?.path[0] === "record") leaveRoute();
});
addDialog.addEventListener("close", () => {
  stopCamera();
  if (parseRoute()?.path[0] === "add") leaveRoute();
});
// What cloud-sync.js may read and change.
const cloudSyncApi = {
  getRecords: () => records,
  getLocalCover: (id) => localCovers.get(id)?.blob || null,
  selectCloudCollection: async (userId, preserveCurrent = false) => {
    const nextKey = userId ? `records:user:${userId}` : "records:guest";
    if (nextKey === databaseCollectionKey) return;
    const carryOver = preserveCurrent && databaseCollectionKey === "records";
    databaseCollectionKey = nextKey;
    if (!db) {
      if (!carryOver) records = [];
      render();
      return;
    }
    if (carryOver) {
      // Write this device's records into the account's collection as new rows,
      // alongside anything already cached there.
      persistedRecords.clear();
      persistedCovers.clear();
      await writeDatabase();
    }
    await loadCollection();
    render();
  },
  replaceRecords: (next) => {
    records = withoutPlaceholderNames(next);
    writeDatabase();
    render();
    // A shared record link may arrive before the record has synced to this device.
    if (!$("#detailDialog").open && parseRoute()?.path[0] === "record") applyRoute();
  },
  notify: toast,
};
initApp().then(() => initCloudSync(cloudSyncApi));
