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
const PERIODS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "A", "B", "C"];
const PERIOD_TIMES = ["08:10", "09:10", "10:20", "11:20", "12:20", "13:20", "14:20", "15:30", "16:30", "17:30", "18:40", "19:35", "20:30"];
const DAYS = ["一", "二", "三", "四", "五"];
const plannerState = { mode: {}, pick: 0 };

// 「二2-4」「三A-C」，多段用逗號分隔
function parseTime(text) {
  const slots = [];
  for (const part of String(text ?? "").split(/[,，、\s]+/).filter(Boolean)) {
    const match = part.match(/^([一二三四五])([0-9]+|[A-C])(?:-([0-9]+|[A-C]))?$/);
    if (!match) continue;
    const from = PERIODS.indexOf(match[2]);
    const to = PERIODS.indexOf(match[3] ?? match[2]);
    if (from < 0 || to < from) continue;
    for (let i = from; i <= to; i++) slots.push(`${match[1]}${PERIODS[i]}`);
  }
  return slots;
}

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

function plannerCandidates() {
  const taken = new Set((site.courses ?? []).map((c) => c.title));
  return (site.planner?.candidates ?? []).map((c, id) => ({
    ...c,
    id,
    credits: Number(c.credits) || 0,
    slots: parseTime(c.time),
    options: String(c.counts ?? "").split("|").map((s) => s.trim()).filter(Boolean),
    taken: taken.has(c.title),
  }));
}

const candidateMode = (c) => plannerState.mode[c.id] ?? (c.taken ? "never" : "auto");

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

