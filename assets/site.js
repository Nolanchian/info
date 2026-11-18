// 三頁共用：讀 data/site.json 產生內容；網址加 ?edit 進入編輯模式，儲存時用 GitHub API 直接 commit 回 repo。
const REPO = { owner: "Nolanchian", repo: "info", path: "data/site.json", branch: "main" };
const TOKEN_KEY = "info-gh-token";
const PAGES = [
  { id: "profile", href: "index.html", label: "介紹" },
  { id: "research", href: "research.html", label: "研究" },
  { id: "tools", href: "tools.html", label: "工具" },
  { id: "library", href: "library.html", label: "資料庫" },
];

const page = document.body.dataset.page;
const isEditing = new URLSearchParams(location.search).has("edit");
let site = null;
let loadedSha = null;
let dirty = false;
let activeTag = "";

/* ── 小工具 ── */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === "") continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

// 只放行 http(s) 與站內相對路徑，避免 javascript: 之類的連結
function safeUrl(url) {
  const value = String(url ?? "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value) || /^[\w./#?=-]+$/.test(value)) return value;
  return "";
}

function link(text, url) {
  const href = safeUrl(url);
  return href ? el("a", { href, target: href.startsWith("http") ? "_blank" : null, rel: "noopener" }, text) : text;
}

const pad = (n) => String(n).padStart(2, "0");
const today = () => new Date().toLocaleDateString("sv-SE");

function storage(action, value) {
  try {
    if (action === "get") return localStorage.getItem(TOKEN_KEY) ?? "";
    if (action === "set") localStorage.setItem(TOKEN_KEY, value);
    if (action === "clear") localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 私密視窗等情況拿不到 localStorage，token 只好每次重輸
  }
  return "";
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(base64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}

/* ── 編輯用元件 ── */
function editor(row, field) {
  if (field.kind === "select") {
    const select = el("select", { class: "cell", "aria-label": field.label },
      field.options().map((opt) => el("option", { value: opt.id }, opt.label)));
    select.value = row[field.field] ?? "";
    select.addEventListener("change", () => { row[field.field] = select.value; markDirty(); });
    return select;
  }
  const span = el("span", { contenteditable: "plaintext-only", "aria-label": field.label, "data-placeholder": field.label });
  span.textContent = field.kind === "tags" ? (row[field.field] ?? []).join("、") : (row[field.field] ?? "");
  span.addEventListener("input", () => {
    const value = span.innerText.trim();
    row[field.field] = field.kind === "tags" ? value.split(/[、,，]\s*/).filter(Boolean) : value;
    markDirty();
  });
  return span;
}

function rowControls(list, index) {
  const move = (delta) => {
    const [item] = list.splice(index, 1);
    list.splice(index + delta, 0, item);
    markDirty(true);
  };
  return el("td", { class: "rowctl" },
    el("button", { type: "button", title: "上移", disabled: index === 0, onclick: () => move(-1) }, "↑"),
    el("button", { type: "button", title: "下移", disabled: index === list.length - 1, onclick: () => move(1) }, "↓"),
    el("button", { type: "button", class: "del", title: "刪除", onclick: () => {
      if (!confirm("刪除這一列？")) return;
      list.splice(index, 1);
      markDirty(true);
    } }, "✕"));
}

// columns：瀏覽時的欄位；fields：編輯時每個欄位一格
function dataTable({ list, columns, fields, newRow, rowProps }) {
  if (isEditing) {
    const head = el("tr", {}, el("th", {}, "#"), fields.map((f) => el("th", {}, f.label)), el("th", {}, ""));
    const body = list.map((row, i) => el("tr", {},
      el("td", { class: "num" }, pad(i + 1)),
      fields.map((f) => el("td", {}, editor(row, f))),
      rowControls(list, i)));
    return el("div", {},
      el("div", { class: "edit-wrap" }, el("table", {}, el("thead", {}, head), el("tbody", {}, body))),
      el("button", { type: "button", class: "mini addrow", onclick: () => { list.push(newRow()); markDirty(true); } }, "＋ 新增一列"));
  }
  const head = el("tr", {}, el("th", {}, "#"), columns.map((c) => el("th", {}, c.label)));
  const body = list.map((row, i) => el("tr", rowProps ? rowProps(row, i) : {},
    el("td", { class: "num" }, pad(i + 1)),
    columns.map((c) => el("td", { class: c.className }, c.view(row)))));
  return el("table", { class: "stack" }, el("thead", {}, head), el("tbody", {}, body));
}

function kvTable(obj, fields) {
  return el("table", { class: "kv" }, el("tbody", {},
    fields.map((f) => el("tr", {}, el("th", {}, f.label), el("td", {}, editor(obj, f))))));
}

function section(id, title, ...content) {
  return el("section", { class: "sec", id, "data-filterable": true },
    el("h2", {}, title, el("span", { class: "count" })), content);
}

/* ── 介紹頁 ── */
function profilePage() {
  const p = site.profile;
  if (isEditing) {
    return [
      el("section", { class: "sec", id: "basic" }, el("h2", {}, "基本資料"),
        kvTable(p, [
          { field: "name", label: "姓名" }, { field: "nameEn", label: "英文名" }, { field: "slogan", label: "標語" },
          { field: "school", label: "學校" }, { field: "photo", label: "照片路徑" }, { field: "quote", label: "引言" },
        ])),
      el("section", { class: "sec", id: "roles" }, el("h2", {}, "職稱"),
        dataTable({ list: site.roles, fields: [{ field: "text", label: "職稱" }], newRow: () => ({ text: "" }) })),
      el("section", { class: "sec", id: "links" }, el("h2", {}, "連結"),
        dataTable({ list: site.links, fields: [{ field: "title", label: "名稱" }, { field: "url", label: "網址" }], newRow: () => ({ title: "", url: "" }) })),
      ...profileTables(),
    ];
  }
  const header = el("div", { class: "profile" },
    el("img", { src: safeUrl(p.photo), alt: p.name, width: 800, height: 1000 }),
    el("div", {},
      el("h1", {}, p.name, el("small", {}, p.nameEn)),
      el("span", { class: "slogan" }, p.slogan),
      el("ul", {}, site.roles.map((r) => el("li", {}, r.text))),
      el("div", { class: "meta" }, el("span", {}, p.school), site.links.map((l) => link(l.title, l.url))),
      p.quote && el("p", { class: "quote" }, p.quote)));
  return [header, ...profileTables()];
}

function profileTables() {
  return [
    section("timeline", "經歷", dataTable({
      list: site.timeline,
      columns: [
        { label: "年份", className: "nowrap", view: (r) => r.year },
        { label: "階段", className: "nowrap", view: (r) => r.stage },
        { label: "內容", view: (r) => link(r.text, r.url) },
      ],
      fields: [{ field: "year", label: "年份" }, { field: "stage", label: "階段" }, { field: "text", label: "內容" }, { field: "url", label: "連結" }],
      newRow: () => ({ year: String(new Date().getFullYear()), stage: "", text: "", url: "" }),
    })),
    section("talks", "演講經歷", dataTable({
      list: site.talks ??= [],
      columns: [
        { label: "日期", className: "nowrap", view: (r) => r.date },
        { label: "場次", view: (r) => r.title },
        { label: "地點", view: (r) => r.venue },
      ],
      fields: [{ field: "date", label: "日期" }, { field: "title", label: "場次" }, { field: "venue", label: "地點" }],
      newRow: () => ({ date: "", title: "", venue: "" }),
    })),
    section("achievements", "倡議成果", dataTable({
      list: site.achievements,
      columns: [{ label: "內容", view: (r) => r.text }],
      fields: [{ field: "text", label: "內容" }],
      newRow: () => ({ text: "" }),
    })),
  ];
}

/* ── 研究頁 ── */
function researchPage() {
  const skills = section("skills", "研究工具", dataTable({
    list: site.skills ??= [],
    columns: [
      { label: "工具", className: "nowrap", view: (r) => el("b", {}, r.name) },
      { label: "應用", view: (r) => link(r.text, r.url) },
      { label: "相關課程", view: (r) => r.courses },
    ],
    fields: [{ field: "name", label: "工具" }, { field: "text", label: "應用" }, { field: "url", label: "連結" }, { field: "courses", label: "相關課程" }],
    newRow: () => ({ name: "", text: "", url: "", courses: "" }),
  }));
  const courses = site.courses ??= [];
  if (isEditing) {
    return [skills, section("courses", "修課紀錄", dataTable({
      list: courses,
      fields: [{ field: "category", label: "類別" }, { field: "title", label: "課程" }, { field: "credits", label: "學分" }, { field: "teacher", label: "授課老師" }],
      newRow: () => ({ category: courses.at(-1)?.category ?? "", title: "", credits: "", teacher: "" }),
    }))];
  }
  const sumCredits = (list) => list.reduce((total, c) => total + (Number(c.credits) || 0), 0);
  const categories = [...new Set(courses.map((c) => c.category))];
  const summary = el("p", { class: "hint", id: "courses" }, `修課紀錄：共 ${courses.length} 門・${sumCredits(courses)} 學分`);
  return [skills, summary, ...categories.map((cat, i) => {
    const list = courses.filter((c) => c.category === cat);
    return section(`course-${i + 1}`, `${cat}・${sumCredits(list)} 學分`, dataTable({
      list,
      columns: [
        { label: "課程", view: (r) => r.title },
        { label: "學分", className: "nowrap", view: (r) => r.credits },
        { label: "授課老師", className: "nowrap", view: (r) => r.teacher },
      ],
    }));
  })];
}

/* ── 工具頁 ── */
function toolCard(tool) {
  const url = safeUrl(tool.url);
  const image = safeUrl(tool.image);
  return el("article", { class: "card" },
    image && el("a", { class: "shot", href: url || null, target: "_blank", rel: "noopener", tabindex: "-1" },
      el("img", { src: image, alt: `${tool.title}畫面`, loading: "lazy" })),
    el("div", { class: "body" },
      el("h3", {}, link(tool.title, tool.url)),
      el("p", {}, tool.text),
      el("div", { class: "links" },
        url && el("a", { class: "mini primary", href: url, target: "_blank", rel: "noopener" }, "開啟"),
        safeUrl(tool.repo) && el("a", { class: "mini", href: safeUrl(tool.repo), target: "_blank", rel: "noopener" }, "GitHub"))));
}

function toolsPage() {
  const toolList = isEditing
    ? dataTable({
      list: site.tools,
      fields: [{ field: "title", label: "名稱" }, { field: "image", label: "圖片路徑" }, { field: "text", label: "說明" }, { field: "url", label: "網址" }, { field: "repo", label: "GitHub" }],
      newRow: () => ({ title: "", image: "", text: "", url: "", repo: "" }),
    })
    : el("div", { class: "cards" }, site.tools.map(toolCard));
  return [
    section("tools", "工具", toolList),
    section("works", "其他作品", dataTable({
      list: site.works,
      columns: [{ label: "作品", view: (r) => [link(r.title, r.url), r.text && el("span", { class: "sub" }, r.text)] }],
      fields: [{ field: "title", label: "名稱" }, { field: "text", label: "說明" }, { field: "url", label: "網址" }],
      newRow: () => ({ title: "", text: "", url: "" }),
    })),
  ];
}

/* ── 資料庫頁 ── */
const categoryLabel = (id) => site.categories.find((c) => c.id === id)?.label ?? id;

function libraryPage() {
  if (isEditing) {
    return [section("resources", "資料庫", dataTable({
      list: site.resources,
      fields: [
        { field: "type", label: "類別", kind: "select", options: () => site.categories },
        { field: "title", label: "標題" }, { field: "url", label: "網址" }, { field: "source", label: "來源" },
        { field: "tags", label: "標籤（、分隔）", kind: "tags" }, { field: "note", label: "備註" },
      ],
      newRow: () => ({ type: site.categories[0]?.id ?? "", title: "", url: "", source: "", tags: [], note: "" }),
    }))];
  }
  const known = new Set(site.categories.map((c) => c.id));
  const groups = [...site.categories, { id: "other", label: "其他" }]
    .map((cat) => ({ cat, items: site.resources.filter((r) => (cat.id === "other" ? !known.has(r.type) : r.type === cat.id)) }))
    .filter((g) => g.items.length);

  const overview = el("div", { class: "sec", id: "overview" },
    el("div", { class: "filterbar" },
      el("span", { id: "tag-state" }),
      el("button", { type: "button", class: "mini", onclick: exportCsv }, "匯出 CSV"),
      el("span", { class: "hint" }, `共 ${site.resources.length} 筆・更新於 ${site.updated ?? ""}`)));

  return [overview, ...groups.map((g) => section(g.cat.id, g.cat.label, dataTable({
    list: g.items,
    rowProps: (r) => ({ "data-tags": (r.tags ?? []).join("|"), "data-index": site.resources.indexOf(r) }),
    columns: [
      { label: "標題", view: (r) => [el("b", {}, link(r.title, r.url)), r.note && el("span", { class: "sub" }, r.note)] },
      { label: "來源", view: (r) => r.source },
      { label: "標籤", view: (r) => (r.tags ?? []).map((t) => el("button", { type: "button", class: `tag${t === activeTag ? " on" : ""}`, onclick: () => setTag(t) }, t)) },
      { label: "", className: "nowrap", view: (r) => safeUrl(r.url) && el("button", { type: "button", class: "mini", onclick: (e) => copyLink(e.currentTarget, r.url) }, "複製連結") },
    ],
  })))];
}

function setTag(tag) {
  activeTag = activeTag === tag ? "" : tag;
  document.querySelectorAll(".tag").forEach((b) => b.classList.toggle("on", b.textContent === activeTag));
  applyFilter();
}

async function copyLink(button, url) {
  try {
    await navigator.clipboard.writeText(url);
    button.textContent = "已複製";
  } catch {
    button.textContent = "複製失敗";
  }
  setTimeout(() => { button.textContent = "複製連結"; }, 1500);
}

function exportCsv() {
  const rows = [...document.querySelectorAll("main tbody tr[data-index]:not(.is-hidden)")]
    .map((tr) => site.resources[Number(tr.dataset.index)]);
  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["類別", "標題", "網址", "來源", "標籤", "備註"].map(escape).join(",")]
    .concat(rows.map((r) => [categoryLabel(r.type), r.title, r.url, r.source, (r.tags ?? []).join("、"), r.note].map(escape).join(",")));
  // 加 BOM，Excel 打開中文才不會亂碼
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `resources-${today()}.csv`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── 搜尋／篩選 ── */
function applyFilter() {
  if (isEditing) return;
  const keyword = document.getElementById("search").value.trim().toLowerCase();
  document.querySelectorAll("main tbody tr, main .card").forEach((tr) => {
    const matchKeyword = !keyword || tr.textContent.toLowerCase().includes(keyword);
    const matchTag = !activeTag || (tr.dataset.tags ?? "").split("|").includes(activeTag);
    tr.classList.toggle("is-hidden", !(matchKeyword && matchTag));
  });
  document.querySelectorAll("main .sec[data-filterable]").forEach((sec) => {
    const rows = [...sec.querySelectorAll("tbody tr, .card")];
    const shown = rows.filter((r) => !r.classList.contains("is-hidden")).length;
    sec.classList.toggle("is-hidden", rows.length > 0 && shown === 0);
    const count = sec.querySelector("h2 .count");
    if (count) count.textContent = shown === rows.length ? `${rows.length}` : `${shown} / ${rows.length}`;
  });
  const tagState = document.getElementById("tag-state");
  if (tagState) {
    tagState.replaceChildren(activeTag
      ? el("button", { type: "button", class: "tag on", onclick: () => setTag(activeTag) }, `${activeTag} ✕`)
      : "");
  }
}

/* ── 外框 ── */
function navHref(href) {
  return isEditing ? `${href}?edit` : href;
}

function buildShell() {
  const topbar = el("header", { class: "topbar" }, el("div", { class: "in" },
    el("a", { class: "brand", href: navHref("index.html") }, site.profile.name, el("span", { class: "en" }, ` ${site.profile.nameEn}`)),
    el("nav", {}, PAGES.map((p) => el("a", { href: navHref(p.href), "aria-current": p.id === page ? "page" : null }, p.label)))));
  const search = el("input", { type: "search", id: "search", placeholder: "搜尋本頁", "aria-label": "搜尋本頁", oninput: applyFilter, hidden: isEditing });
  const layout = el("div", { class: "layout" },
    el("aside", { class: "side" }, search, el("ul", { class: "toc", id: "toc" })),
    el("main", { id: "main" }));
  const footer = el("footer", {}, `© ${new Date().getFullYear()} ${site.profile.name} ${site.profile.nameEn}・`,
    isEditing
      ? el("button", { type: "button", onclick: leaveEditing }, "離開編輯")
      : el("button", { type: "button", onclick: () => { location.search = "?edit"; } }, "編輯"));
  document.body.replaceChildren(topbar, layout, footer);
  if (isEditing) document.body.append(buildEditbar());
}

function render() {
  const builders = { profile: profilePage, research: researchPage, tools: toolsPage, library: libraryPage };
  const main = document.getElementById("main");
  main.replaceChildren(...builders[page]());
  document.getElementById("toc").replaceChildren(...[...main.querySelectorAll(".sec[id]")]
    .filter((sec) => sec.querySelector("h2"))
    .map((sec) => el("li", {}, el("a", { href: `#${sec.id}` }, sec.querySelector("h2").firstChild.textContent))));
  applyFilter();
}

/* ── 編輯模式：工具列與儲存 ── */
let statusEl;
function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function markDirty(structural = false) {
  dirty = true;
  setStatus("有未儲存的修改", "dirty");
  if (structural) render();
}

function buildEditbar() {
  statusEl = el("span", { class: "status" });
  return el("div", { class: "editbar" }, statusEl,
    el("button", { type: "button", onclick: () => downloadBlob(new Blob([serialize()], { type: "application/json" }), "site.json") }, "下載 JSON"),
    el("button", { type: "button", onclick: () => askToken(true) }, "設定 token"),
    el("button", { type: "button", onclick: leaveEditing }, "離開"),
    el("button", { type: "button", class: "primary", onclick: save }, "儲存到 GitHub"));
}

function leaveEditing() {
  if (dirty && !confirm("還有修改沒儲存，確定離開？")) return;
  dirty = false;
  location.href = location.pathname;
}

function serialize() {
  return `${JSON.stringify(site, null, 2)}\n`;
}

function askToken(force = false) {
  const existing = storage("get");
  if (existing && !force) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const input = el("input", { type: "password", placeholder: "github_pat_…", autocomplete: "off" });
    const dialog = el("dialog", {},
      el("h3", {}, "GitHub token"),
      el("p", {}, "到 ", el("a", { href: "https://github.com/settings/personal-access-tokens/new", target: "_blank", rel: "noopener" }, "GitHub 建立 fine-grained token"),
        "：Repository access 只選 ", el("b", {}, `${REPO.owner}/${REPO.repo}`), "，Permissions 的 Contents 設 Read and write。token 只存在這台瀏覽器。"),
      input,
      el("div", { class: "row" },
        existing && el("button", { type: "button", class: "mini", onclick: () => { storage("clear"); dialog.close(); resolve(""); setStatus("已清除 token"); } }, "清除"),
        el("button", { type: "button", class: "mini", onclick: () => { dialog.close(); resolve(""); } }, "取消"),
        el("button", { type: "button", class: "mini primary", onclick: () => {
          const token = input.value.trim();
          if (token) storage("set", token);
          dialog.close();
          resolve(token);
        } }, "儲存")));
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  });
}

