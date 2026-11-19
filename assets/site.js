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
let loadedSnapshot = "";
const normalizeJson = (text) => JSON.stringify(JSON.parse(text));
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
  if (field.kind === "multi") {
    // 勾選多個值，存成「a|b」
    const selected = new Set(String(row[field.field] ?? "").split("|").map((s) => s.trim()).filter(Boolean));
    const options = field.options();
    // 舊資料裡不在選項清單的值也保留顯示，避免存檔時默默消失
    for (const value of selected) if (!options.some((o) => o.id === value)) options.push({ id: value, label: value });
    return el("div", { class: "multi", role: "group", "aria-label": field.label }, options.map((opt) => {
      const box = el("input", { type: "checkbox", checked: selected.has(opt.id) });
      box.addEventListener("change", () => {
        if (box.checked) selected.add(opt.id); else selected.delete(opt.id);
        row[field.field] = options.map((o) => o.id).filter((id) => selected.has(id)).join("|");
        markDirty();
      });
      return el("label", {}, box, opt.label);
    }));
  }
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
    columns.map((c) => el("td", { class: c.className, "data-label": c.label }, c.view(row)))));
  return el("table", { class: "stack" }, el("thead", {}, head), el("tbody", {}, body));
}

function kvTable(obj, fields) {
  return el("table", { class: "kv" }, el("tbody", {},
    fields.map((f) => el("tr", {}, el("th", {}, f.label), el("td", {}, editor(obj, f))))));
}

function section(id, title, ...content) {
  return el("section", { class: "sec", id, "data-filterable": true },
    el("h2", {}, title), content);
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
        { label: "場次", view: (r) => [r.event, r.venue && el("span", { class: "sub" }, r.venue)] },
        { label: "講題", view: (r) => r.title },
        { label: "", className: "nowrap", view: (r) => safeUrl(r.photos) && el("a", { class: "mini", href: safeUrl(r.photos), target: "_blank", rel: "noopener" }, "照片") },
      ],
      fields: [{ field: "date", label: "日期" }, { field: "event", label: "場次" }, { field: "title", label: "講題" }, { field: "venue", label: "地點" }, { field: "photos", label: "照片連結" }],
      newRow: () => ({ date: "", event: "", title: "", venue: "", photos: "" }),
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
const sumCredits = (list) => list.reduce((total, c) => total + (Number(c.credits) || 0), 0);

// 還缺 = 規定 − 已修 − 修習中（以本學期全數通過計），超修不倒扣
function requirementRows(courses, requirements) {
  return requirements.map((req) => {
    const list = courses.filter((c) => c.category === req.category && (!req.domain || c.domain === req.domain));
    const done = sumCredits(list.filter((c) => !c.status));
    const ongoing = sumCredits(list.filter((c) => c.status));
    const required = Number(req.required) || 0;
    return { ...req, done, ongoing, missing: Math.max(0, required - done - ongoing) };
  });
}

function requirementSection(courses, requirements) {
  const rows = requirementRows(courses, requirements);
  // 有填領域的是類別底下的細項，總計只算類別本身，避免重複計算
  const total = (key) => rows.filter((r) => !r.domain).reduce((sum, r) => sum + (Number(r[key]) || 0), 0);
  const table = dataTable({
    list: rows,
    columns: [
      { label: "類別", className: "nowrap", view: (r) => (r.domain ? el("span", { class: "sub-row" }, `└ ${r.domain}`) : r.category) },
      { label: "規定", className: "nowrap hide-narrow", view: (r) => r.required },
      { label: "已修", className: "nowrap hide-narrow", view: (r) => r.done },
      { label: "修習中", className: "nowrap hide-narrow", view: (r) => r.ongoing || "" },
      { label: "還缺", className: "nowrap lbl", view: (r) => (r.missing ? el("b", { class: "missing" }, r.missing) : "✓") },
      { label: "待補", view: (r) => r.todo },
    ],
  });
  const totalRequired = total("required");
  const note = el("p", { class: "hint" },
    `畢業最低 ${totalRequired} 學分・已修 ${total("done")}＋修習中 ${total("ongoing")}・還缺 ${total("missing")} 學分（以本學期全數通過計）`);
  return section("requirements", "畢業學分檢核", note, table);
}

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
  const requirements = site.requirements ??= [];
  if (isEditing) {
    return [skills, section("requirements", "畢業學分檢核", dataTable({
      list: requirements,
      fields: [{ field: "category", label: "類別（需與修課類別同名）" }, { field: "domain", label: "領域（選填）" }, { field: "required", label: "規定學分" }, { field: "todo", label: "待補" }],
      newRow: () => ({ category: "", domain: "", required: "", todo: "" }),
    })), section("courses", "修課紀錄", dataTable({
      list: courses,
      fields: [{ field: "category", label: "類別" }, { field: "domain", label: "領域（博雅用）" }, { field: "title", label: "課程" }, { field: "credits", label: "學分" }, { field: "teacher", label: "授課老師" }, { field: "status", label: "狀態（空白＝已修）" }],
      newRow: () => ({ category: courses.at(-1)?.category ?? "", domain: "", title: "", credits: "", teacher: "", status: "" }),
    }))];
  }
  const creditText = (list) => {
    const done = list.filter((c) => !c.status);
    const ongoing = list.filter((c) => c.status);
    if (!ongoing.length) return `${sumCredits(done)} 學分`;
    if (!done.length) return `修習中 ${sumCredits(ongoing)} 學分`;
    return `已修 ${sumCredits(done)}＋修習中 ${sumCredits(ongoing)} 學分`;
  };
  const categories = [...new Set(courses.map((c) => c.category))];
  const summary = el("p", { class: "hint", id: "courses" }, `修課紀錄：${courses.length} 門・${creditText(courses)}`);
  const plannerLink = el("p", { class: "hint" }, el("a", { href: navHref("planner.html") }, "下學期排課試算 →"));
  return [skills, requirementSection(courses, requirements), plannerLink, summary, ...categories.map((cat, i) => {
    const list = courses.filter((c) => c.category === cat);
    const hasDomain = list.some((c) => c.domain);
    return section(`course-${i + 1}`, `${cat}・${creditText(list)}`, dataTable({
      list,
      columns: [
        hasDomain && { label: "領域", className: "nowrap", view: (r) => r.domain },
        { label: "課程", view: (r) => r.title },
        { label: "學分", className: "nowrap", view: (r) => r.credits },
        { label: "授課老師", className: "nowrap", view: (r) => r.teacher },
        { label: "狀態", className: "nowrap", view: (r) => r.status && el("span", { class: "status-tag" }, r.status) },
      ].filter(Boolean),
    }));
  })];
}

/* ── 排課頁 ── */
const PERIODS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "A", "B", "C", "D"];
const PERIOD_TIMES = ["08:10", "09:10", "10:20", "11:20", "12:20", "13:20", "14:20", "15:30", "16:30", "17:30", "18:40", "19:35", "20:30", "21:25"];
const OFFERINGS_FILE = "data/ntnu-offerings-115-2.json";
const DAYS = ["一", "二", "三", "四", "五"];
const LAYERS = [{ id: "nolan", label: "Nolan 版" }, { id: "ntnu", label: "師大通用版" }];
// 排課的草稿（目前圖層、勾選、模式）只存在這台瀏覽器
const STORAGE = {
  layer: "info-planner-layer",
  free: { nolan: "info-planner-free", ntnu: "info-planner-free-ntnu" },
  view: { nolan: "info-planner-view", ntnu: "info-planner-view-ntnu" },
  assign: { nolan: "info-planner-assign", ntnu: "info-planner-assign-ntnu" },
  profile: "info-ntnu-planner",
  extra: "info-planner-extra-nolan",
  hidden: "info-planner-hidden-nolan",
};
const plannerState = {
  layer: null,
  layers: { nolan: { mode: {}, pick: 0, view: null, free: null, assign: null }, ntnu: { mode: {}, pick: 0, view: null, free: null, assign: null } },
  profile: null,
  lookups: null,
  extra: null,
  hidden: null,
  catalog: { q: "", tag: "all" },
};