function solvePlanner(candidates, needs) {
  const pool = candidates.filter((c) => candidateMode(c) !== "never");
  const must = pool.filter((c) => candidateMode(c) === "must");
  const optional = pool.filter((c) => candidateMode(c) !== "must");
  const used = new Set();
  const chosen = [];
  let credits = 0;
  const conflicts = [];
  for (const c of must) {
    if (c.slots.some((s) => used.has(s))) conflicts.push(c.title);
    c.slots.forEach((s) => used.add(s));
    chosen.push(c);
    credits += c.credits;
  }
  const results = [];
  const walk = (i) => {
    if (i === optional.length) {
      const { coverage, assign } = bestAssignment(chosen, needs);
      const evening = chosen.reduce((n, c) => n + c.slots.filter((s) => /[A-C]$/.test(s)).length, 0);
      const days = new Set(chosen.flatMap((c) => c.slots.map((s) => s[0]))).size;
      results.push({ ids: chosen.map((c) => c.id), coverage, credits, evening, days, assign });
      return;
    }
    walk(i + 1);
    const c = optional[i];
    if (c.slots.some((s) => used.has(s))) return;
    c.slots.forEach((s) => used.add(s));
    chosen.push(c);
    credits += c.credits;
    walk(i + 1);
    chosen.pop();
    credits -= c.credits;
    c.slots.forEach((s) => used.delete(s));
  };
  walk(0);
  // 覆蓋最多 → 學分最少（不多修） → 晚上的課最少 → 上課天數最少
  results.sort((a, b) => b.coverage - a.coverage || a.credits - b.credits || a.evening - b.evening || a.days - b.days);
  return { results: results.slice(0, 6), conflicts };
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

function timetable(chosen, assign) {
  const at = new Map();
  for (const c of chosen) c.slots.forEach((s) => at.set(s, c));
  const lastUsed = Math.max(9, ...chosen.flatMap((c) => c.slots.map((s) => PERIODS.indexOf(s.slice(1)))));
  const skip = new Set();
  const body = PERIODS.slice(0, lastUsed + 1).map((period, row) => el("tr", {},
    el("th", { class: "tt-time" }, el("b", {}, period), el("small", {}, PERIOD_TIMES[row])),
    DAYS.map((day) => {
      const key = `${day}${period}`;
      if (skip.has(key)) return null;
      const c = at.get(key);
      if (!c) return el("td", {});
      let span = 1;
      while (row + span <= lastUsed && at.get(`${day}${PERIODS[row + span]}`) === c) { skip.add(`${day}${PERIODS[row + span]}`); span++; }
      const option = assign.get(c.id) ?? c.options[0];
      return el("td", { rowspan: span, class: "tt-course" },
        el("b", {}, c.title), c.room && el("span", {}, c.room), c.teacher && el("span", {}, c.teacher),
        el("span", { class: "tt-tag" }, `【${courseTag(option, c.credits)}】`));
    })));
  return el("div", { class: "tt-wrap" }, el("table", { class: "timetable" },
    el("thead", {}, el("tr", {}, el("th", {}, ""), DAYS.map((d) => el("th", {}, d)))), el("tbody", {}, body)));
}

function plannerPage() {
  site.planner ??= { term: "", candidates: [] };
  const planner = site.planner;
  if (isEditing) {
    return [
      el("section", { class: "sec", id: "settings" }, el("h2", {}, "排課設定"),
        kvTable(planner, [{ field: "term", label: "學期" }])),
      section("candidates", "候選課程", dataTable({
        list: planner.candidates,
        fields: [
          { field: "title", label: "課程" }, { field: "teacher", label: "老師" }, { field: "room", label: "地點" },
          { field: "credits", label: "學分" }, { field: "counts", label: "算入（可複選）", kind: "multi", options: requirementOptions }, { field: "time", label: "時間（例：二2-4）" },
        ],
        newRow: () => ({ title: "", teacher: "", room: "", credits: "", counts: "", time: "" }),
      })),
    ];
  }
  const needs = plannerNeeds();
  const candidates = plannerCandidates();
  const { results, conflicts } = solvePlanner(candidates, needs);
  const totalMissing = needs.reduce((sum, n) => sum + n.missing, 0);
  plannerState.pick = Math.min(plannerState.pick, Math.max(0, results.length - 1));
  const current = results[plannerState.pick];
  const chosen = current ? candidates.filter((c) => current.ids.includes(c.id)) : [];
  const assignment = current ? bestAssignment(chosen, needs) : { tally: {}, assign: new Map() };

  const settings = el("div", { class: "planner-bar" },
    el("b", {}, `${planner.term} 排課試算`),
    el("span", { class: "hint" }, `畢業還缺 ${totalMissing} 學分（不含 MOOCs）`));

  const picks = el("div", { class: "planner-picks" }, results.map((r, i) => el("button", {
    type: "button", class: `mini${i === plannerState.pick ? " primary" : ""}`,
    onclick: () => { plannerState.pick = i; render(); },
  }, `方案 ${i + 1}・補 ${r.coverage}/${totalMissing}・${r.credits} 學分`)));

  const needTable = dataTable({
    list: needs.map((n) => ({ ...n, got: Math.min(n.missing, assignment.tally[n.key] ?? 0) })),
    columns: [
      { label: "類別", view: (n) => n.label },
      { label: "還缺", className: "nowrap lbl", view: (n) => n.missing },
      { label: "這個方案補到", className: "nowrap lbl", view: (n) => (n.got >= n.missing ? "✓" : el("b", { class: "missing" }, `${n.got}（差 ${n.missing - n.got}）`)) },
    ],
  });

  const modeSelect = (c) => {
    const select = el("select", { class: "cell", "aria-label": `${c.title} 選課狀態` },
      el("option", { value: "auto" }, "自動"), el("option", { value: "must" }, "必選"), el("option", { value: "never" }, "排除"));
    select.value = candidateMode(c);
    select.addEventListener("change", () => { plannerState.mode[c.id] = select.value; plannerState.pick = 0; render(); });
    return select;
  };
  const candidateTable = dataTable({
    list: candidates,
    rowProps: (c) => ({ class: current?.ids.includes(c.id) ? "picked" : null }),
    columns: [
      { label: "課程", view: (c) => [el("b", {}, c.title), c.teacher && el("span", { class: "sub" }, c.teacher), c.taken && el("span", { class: "status-tag" }, "已修／修習中")] },
      { label: "時間", className: "nowrap", view: (c) => c.time },
      { label: "學分", className: "nowrap", view: (c) => c.credits },
      { label: "算入", view: (c) => c.options.map((id) => requirementOptions().find((o) => o.id === id)?.label ?? id).join("／") },
      { label: "", className: "nowrap", view: modeSelect },
    ],
  });

  return [
    settings,
    conflicts.length ? el("p", { class: "missing" }, `必選的課時間衝堂：${conflicts.join("、")}`) : null,
    section("plan", "建議方案", picks, current ? timetable(chosen, assignment.assign) : el("p", { class: "empty-note" }, "沒有可行的組合")),
    section("needs", "畢業缺口", needTable),
    section("candidates", "候選課程", el("p", { class: "hint" }, "時間格式：星期＋節次，例如「二2-4」「三A-C」；同一門課可算入多個類別時用「|」分隔。"), candidateTable),
  ].filter(Boolean);
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
  const builders = { profile: profilePage, research: researchPage, planner: plannerPage, tools: toolsPage, library: libraryPage };
  const main = document.getElementById("main");
  main.replaceChildren(...builders[page]());
  document.getElementById("toc").replaceChildren(...[...main.querySelectorAll(".sec[id]")]
    .filter((sec) => sec.querySelector("h2"))
    .map((sec) => el("li", {}, el("a", { href: `#${sec.id}` }, sec.querySelector("h2").firstChild.textContent.split("・")[0]))));
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