function ghFetch(token, init = {}) {
  return fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/contents/${REPO.path}?ref=${REPO.branch}`, {
    cache: "no-store",
    ...init,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

function explainGithubError(status) {
  if (status === 401) return "token 無效或已過期，請按「設定 token」重新輸入";
  if (status === 403 || status === 404) return "token 沒有 info repo 的 Contents 寫入權限";
  if (status === 409) return "GitHub 上的檔案剛被改過，請重新整理後再存";
  return `GitHub 回應 ${status}`;
}

async function save() {
  const token = await askToken();
  if (!token) { setStatus("沒有 token，無法儲存（可先「下載 JSON」）", "err"); return; }
  setStatus("儲存中…");
  try {
    const current = await ghFetch(token);
    if (!current.ok) throw new Error(explainGithubError(current.status));
    const { sha } = await current.json();
    if (loadedSha && sha !== loadedSha && !confirm("GitHub 上的內容在你開始編輯後被改過，要用你的版本覆蓋嗎？")) {
      setStatus("已取消儲存", "dirty");
      return;
    }
    site.updated = today();
    const response = await ghFetch(token, {
      method: "PUT",
      body: JSON.stringify({ message: "透過編輯模式更新網站內容", content: toBase64(serialize()), sha, branch: REPO.branch }),
    });
    if (!response.ok) throw new Error(explainGithubError(response.status));
    loadedSha = (await response.json()).content.sha;
    dirty = false;
    setStatus("已儲存到 GitHub，約 1 分鐘後線上版更新", "ok");
  } catch (error) {
    setStatus(`儲存失敗：${error.message}`, "err");
  }
}

/* ── 啟動 ── */
async function loadSite() {
  const token = isEditing ? storage("get") : "";
  if (token) {
    // 編輯時直接讀 GitHub 上最新版，避開 Pages 快取
    try {
      const response = await ghFetch(token);
      if (response.ok) {
        const json = await response.json();
        loadedSha = json.sha;
        return JSON.parse(fromBase64(json.content));
      }
    } catch {
      // 讀不到就退回讀網站上的檔案
    }
  }
  const response = await fetch("data/site.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`讀取 data/site.json 失敗（HTTP ${response.status}）`);
  return response.json();
}

window.addEventListener("beforeunload", (event) => {
  if (dirty) event.preventDefault();
});

try {
  site = await loadSite();
  buildShell();
  if (isEditing) {
    document.body.classList.add("editing");
    setStatus(storage("get") ? "編輯模式" : "編輯模式・尚未設定 token");
  }
  render();
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
} catch (error) {
  document.body.replaceChildren(el("p", { style: "padding:24px" }, `載入失敗：${error.message}`));
}