function readStore(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 私密視窗存不了就算了 */ }
}
function layerState(layer) {
  const st = plannerState.layers[layer];
  st.free ??= new Set(readStore(STORAGE.free[layer], []));
  st.view ??= readStore(STORAGE.view[layer], "best") === "free" ? "free" : "best";
  st.assign ??= readStore(STORAGE.assign[layer], {});
  return st;
}
function saveLayer(layer) {
  const st = layerState(layer);
  writeStore(STORAGE.free[layer], [...st.free]);
  writeStore(STORAGE.view[layer], st.view);
  writeStore(STORAGE.assign[layer], st.assign);
  writeStore(STORAGE.layer, plannerState.layer);
}

// 「二2-4」「三A-C」，多段用逗號分隔
function parseTime(text) {
  const slots = [];
  for (const part of String(text ?? "").replace(/\s+/g, "").split(/[,，、]+/).filter(Boolean)) {
    const match = part.match(/^([一二三四五])([0-9]+|[A-D])(?:-([0-9]+|[A-D]))?$/);
    if (!match) continue;
    const from = PERIODS.indexOf(match[2]);
    const to = PERIODS.indexOf(match[3] ?? match[2]);
    if (from < 0 || to < from) continue;
    for (let i = from; i <= to; i++) slots.push(`${match[1]}${PERIODS[i]}`);
  }
  return slots;
}

/* Nolan 版：缺口與候選課來自 site.json */
// 只取最細的缺口：有領域細項的類別用細項，MOOCs 不列入
function plannerNeeds() {
  const rows = requirementRows(site.courses ?? [], site.requirements ?? []);
  const hasDomain = new Set(rows.filter((r) => r.domain).map((r) => r.category));
  return rows
    .filter((r) => (r.domain || !hasDomain.has(r.category)) && r.missing > 0 && !r.category.includes("MOOCs"))
    .map((r) => ({
      key: r.domain ? `${r.category}/${r.domain}` : r.category,
      label: r.domain ? `${r.category}・${r.domain}` : r.category,
      missing: r.missing,
    }));
}

// 排課「算入」的選項：畢業學分檢核裡最細的類別（有領域就用領域），含已補滿的
function requirementOptions() {
  const reqs = site.requirements ?? [];
  const hasDomain = new Set(reqs.filter((r) => r.domain).map((r) => r.category));
  return reqs
    .filter((r) => r.domain || !hasDomain.has(r.category))
    .map((r) => (r.domain
      ? { id: `${r.category}/${r.domain}`, label: `${r.category.replace("課程", "")}・${r.domain}` }
      : { id: r.category, label: r.category }));
}

function courseTag(option, credits) {
  if (!option) return `${credits}`;
  if (option.includes("/")) return `${option.split("/")[1]} 通${credits}`;
  if (option.startsWith("必修")) return `必${credits}`;
  if (option.startsWith("必選修")) return `選${credits}`;
  if (option.startsWith("基本能力")) return `體${credits}`;
  if (option.startsWith("跨域")) return `跨域 通${credits}`;
  return `${option} ${credits}`;
}

// 同一門課的不同組用「課號-組別」區分；排課時同一課號只會選一組
const candidateKey = (c) => (c.code ? `${c.code}${c.group ? `-${c.group}` : ""}` : c.title);
const candidateTitle = (c, fallback) => {
  const base = c.title || c.code || fallback;
  return c.group ? `${base}（${c.group} 組）` : base;
};

// 課號的客觀資料：通識領域、可否跨域、體育、在某系某年課架的類別、這學期的開課組別
function courseFacts(code, deptId, year) {
  const id = String(code ?? "").trim().toUpperCase();
  const lookups = plannerState.lookups;
  const dept = deptId ? lookups?.depts[deptId] : null;
  const curriculum = dept ? dept.years[year] : null;
  return {
    id,
    ge: lookups?.ge.courses[id] ?? null,
    pe: /^00UP/.test(id),
    deptCategory: curriculum?.courses[id]?.category ?? null,
    offering: lookups?.offerings?.courses?.[id] ?? null,
  };
}

// Nolan 版用自己的類別名稱（地理系 113 學年度入學）
function nolanOptionsFor(code) {
  const facts = courseFacts(code, "geo", "113");
  const options = [];
  if (facts.deptCategory === "系必修") options.push("必修（地理系）");
  if (facts.deptCategory === "系選修") options.push("必選修（地理系）");
  if (facts.ge?.domain) options.push(`博雅課程/${facts.ge.domain}`);
  if (facts.ge?.cross && !(facts.ge.otherDeptOnly && /^GE[UC]/.test(facts.id))) options.push("跨域探索");
  if (facts.ge?.selfLearning) options.push("自主學習（MOOCs）");
  if (facts.pe) options.push("基本能力課程");
  return options;
}

// 把一門開課的每一組都變成候選列，讓機器挑組
function offeringRows(code, makeCounts, existingKeys = new Set()) {
  const offering = plannerState.lookups?.offerings?.courses?.[code];
  if (!offering) return [];
  const sections = offering.sections.filter((s) => s.time);
  const list = sections.length ? sections : offering.sections.slice(0, 1);
  // 已經在候選名單裡的組別不重複加入
  return list.filter((s) => !existingKeys.has(candidateKey({ code, group: list.length > 1 ? s.group : "" }))).map((s) => ({
    code, group: list.length > 1 ? s.group : "", title: offering.title.replace(/^體育（(.+)）$/, "$1"),
    teacher: s.teacher, room: s.room, credits: String(offering.credits), time: s.time, counts: makeCounts(code),
  }));
}

function nolanContext() {
  const taken = new Set((site.courses ?? []).map((c) => c.title));
  const labels = requirementOptions();
  plannerState.extra ??= readStore(STORAGE.extra, []);
  // 網站上的候選課在一般頁面不能改，移除時只記在這台瀏覽器，可以還原
  plannerState.hidden ??= new Set(readStore(STORAGE.hidden, []));
  const siteRows = (site.planner?.candidates ?? []).map((c) => ({ ...c, source: "site" }));
  const hiddenCount = siteRows.filter((c) => plannerState.hidden.has(candidateKey(c))).length;
  const rows = [
    ...siteRows.filter((c) => !plannerState.hidden.has(candidateKey(c))),
    ...plannerState.extra.map((c) => ({ ...c, source: "local" })),
  ];
  return {
    layer: "nolan",
    title: `${site.planner?.term ?? ""} 排課試算`,
    needs: plannerNeeds(),
    candidates: rows.map((c, id) => ({
      ...c, id, key: candidateKey(c), title: candidateTitle(c, `課程 ${id + 1}`), credits: Number(c.credits) || 0, slots: parseTime(c.time),
      options: String(c.counts ?? "").split("|").map((s) => s.trim()).filter(Boolean), taken: taken.has(c.title),
    })),
    catalogTags: (code) => nolanOptionsFor(code).map((o) => (o === "基本能力課程" ? "體育" : labels.find((l) => l.id === o)?.label ?? o)),
    optionsFor: (code) => (taken.has(plannerState.lookups?.offerings?.courses?.[code]?.title) ? [] : nolanOptionsFor(code)),
    addOffering: (code) => {
      plannerState.extra.push(...offeringRows(code, (c) => nolanOptionsFor(c).join("|"), new Set(rows.map(candidateKey))));
      writeStore(STORAGE.extra, plannerState.extra);
    },
    removeCandidate: (c) => () => {
      if (c.source === "local") {
        plannerState.extra = plannerState.extra.filter((x) => candidateKey(x) !== c.key);
        writeStore(STORAGE.extra, plannerState.extra);
      } else {
        plannerState.hidden.add(c.key);
        writeStore(STORAGE.hidden, [...plannerState.hidden]);
      }
    },
    hiddenNote: hiddenCount && el("p", { class: "hint" }, `已移除 ${hiddenCount} 門網站上的候選課（只在這台瀏覽器）。`,
      el("button", { type: "button", class: "mini", onclick: () => { plannerState.hidden = new Set(); writeStore(STORAGE.hidden, []); render(); } }, "全部還原")),
    catalogNote: "在這裡加入的課只存在這台瀏覽器；要存到網站，請到編輯模式從開課清單加入後儲存。",
    limits: (site.planner?.limits ?? []).map((l) => ({ key: l.category, max: Number(l.max) })),
    notes: (site.planner?.limits ?? []).filter((l) => l.note).map((l) => l.note),
    optionLabel: (id) => labels.find((o) => o.id === id)?.label ?? id,
    tag: courseTag,
  };
}

/* 師大通用版：每個人自己填缺口與候選課，存在瀏覽器 */
const NTNU_DEFAULT_NEEDS = ["中文英文", "體育", "博雅・人文藝術", "博雅・社會科學", "博雅・自然科學", "博雅・邏輯運算", "跨域探索", "通識（不限類別）", "系必修", "系選修", "自由學分"];
// 各系各入學年度的課程架構；沒找到官方文件的年度列在 missingYears
const NTNU_DEPTS = {
  geo: {
    label: "地理學系",
    years: {
      "115": "data/ntnu-geo-115.json", "114": "data/ntnu-geo-114.json", "113": "data/ntnu-geo-113.json",
      "112": "data/ntnu-geo-112.json", "111": "data/ntnu-geo-111.json", "109": "data/ntnu-geo-109.json",
    },
    missingYears: ["110"],
    deptPrefixes: ["GEU", "GEC"],
  },
};
const needMissing = (n) => Math.max(0, (Number(n.required) || 0) - (Number(n.done) || 0));
function defaultProfile() {
  return {
    dept: "",
    year: "",
    needs: NTNU_DEFAULT_NEEDS.map((name) => ({ name, required: "", done: "" })),
    limits: [{ category: "體育", max: "1" }],
    candidates: [],
  };
}
function normalizeProfile(data) {
  const profile = { ...defaultProfile(), ...data };
  // 舊格式：dept 是「geo-113」、缺口只有 missing 一欄
  if (/^geo-\d+$/.test(profile.dept)) { profile.year = profile.dept.split("-")[1]; profile.dept = "geo"; }
  profile.needs = profile.needs.map((n) => ("required" in n ? n : { name: n.name, required: n.missing ?? "", done: "" }));
  return profile;
}
function loadProfile() {
  const saved = readStore(STORAGE.profile, null);
  return saved && Array.isArray(saved.needs) && Array.isArray(saved.candidates) ? normalizeProfile(saved) : defaultProfile();
}
const saveProfile = () => writeStore(STORAGE.profile, plannerState.profile);

async function loadLookups() {
  const fetchJson = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url} HTTP ${r.status}`); return r.json(); };
  const ge = await fetchJson("data/ntnu-ge.json");
  const offerings = await fetchJson(OFFERINGS_FILE);
  const depts = {};
  for (const [id, dept] of Object.entries(NTNU_DEPTS)) {
    const years = {};
    for (const [year, file] of Object.entries(dept.years)) years[year] = await fetchJson(file);
    depts[id] = { ...dept, years };
  }
  return { ge, depts, offerings };
}

// 用課號猜類別：通識查官方總表、00UP 是體育、科系課號查該系課程架構
function classifyCode(code, profile) {
  const id = String(code ?? "").trim().toUpperCase();
  const lookups = plannerState.lookups;
  if (!id || !lookups) return null;
  const hit = { title: "", credits: "", counts: [], note: [] };
  const ge = lookups.ge.courses[id];
  const ownDept = profile.dept && plannerState.lookups.depts[profile.dept]?.deptPrefixes.some((p) => id.startsWith(p));
  // 本系的專業課（課架裡本來就有）不能採計為通識
  if (ge && !(ge.otherDeptOnly && ownDept)) {
    hit.title = ge.title; hit.credits = String(ge.credits);
    if (ge.domain) { hit.counts.push(`博雅・${ge.domain}`); hit.note.push(`通識・${ge.domain}`); }
    // 標「※」的系上專業課只有外系學生能算跨域
    if (ge.cross && !(ge.otherDeptOnly && ownDept)) { hit.counts.push("跨域探索"); hit.note.push(ge.otherDeptOnly ? "外系可算跨域" : "可算跨域"); }
    if (ge.selfLearning) hit.note.push("自主學習（至多 4 學分，不算跨域）");
    hit.counts.push("通識（不限類別）");
  }
  if (/^00UP/.test(id)) { hit.counts.push("體育"); hit.credits ||= "1"; hit.note.push("體育"); }
  const dept = profile.dept && lookups.depts[profile.dept];
  const curriculum = dept ? dept.years[profile.year] : null;
  if (dept && curriculum) {
    const course = curriculum.courses[id];
    if (course) {
      hit.title ||= course.title; hit.credits ||= String(course.credits);
      hit.counts.push(course.category); hit.note.push(course.category);
    } else if (dept.deptPrefixes.some((p) => id.startsWith(p))) {
      // 系上開的課但不在該年度課架清單：不自動勾，提醒去確認
      hit.note.push(`不在 ${profile.year} 學年度課架清單，是否算系選修請洽系辦`);
    }
  }
  const offering = lookups.offerings?.courses?.[id];
  if (offering) {
    hit.title ||= offering.title.replace(/^體育（(.+)）$/, "$1");
    hit.credits ||= String(offering.credits);
    hit.offering = offering;
    hit.note.push(`${lookups.offerings.term} 有開${offering.sections.length > 1 ? ` ${offering.sections.length} 組` : ""}`);
  } else if (hit.note.length) {
    hit.note.push(`${lookups.offerings?.term ?? ""} 沒開`);
  }
  if (!hit.note.length) return null;
  const names = new Set(profile.needs.map((n) => n.name));
  hit.counts = hit.counts.filter((n) => names.has(n));
  return hit;
}

function ntnuContext() {
  const p = plannerState.profile;
  return {
    layer: "ntnu",
    title: "師大通用版 排課試算",
    needs: p.needs.filter((n) => n.name && needMissing(n) > 0).map((n) => ({ key: n.name, label: n.name, missing: needMissing(n) })),
    candidates: p.candidates.map((c, id) => ({
      ...c, id, key: candidateKey(c), title: candidateTitle(c, `課程 ${id + 1}`), credits: Number(c.credits) || 0,
      slots: parseTime(c.time), options: (c.counts ?? []).filter(Boolean), taken: false,
    })),
    catalogTags: (code) => classifyCode(code, p)?.counts ?? [],
    optionsFor: (code) => classifyCode(code, p)?.counts ?? [],
    addOffering: (code) => {
      p.candidates.push(...offeringRows(code, (c) => classifyCode(c, p)?.counts ?? [], new Set(p.candidates.map(candidateKey))));
      saveProfile();
    },
    removeCandidate: (c) => () => {
      p.candidates = p.candidates.filter((x) => candidateKey(x) !== c.key);
      saveProfile();
    },
    catalogNote: "",
    limits: p.limits.map((l) => ({ key: l.category, max: Number(l.max) })),
    notes: p.limits.filter((l) => l.category && l.max !== "").map((l) => `${l.category}至多 ${l.max} 門`),
    optionLabel: (id) => id,
    tag: (option, credits) => (option ? `${option.replace("博雅・", "")} ${credits}` : `${credits}`),
  };
}

/* 共用的排課核心 */
// 一門課可以算進多個類別時，挑讓總覆蓋最大的分配
function bestAssignment(chosen, needs) {
  const need = Object.fromEntries(needs.map((n) => [n.key, n.missing]));
  const multi = chosen.filter((c) => c.options.length > 1);
  const pick = new Map();
  let best = { coverage: -1, assign: new Map(), tally: {} };
  const evaluate = () => {
    const tally = {};
    for (const c of chosen) {
      const key = pick.get(c.id) ?? c.options[0];
      tally[key] = (tally[key] ?? 0) + c.credits;
    }
    const coverage = Object.entries(need).reduce((sum, [key, missing]) => sum + Math.min(missing, tally[key] ?? 0), 0);
    if (coverage > best.coverage) best = { coverage, assign: new Map(pick), tally };
  };
  const walk = (i) => {
    if (i === multi.length) return evaluate();
    for (const option of multi[i].options) { pick.set(multi[i].id, option); walk(i + 1); }
  };
  walk(0);
  return best;
}

const MAX_SEARCH_NODES = 250000;
function solvePlanner(ctx, st) {
  const modeOf = (c) => st.mode[c.key] ?? (c.taken ? "never" : "auto");
  const pool = ctx.candidates.filter((c) => modeOf(c) !== "never");
  const must = pool.filter((c) => modeOf(c) === "must");
  const need = Object.fromEntries(ctx.needs.map((n) => [n.key, n.missing]));
  // 搜尋順序：候選越少的類別越先排，計算量有上限時也能先找到好方案
  const supply = {};
  pool.forEach((c) => c.options.forEach((k) => { supply[k] = (supply[k] ?? 0) + c.credits; }));
  const scarcity = (c) => Math.min(...c.options.filter((k) => need[k]).map((k) => supply[k] / need[k]), Infinity);
  const optional = pool.filter((c) => modeOf(c) !== "must").sort((a, b) => scarcity(a) - scarcity(b) || b.credits - a.credits);
  // 剩下的候選課在各類別最多還能補多少，用來估上限、剪掉不可能更好的分支
  const keys = Object.keys(need);
  const suffix = Array.from({ length: optional.length + 1 }, () => Object.fromEntries(keys.map((k) => [k, 0])));
  for (let i = optional.length - 1; i >= 0; i--) {
    keys.forEach((k) => { suffix[i][k] = suffix[i + 1][k] + (optional[i].options.includes(k) ? optional[i].credits : 0); });
  }
  const reach = Object.fromEntries(keys.map((k) => [k, 0]));
  const limits = ctx.limits.filter((l) => l.key && Number.isFinite(l.max));
  const used = new Set();
  const chosen = [];
  const count = {};
  const filled = {};
  const flexible = {};
  let credits = 0;
  const conflicts = [];
  const codes = new Set();
  const hitsLimit = (c) => (c.code && codes.has(c.code)) || limits.some((l) => c.options.includes(l.key) && (count[l.key] ?? 0) >= l.max);
  // 粗估這門課還有沒有用：它能算的類別裡至少一個還沒補滿；
  // 已選的多類別課可以改算別類，所以它們佔的學分不算死
  const useful = (c) => c.options.some((k) => (filled[k] ?? 0) - (flexible[k] ?? 0) < (need[k] ?? 0));
  const apply = (c, sign) => {
    c.slots.forEach((s) => (sign > 0 ? used.add(s) : used.delete(s)));
    if (c.code) { if (sign > 0) codes.add(c.code); else codes.delete(c.code); }
    c.options.forEach((k) => { if (k in reach) reach[k] += sign * c.credits; });
    limits.forEach((l) => { if (c.options.includes(l.key)) count[l.key] = (count[l.key] ?? 0) + sign; });
    if (sign > 0) {
      const target = [...c.options].sort((a, b) => ((need[b] ?? 0) - (filled[b] ?? 0)) - ((need[a] ?? 0) - (filled[a] ?? 0)))[0];
      c.filledKey = target;
    }
    if (c.filledKey) {
      filled[c.filledKey] = (filled[c.filledKey] ?? 0) + sign * c.credits;
      if (c.options.length > 1) flexible[c.filledKey] = (flexible[c.filledKey] ?? 0) + sign * c.credits;
    }
    credits += sign * c.credits;
  };
  for (const c of must) {
    if (c.slots.some((s) => used.has(s))) conflicts.push(c.title);
    if (hitsLimit(c)) conflicts.push(`${c.title}（同一門課重複或超過類別門數上限）`);
    apply(c, 1);
    chosen.push(c);
  }
  const top = [];
  // 補到的學分一樣多時，優先補必修（必修沒得替代，選修可以換別門）
  const weight = Object.fromEntries(keys.map((k) => [k, /必修/.test(k) && !/選修/.test(k) ? 1 : 0]));
  const better = (a, b) => b.coverage - a.coverage || b.weighted - a.weighted || a.credits - b.credits || a.evening - b.evening || a.days - b.days;
  let nodes = 0;
  let truncated = false;
  const walk = (i) => {
    if (++nodes > MAX_SEARCH_NODES) { truncated = true; return; }
    // 樂觀上限：已選的課（可算的類別都算一次）加上剩下所有候選，仍贏不過前幾名就不往下找
    if (top.length >= 6) {
      const bound = keys.reduce((sum, k) => sum + Math.min(need[k], reach[k] + suffix[i][k]), 0);
      if (bound < top[top.length - 1].coverage) return;
    }
    if (i === optional.length) {
      const { coverage, tally } = bestAssignment(chosen, ctx.needs);
      const weighted = keys.reduce((sum, k) => sum + Math.min(need[k], tally[k] ?? 0) * weight[k], 0);
      const evening = chosen.reduce((n, c) => n + c.slots.filter((s) => /[A-D]$/.test(s)).length, 0);
      const days = new Set(chosen.flatMap((c) => c.slots.map((s) => s[0]))).size;
      top.push({ ids: chosen.map((c) => c.id), coverage, weighted, credits, evening, days });
      // 覆蓋最多 → 學分最少（不多修） → 晚上的課最少 → 上課天數最少
      top.sort(better);
      if (top.length > 6) top.pop();
      return;
    }
    const c = optional[i];
    if (useful(c) && !c.slots.some((s) => used.has(s)) && !hitsLimit(c)) {
      apply(c, 1);
      chosen.push(c);
      walk(i + 1);
      chosen.pop();
      apply(c, -1);
    }
    walk(i + 1);
  };
  walk(0);
  return { results: top, conflicts, truncated };
}

function timetable(chosen, assign, tag) {
  const at = new Map();
  for (const c of chosen) c.slots.forEach((s) => at.set(s, [...(at.get(s) ?? []), c]));
  const signature = (key) => (at.get(key) ?? []).map((c) => c.id).join(",");
  const lastUsed = Math.max(9, ...chosen.flatMap((c) => c.slots.map((s) => PERIODS.indexOf(s.slice(1)))));
  const skip = new Set();
  const body = PERIODS.slice(0, lastUsed + 1).map((period, row) => el("tr", {},
    el("th", { class: "tt-time" }, el("b", {}, period), el("small", {}, PERIOD_TIMES[row])),
    DAYS.map((day) => {
      const key = `${day}${period}`;
      if (skip.has(key)) return null;
      const list = at.get(key);
      if (!list) return el("td", {});
      const sig = signature(key);
      let span = 1;
      while (row + span <= lastUsed && signature(`${day}${PERIODS[row + span]}`) === sig) { skip.add(`${day}${PERIODS[row + span]}`); span++; }
      if (list.length > 1) {
        return el("td", { rowspan: span, class: "tt-course tt-clash" }, el("b", {}, "衝堂"), list.map((c) => el("span", {}, c.title)));
      }
      const c = list[0];
      const option = assign.get(c.id) ?? c.options[0];
      return el("td", { rowspan: span, class: "tt-course" },
        el("b", {}, c.title), c.room && el("span", {}, c.room), c.teacher && el("span", {}, c.teacher),
        el("span", { class: "tt-tag" }, `【${tag(option, c.credits)}】`));
    })));
  return el("div", { class: "tt-wrap" }, el("table", { class: "timetable" },
    el("thead", {}, el("tr", {}, el("th", {}, ""), DAYS.map((d) => el("th", {}, d)))), el("tbody", {}, body)));
}

// 最佳模式／自由排課兩種檢視，兩個圖層共用
function plannerView(baseCtx) {
  const st = layerState(baseCtx.layer);
  // 可算多類的課，使用者可以指定只算其中一類；沒指定就由機器挑
  const ctx = {
    ...baseCtx,
    candidates: baseCtx.candidates.map((c) => {
      const forced = st.assign[c.key];
      return { ...c, allOptions: c.options, options: forced && c.options.includes(forced) ? [forced] : c.options };
    }),
  };
  const { needs, candidates } = ctx;
  const sortedCandidates = [...candidates].sort((a, b) => categoryRank(a.allOptions.map(ctx.optionLabel)) - categoryRank(b.allOptions.map(ctx.optionLabel)) || a.id - b.id);
  const totalMissing = needs.reduce((sum, n) => sum + n.missing, 0);
  const tabs = (items, current, onPick, label) => el("div", { class: "planner-modes", role: "group", "aria-label": label },
    items.map(({ id, label: text }) => el("button", {
      type: "button", class: `mini${current === id ? " primary" : ""}`, "aria-pressed": String(current === id), onclick: () => onPick(id),
    }, text)));
  const bar = el("div", { class: "planner-bar" },
    tabs(LAYERS, ctx.layer, (id) => { plannerState.layer = id; saveLayer(id); render(); }, "排課版本"),
    tabs([{ id: "best", label: "最佳模式" }, { id: "free", label: "自由排課" }], st.view, (id) => { st.view = id; saveLayer(ctx.layer); render(); }, "排課模式"),
    el("span", { class: "hint" }, [totalMissing ? `還缺 ${totalMissing} 學分` : "先在下方填各類別還缺幾學分", ...ctx.notes].join("・")));

  const needTable = (assignment) => (needs.length ? dataTable({
    list: needs.map((n) => ({ ...n, got: Math.min(n.missing, assignment.tally[n.key] ?? 0) })),
    columns: [
      { label: "類別", view: (n) => n.label },
      { label: "還缺", className: "nowrap lbl", view: (n) => n.missing },
      { label: "目前補到", className: "nowrap lbl", view: (n) => (n.got >= n.missing ? "✓" : el("b", { class: "missing" }, `${n.got}（差 ${n.missing - n.got}）`)) },
    ],
  }) : el("p", { class: "empty-note" }, "還沒有填缺口"));
  const courseColumns = [
    { label: "課程", view: (c) => [
      el("b", {}, c.title),
      el("span", { class: "sub" }, [c.time || "時間未定", `${c.credits} 學分`, c.code, c.teacher].filter(Boolean).join("・")),
      c.taken && el("span", { class: "status-tag" }, "已修／修習中")] },
    { label: "算入", view: (c) => {
      if (c.allOptions.length < 2) return c.allOptions.map(ctx.optionLabel).join("／");
      const select = el("select", { class: "cell", "aria-label": `${c.title} 算入哪一類`, "data-focus-key": `assign-${c.key}` },
        el("option", { value: "" }, "自動"),
        c.allOptions.map((o) => el("option", { value: o }, `只算 ${ctx.optionLabel(o)}`)));
      select.value = st.assign[c.key] ?? "";
      select.addEventListener("change", () => {
        if (select.value) st.assign[c.key] = select.value; else delete st.assign[c.key];
        st.pick = 0;
        saveLayer(ctx.layer);
        render();
      });
      return select;
    } },
  ];
  const startFree = (keys) => { st.free = new Set(keys); st.view = "free"; saveLayer(ctx.layer); render(); };
  const removeColumn = { label: "", className: "nowrap", view: (c) => {
    const remove = ctx.removeCandidate?.(c);
    return remove && el("button", { type: "button", class: "mini", onclick: () => { remove(); st.free.delete(c.key); saveLayer(ctx.layer); render(); } }, "移除");
  } };
  // 候選課與開課清單並排；清單可以拖進候選區
  // 目前方案還沒補滿的類別，開課清單的「一鍵加入」只找這些
  const gapsOf = (assignment) => new Set(needs.filter((n) => (assignment.tally[n.key] ?? 0) < n.missing).map((n) => n.key));
  const candidateArea = (table, gaps) => {
    const drop = el("div", { class: "drop-zone" }, ctx.hiddenNote || null, table, el("p", { class: "hint drop-hint" }, "把開課清單的課拖到這裡，或在清單按「加入」。"));
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag-over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag-over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("drag-over");
      const code = e.dataTransfer.getData("text/plain");
      if (code) { ctx.addOffering(code); render(); }
    });
    return el("div", { class: "cand-catalog" },
      section("candidates", "候選課程", drop),
      catalogPanel(ctx, undefined, gaps));
  };

  if (st.view === "free") {
    const chosen = candidates.filter((c) => st.free.has(c.key));
    const assignment = bestAssignment(chosen, needs);
    const owners = new Map();
    chosen.forEach((c) => c.slots.forEach((s) => owners.set(s, [...(owners.get(s) ?? []), c.title])));
    const clashTitles = [...new Set([...owners.values()].filter((list) => list.length > 1).flat())];
    const limitIssues = ctx.limits.filter((l) => chosen.filter((c) => c.options.includes(l.key)).length > l.max).map((l) => `${l.key}至多 ${l.max} 門`);
    const takenPicked = chosen.filter((c) => c.taken).map((c) => c.title);
    const codeCount = {};
    chosen.forEach((c) => { if (c.code) codeCount[c.code] = (codeCount[c.code] ?? 0) + 1; });
    const duplicated = chosen.filter((c) => codeCount[c.code] > 1).map((c) => c.title);
    const warnings = [
      duplicated.length && `同一門課選了不只一組：${duplicated.join("、")}`,
      clashTitles.length && `衝堂：${clashTitles.join("、")}`,
      limitIssues.length && `超過門數上限：${limitIssues.join("、")}`,
      takenPicked.length && `已修或修習中：${takenPicked.join("、")}`,
    ].filter(Boolean);
    const pickBox = (c) => {
      const box = el("input", { type: "checkbox", checked: st.free.has(c.key), "aria-label": `選 ${c.title}` });
      box.addEventListener("change", () => {
        if (box.checked) st.free.add(c.key); else st.free.delete(c.key);
        saveLayer(ctx.layer);
        render();
      });
      return box;
    };
    return [
      bar,
      section("plan", "自由排課",
        el("p", { class: "hint" }, `已選 ${chosen.length} 門・${sumCredits(chosen)} 學分・補 ${assignment.coverage}/${totalMissing}`),
        warnings.map((w) => el("p", { class: "missing" }, w)),
        el("div", { class: "planner-picks" },
          el("button", { type: "button", class: "mini", onclick: () => startFree(solvePlanner(ctx, st).results[0]?.ids.map((id) => candidates[id].key) ?? []) }, "從最佳方案 1 重新開始"),
          el("button", { type: "button", class: "mini", onclick: () => startFree([]) }, "清空")),
        timetable(chosen, assignment.assign, ctx.tag)),
      section("needs", "缺口", needTable(assignment)),
      candidateArea(candidates.length ? dataTable({
        list: sortedCandidates,
        rowProps: (c) => ({ class: st.free.has(c.key) ? (clashTitles.includes(c.title) ? "clash-row" : "picked") : null }),
        columns: [{ label: "選", className: "nowrap", view: pickBox }, ...courseColumns, removeColumn],
      }) : el("p", { class: "empty-note" }, "還沒有候選課程"), gapsOf(assignment)),
    ];
  }

  const { results, conflicts, truncated } = candidates.length ? solvePlanner(ctx, st) : { results: [], conflicts: [], truncated: false };
  st.pick = Math.min(st.pick, Math.max(0, results.length - 1));
  const current = results[st.pick];
  const chosen = current ? candidates.filter((c) => current.ids.includes(c.id)) : [];
  const assignment = current ? bestAssignment(chosen, needs) : { tally: {}, assign: new Map() };
  const modeSelect = (c) => {
    const select = el("select", { class: "cell", "aria-label": `${c.title} 選課狀態` },
      el("option", { value: "auto" }, "自動"), el("option", { value: "must" }, "必選"), el("option", { value: "never" }, "排除"));
    select.value = st.mode[c.key] ?? (c.taken ? "never" : "auto");
    select.addEventListener("change", () => { st.mode[c.key] = select.value; st.pick = 0; render(); });
    return select;
  };
  return [
    bar,
    conflicts.length ? el("p", { class: "missing" }, `必選的課有衝突：${conflicts.join("、")}`) : null,
    truncated ? el("p", { class: "missing" }, "候選課太多，只算了部分組合；可以把確定不上的課設成「排除」、一定要上的設成「必選」。") : null,
    section("plan", "建議方案",
      el("div", { class: "planner-picks" }, results.map((r, i) => el("button", {
        type: "button", class: `mini${i === st.pick ? " primary" : ""}`, onclick: () => { st.pick = i; render(); },
      }, `方案 ${i + 1}・補 ${r.coverage}/${totalMissing}・${r.credits} 學分`))),
      current && el("button", { type: "button", class: "mini primary", onclick: () => startFree(chosen.map((c) => c.key)) }, `以方案 ${st.pick + 1} 進入自由排課 →`),
      current ? timetable(chosen, assignment.assign, ctx.tag) : el("p", { class: "empty-note" }, candidates.length ? "沒有可行的組合" : "還沒有候選課程")),
    section("needs", "缺口", needTable(assignment)),
    candidateArea(candidates.length ? dataTable({
      list: sortedCandidates,
      rowProps: (c) => ({ class: current?.ids.includes(c.id) ? "picked" : null }),
      columns: [...courseColumns, { label: "", className: "nowrap", view: modeSelect }, removeColumn],
    }) : el("p", { class: "empty-note" }, "還沒有候選課程"), gapsOf(assignment)),
  ].filter(Boolean);
}

// 排序：必修 > 系選修＝博雅 > 其他能算的類別 > 算不進任何類別
function categoryRank(labels) {
  if (labels.some((l) => /必修/.test(l) && !/選修/.test(l))) return 0;
  if (labels.some((l) => /選修|博雅/.test(l))) return 1;
  return labels.length ? 2 : 3;
}

// 這學期的開課清單：可篩選、搜尋，拖進候選區或按「加入」
const CATALOG_FILTERS = [
  ["all", "全部"], ["必修", "系必修"], ["選修", "系選修"], ["跨域", "跨域探索"],
  ["人文藝術", "人文藝術"], ["社會科學", "社會科學"], ["自然科學", "自然科學"], ["邏輯運算", "邏輯運算"], ["體育", "體育"],
];
function catalogPanel(ctx, onAdd = (code) => { ctx.addOffering(code); render(); }, gaps = null) {
  const offerings = plannerState.lookups?.offerings;
  if (!offerings) return null;
  const state = plannerState.catalog;
  const addedKeys = new Set(ctx.candidates.map((c) => c.key ?? candidateKey(c)));
  // 每門課還有幾組沒加入
  const missingSections = (code) => offeringRows(code, () => [], addedKeys).length;
  const keyword = state.q.trim().toLowerCase();
  const rows = Object.entries(offerings.courses)
    .map(([code, o]) => ({ code, ...o, tags: ctx.catalogTags(code) }))
    .filter((o) => state.tag === "all" || o.tags.some((tag) => tag.includes(state.tag)))
    .filter((o) => !keyword || `${o.code} ${o.title} ${o.sections.map((s) => s.teacher).join(" ")}`.toLowerCase().includes(keyword))
    .sort((a, b) => categoryRank(a.tags) - categoryRank(b.tags) || a.code.localeCompare(b.code));
  const search = el("input", { type: "search", class: "cell-input", placeholder: "搜尋課號、課名、老師", value: state.q, "data-focus-key": "catalog-q", "aria-label": "搜尋開課清單" });
  search.addEventListener("input", () => { state.q = search.value; clearTimeout(catalogPanel.timer); catalogPanel.timer = setTimeout(render, 250); });
  const filter = el("select", { class: "cell", "aria-label": "篩選類別" }, CATALOG_FILTERS.map(([id, label]) => el("option", { value: id }, label)));
  filter.value = state.tag;
  filter.addEventListener("change", () => { state.tag = filter.value; render(); });
  const list = el("ul", { class: "catalog-list" }, rows.map((o) => {
    const missing = missingSections(o.code);
    const isAdded = missing === 0;
    const partly = !isAdded && o.sections.some((s) => addedKeys.has(candidateKey({ code: o.code, group: s.group })) || addedKeys.has(o.code));
    const item = el("li", { class: `catalog-item${isAdded ? " added" : ""}`, draggable: isAdded ? null : "true" },
      el("div", { class: "catalog-main" },
        el("b", {}, o.title), el("span", { class: "sub" }, `${o.code}・${o.credits} 學分・${o.unit}`),
        el("span", { class: "sub" }, o.sections.map((s) => [s.group && `${s.group}`, s.time || "時間未定", s.teacher].filter(Boolean).join(" ")).join("／")),
        o.tags.length ? el("span", { class: "catalog-tags" }, o.tags.join("・")) : null),
      isAdded ? el("span", { class: "status-tag" }, "已加入") : el("button", { type: "button", class: "mini", onclick: () => onAdd(o.code) }, partly ? `加入其他 ${missing} 組` : "加入"));
    item.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", o.code); e.dataTransfer.effectAllowed = "copy"; });
    return item;
  }));
  // 能補到目前還缺的類別、而且還有組別沒加入的課
  // 另外把已在候選裡的課其他組別也帶進來：換組常常能空出時段給別的課
  const candidateCodes = new Set(ctx.candidates.map((c) => c.code).filter(Boolean));
  const helpful = ctx.optionsFor && gaps?.size
    ? Object.keys(offerings.courses).filter((code) => missingSections(code) > 0
      && (ctx.optionsFor(code).some((k) => gaps.has(k)) || candidateCodes.has(code)))
    : [];
  const addHelpful = helpful.length && el("button", { type: "button", class: "mini primary", onclick: () => { helpful.forEach((code) => ctx.addOffering(code)); render(); } },
    `加入所有能補「${[...gaps].map(ctx.optionLabel).join("、")}」的課（${helpful.length} 門）`);
  return section("catalog", `${offerings.term} 開課清單`,
    el("div", { class: "planner-picks" }, filter, search, addHelpful || null),
    el("p", { class: "hint" }, `${rows.length} 門。多組的課會把每組都加入，由排課機器挑組。`),
    ctx.catalogNote ? el("p", { class: "hint" }, ctx.catalogNote) : null,
    list);
}

/* 師大通用版：頁面上直接編輯的表單 */
function profileInput(obj, field, focusKey, props = {}, onCommit) {
  const input = el("input", { class: "cell-input", value: obj[field] ?? "", "data-focus-key": focusKey, ...props });
  input.addEventListener("input", () => { obj[field] = input.value; saveProfile(); });
  // 失焦或按 Enter 才重排，避免打字時一直重畫
  input.addEventListener("change", () => { onCommit?.(); saveProfile(); setTimeout(render, 0); });
  return input;
}

function ntnuEditors() {
  const p = plannerState.profile;
  const names = p.needs.map((n) => n.name).filter(Boolean);
  const removeButton = (list, index) => el("button", { type: "button", class: "mini", onclick: () => { list.splice(index, 1); saveProfile(); render(); } }, "刪除");
  const addButton = (text, onAdd) => el("button", { type: "button", class: "mini addrow", onclick: () => { onAdd(); saveProfile(); render(); } }, text);
  const table = (head, rows) => {
    // 窄螢幕會把每列排成卡片，用 data-label 補上欄名
    rows.forEach((tr) => [...tr.children].forEach((td, i) => { td.dataset.label = head[i] ?? ""; }));
    return el("div", { class: "edit-wrap" }, el("table", { class: "profile-table" },
      el("thead", {}, el("tr", {}, head.map((h) => el("th", {}, h)))), el("tbody", {}, rows)));
  };

  const deptSelect = el("select", { class: "cell", "aria-label": "科系" },
    el("option", { value: "" }, "不指定（只判斷通識與體育）"),
    Object.entries(NTNU_DEPTS).map(([id, d]) => el("option", { value: id }, d.label)));
  deptSelect.value = p.dept ?? "";
  deptSelect.addEventListener("change", () => {
    p.dept = deptSelect.value;
    p.year = p.dept ? Object.keys(NTNU_DEPTS[p.dept].years).sort().reverse()[0] : "";
    saveProfile();
    render();
  });
  const dept = p.dept && plannerState.lookups.depts[p.dept];
  const yearSelect = dept && el("select", { class: "cell", "aria-label": "入學年度" },
    Object.keys(dept.years).sort().reverse().map((y) => el("option", { value: y }, `${y} 學年度入學`)));
  if (yearSelect) {
    yearSelect.value = p.year;
    yearSelect.addEventListener("change", () => { p.year = yearSelect.value; saveProfile(); render(); });
  }
  const curriculum = dept ? dept.years[p.year] : null;
  const applyThresholds = () => {
    const filled = p.needs.some((n) => n.required !== "" || n.done !== "");
    if (filled && !confirm("用這個入學年度的畢業門檻取代目前的類別與門檻？已填的「已修」會保留在同名類別。")) return;
    const done = Object.fromEntries(p.needs.map((n) => [n.name, n.done]));
    p.needs = curriculum.thresholds.map((th) => ({ name: th.name, required: String(th.required), done: done[th.name] ?? "" }));
    const names = new Set(p.needs.map((n) => n.name));
    p.limits = p.limits.filter((l) => names.has(l.category));
    saveProfile();
    render();
  };

  const importInput = el("input", { type: "file", accept: "application/json", hidden: true });
  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.needs) || !Array.isArray(data.candidates)) throw new Error("檔案格式不對");
      plannerState.profile = normalizeProfile(data);
      saveProfile();
      render();
    } catch (error) {
      alert(`匯入失敗：${error.message}`);
    }
  });

  const needRows = p.needs.map((n, i) => el("tr", {},
    el("td", {}, profileInput(n, "name", `need-${i}-name`, { "aria-label": "類別名稱" })),
    el("td", {}, profileInput(n, "required", `need-${i}-required`, { type: "number", min: "0", inputmode: "numeric", "aria-label": `${n.name} 畢業門檻` })),
    el("td", {}, profileInput(n, "done", `need-${i}-done`, { type: "number", min: "0", inputmode: "numeric", "aria-label": `${n.name} 已修學分` })),
    el("td", { class: "nowrap" }, needMissing(n) ? el("b", { class: "missing" }, needMissing(n)) : "✓"),
    el("td", {}, removeButton(p.needs, i))));

  const limitRows = p.limits.map((l, i) => {
    const select = el("select", { class: "cell", "aria-label": "限制的類別" }, names.map((name) => el("option", { value: name }, name)));
    select.value = l.category;
    select.addEventListener("change", () => { l.category = select.value; saveProfile(); render(); });
    return el("tr", {}, el("td", {}, select),
      el("td", {}, profileInput(l, "max", `limit-${i}-max`, { type: "number", min: "0", inputmode: "numeric", "aria-label": "最多幾門" })),
      el("td", {}, removeButton(p.limits, i)));
  });

  const candidateRows = p.candidates.map((c, i) => {
    c.counts ??= [];
    const detected = classifyCode(c.code, p);
    const useSection = (section) => {
      c.group = section.group; c.time = section.time; c.teacher = section.teacher; c.room = section.room;
    };
    const codeInput = profileInput(c, "code", `cand-${i}-code`, { placeholder: "例：0SUG411", "aria-label": "課號" }, () => {
      const hit = classifyCode(c.code, p);
      if (!hit) return;
      if (!c.title) c.title = hit.title;
      if (!c.credits) c.credits = hit.credits;
      if (hit.counts.length) c.counts = [...new Set(hit.counts)];
      const sections = hit.offering?.sections ?? [];
      if (sections.length && !sections.some((s) => s.group === c.group && s.time === c.time)) useSection(sections.find((s) => s.time) ?? sections[0]);
    });
    const sections = detected?.offering?.sections ?? [];
    const groupSelect = sections.length > 1 && (() => {
      const select = el("select", { class: "cell", "aria-label": "組別", "data-focus-key": `cand-${i}-group` },
        sections.map((s, k) => el("option", { value: String(k) }, [`${s.group || "—"} 組`, s.time, s.teacher].filter(Boolean).join(" "))));
      select.value = String(Math.max(0, sections.findIndex((s) => s.group === c.group && s.time === c.time)));
      select.addEventListener("change", () => { useSection(sections[Number(select.value)]); saveProfile(); setTimeout(render, 0); });
      return select;
    })();
    const boxes = el("div", { class: "multi" }, names.map((name) => {
      const box = el("input", { type: "checkbox", checked: c.counts.includes(name), "data-focus-key": `cand-${i}-count-${name}` });
      box.addEventListener("change", () => {
        c.counts = box.checked ? [...new Set([...c.counts, name])] : c.counts.filter((x) => x !== name);
        saveProfile();
        setTimeout(render, 0);
      });
      return el("label", {}, box, name);
    }));
    return el("tr", {},
      el("td", {}, codeInput, detected && el("span", { class: "sub detected" }, detected.note.join("・"))),
      el("td", {}, profileInput(c, "title", `cand-${i}-title`, { "aria-label": "課名" })),
      el("td", {}, profileInput(c, "credits", `cand-${i}-credits`, { type: "number", min: "0", inputmode: "numeric", "aria-label": "學分" })),
      el("td", {}, groupSelect, profileInput(c, "time", `cand-${i}-time`, { placeholder: "二2-4", "aria-label": "時間" }),
        c.time && !parseTime(c.time).length && el("span", { class: "sub missing" }, "看不懂這個時間")),
      el("td", {}, boxes),
      el("td", {}, removeButton(p.candidates, i)));
  });

  const exportData = () => downloadBlob(new Blob([JSON.stringify(p, null, 2)], { type: "application/json" }), `排課資料-${today()}.json`);
  return [
    section("my-data", "我的資料",
      el("div", { class: "planner-picks" },
        el("label", {}, "科系 ", deptSelect),
        yearSelect && el("label", {}, "入學 ", yearSelect),
        curriculum && el("button", { type: "button", class: "mini primary", onclick: applyThresholds }, "套用畢業門檻"),
        el("button", { type: "button", class: "mini", onclick: exportData }, "匯出"),
        el("button", { type: "button", class: "mini", onclick: () => importInput.click() }, "匯入"),
        el("button", { type: "button", class: "mini", onclick: () => {
          if (!confirm("清除這台瀏覽器裡的排課資料？")) return;
          plannerState.profile = defaultProfile();
          saveProfile();
          render();
        } }, "全部清除"),
        importInput),
      curriculum && el("p", { class: "hint" }, "依據：", curriculum.url ? el("a", { href: safeUrl(curriculum.url), target: "_blank", rel: "noopener" }, curriculum.source) : curriculum.source,
        curriculum.notes?.length ? `（${curriculum.notes.join("；")}）` : ""),
      dept?.missingYears?.length && el("p", { class: "hint" }, `${dept.missingYears.join("、")} 學年度入學的官方文件還沒找到，暫時無法套用；請手動填門檻或選相近年度。`),
      el("p", { class: "hint" }, "資料只存在這台瀏覽器，不會上傳。換電腦或分享給同學請用「匯出／匯入」。")),
    section("my-needs", "畢業門檻與已修學分",
      el("p", { class: "hint" }, "「已修」請填已修過加上這學期正在修的學分；還缺 = 門檻 − 已修。超修的學分（例如系選修超過門檻）可以自己挪到「自由學分」的已修。"),
      table(["類別", "畢業門檻", "已修", "還缺", ""], needRows),
      addButton("＋ 新增類別", () => p.needs.push({ name: "", required: "", done: "" }))),
    section("my-limits", "類別門數上限",
      table(["類別", "最多幾門", ""], limitRows),
      addButton("＋ 新增限制", () => p.limits.push({ category: names[0] ?? "", max: "1" }))),
    section("my-candidates", "編輯候選課程",
      el("p", { class: "hint" }, `輸入課號後按 Enter 或點別處：會依 ${plannerState.lookups.offerings?.term ?? ""} 開課資料帶出課名、老師、時間（有多組可選組別），通識課依官方總表勾領域，體育（00UP）與已選科系的課也會自動分類。時間也可以手動改，寫星期＋節次，例如「二2-4」「三A-C」。`),
      table(["課號", "課名", "學分", "時間", "算入", ""], candidateRows),
      addButton("＋ 新增候選課", () => p.candidates.push({ code: "", title: "", credits: "", time: "", counts: [] }))),
  ];
}

function ensureLookups() {
  if (plannerState.lookups) return true;
  plannerState.loading ??= loadLookups()
    .then((lookups) => { plannerState.lookups = lookups; render(); })
    .catch((error) => { plannerState.lookups = { ge: { courses: {} }, depts: {}, offerings: null }; console.error(error); render(); });
  return false;
}

function plannerPage() {
  site.planner ??= { term: "", candidates: [] };
  const planner = site.planner;
  if (!ensureLookups()) return [el("p", { class: "empty-note" }, "載入課號資料中…")];
  if (isEditing) {
    const labels = requirementOptions();
    const editCtx = {
      candidates: planner.candidates,
      catalogTags: (code) => nolanOptionsFor(code).map((o) => (o === "基本能力課程" ? "體育" : labels.find((l) => l.id === o)?.label ?? o)),
      addOffering: (code) => { planner.candidates.push(...offeringRows(code, (c) => nolanOptionsFor(c).join("|"), new Set(planner.candidates.map(candidateKey)))); markDirty(true); },
      catalogNote: "加入後記得按下方「儲存到 GitHub」。",
    };
    return [
      el("section", { class: "sec", id: "settings" }, el("h2", {}, "排課設定（Nolan 版）"),
        kvTable(planner, [{ field: "term", label: "學期" }])),
      section("limits", "類別門數上限", dataTable({
        list: planner.limits ??= [],
        fields: [
          { field: "category", label: "類別", kind: "select", options: requirementOptions },
          { field: "max", label: "最多幾門" }, { field: "note", label: "說明" },
        ],
        newRow: () => ({ category: requirementOptions()[0]?.id ?? "", max: "1", note: "" }),
      })),
      section("candidates", "候選課程", dataTable({
        list: planner.candidates,
        fields: [
          { field: "code", label: "課號" }, { field: "group", label: "組別" },
          { field: "title", label: "課程" }, { field: "teacher", label: "老師" }, { field: "room", label: "地點" },
          { field: "credits", label: "學分" }, { field: "counts", label: "算入（可複選）", kind: "multi", options: requirementOptions }, { field: "time", label: "時間（例：二2-4）" },
        ],
        newRow: () => ({ code: "", group: "", title: "", teacher: "", room: "", credits: "", counts: "", time: "" }),
      })),
      catalogPanel(editCtx, (code) => editCtx.addOffering(code)),
    ].filter(Boolean);
  }
  plannerState.layer ??= readStore(STORAGE.layer, "nolan") === "ntnu" ? "ntnu" : "nolan";
  if (plannerState.layer === "nolan") return plannerView(nolanContext());
  plannerState.profile ??= loadProfile();
  return [...plannerView(ntnuContext()), ...ntnuEditors()];
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
  document.querySelectorAll("main table:not(.timetable) tbody tr, main .card").forEach((tr) => {
    const matchKeyword = !keyword || tr.textContent.toLowerCase().includes(keyword);
    const matchTag = !activeTag || (tr.dataset.tags ?? "").split("|").includes(activeTag);
    tr.classList.toggle("is-hidden", !(matchKeyword && matchTag));
  });
  document.querySelectorAll("main .sec[data-filterable]").forEach((sec) => {
    const rows = [...sec.querySelectorAll("table:not(.timetable) tbody tr, .card")];
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
  // 重畫後把游標放回原本的欄位（表單編輯時用）
  const focusKey = document.activeElement?.dataset?.focusKey;
  const builders = { profile: profilePage, research: researchPage, planner: plannerPage, tools: toolsPage, library: libraryPage };
  const main = document.getElementById("main");
  main.replaceChildren(...builders[page]());
  document.getElementById("toc").replaceChildren(...[...main.querySelectorAll(".sec[id]")]
    .filter((sec) => sec.querySelector("h2"))
    .map((sec) => el("li", {}, el("a", { href: `#${sec.id}` }, sec.querySelector("h2").firstChild.textContent.split("・")[0]))));
  applyFilter();
  if (focusKey) document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
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
    const { sha, content } = await current.json();
    // 不論頁面是從哪裡載入的，都拿 GitHub 上的現況和開啟時的內容比對，避免舊頁面蓋掉別人剛存的修改
    if (normalizeJson(fromBase64(content)) !== loadedSnapshot) {
      const overwrite = confirm("GitHub 上的內容比你開啟這頁時還新（可能有人剛存過）。\n\n按「取消」：先下載你的版本，再重新整理頁面合併（建議）\n按「確定」：直接覆蓋，對方的修改會消失");
      if (!overwrite) {
        downloadBlob(new Blob([serialize()], { type: "application/json" }), "site-我的版本.json");
        setStatus("已取消儲存：你的版本已下載，請重新整理後再改", "err");
        return;
      }
    }
    site.updated = today();
    const response = await ghFetch(token, {
      method: "PUT",
      body: JSON.stringify({ message: "透過編輯模式更新網站內容", content: toBase64(serialize()), sha, branch: REPO.branch }),
    });
    if (!response.ok) throw new Error(explainGithubError(response.status));
    loadedSnapshot = normalizeJson(serialize());
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
  loadedSnapshot = JSON.stringify(site);
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
