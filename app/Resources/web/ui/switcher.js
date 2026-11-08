// Quick Switcher. Talks to the app through webkit.messageHandlers.app; the app calls App.receive().
//   app → page: {type: "open", templates, recents, screens, cover, thumbs, actions}, {type: "actions", actions}
//   page → app: ready | apply {id, scope: "all" | "mouse"} | home {id} | action {id} | close

const $ = (id) => document.getElementById(id);
const post = (msg) => window.webkit?.messageHandlers?.app?.postMessage(msg);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const CAT_COLOR = {
  "Lyrics": "#c4432a", "Painting": "#6a3cb4", "Print & paper": "#e6dccb", "Objects": "#2c7a6b", "Calm": "#2f4f86", "Yours": "#b9821c",
};

const P = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  share: P('<path d="M8 2.5v8M5 5.3L8 2.5l3 2.8"/><path d="M4 7.5H3.5v6h9v-6H12"/>'),
  focus: P('<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/>'),
  earlier: P('<path d="M9.5 4L5.5 8l4 4"/><path d="M12.5 8H6"/>'),
  later: P('<path d="M6.5 4l4 4-4 4"/><path d="M3.5 8H10"/>'),
  pause: P('<path d="M6 4v8M10 4v8"/>'),
  resume: P('<path d="M5.5 3.8v8.4L12 8z"/>'),
  history: P('<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>'),
  home: P('<rect x="2" y="3" width="12" height="9" rx="1.5"/><path d="M6 14h4"/>'),
  screen: P('<rect x="2" y="3" width="12" height="8" rx="1.2"/><path d="M6 13.5h4M8 11v2.5"/>'),
};

const S = { templates: [], recents: [], screens: [], cover: "", thumbs: {}, actions: [], rows: [], sel: 0, query: "" };
const badThumbs = new Set();

window.App = {
  receive(msg) {
    if (msg.type === "open") {
      Object.assign(S, { templates: msg.templates || [], recents: msg.recents || [], screens: msg.screens || [], cover: msg.cover || "",
        thumbs: msg.thumbs || {}, actions: msg.actions || [] });
      document.documentElement.style.setProperty("--cover", S.cover ? `url("${S.cover}")` : "none");
      const q = $("query");
      q.value = msg.query || "";
      S.query = q.value;
      build(true);
      q.focus();
      q.select();
    } else if (msg.type === "actions") {
      S.actions = msg.actions || [];
      const keep = S.rows[S.sel] && S.rows[S.sel].key;
      build(false, keep);
    }
  },
};

// ---------- matching ----------

/** How well one query token matches a field: prefix > word start > anywhere > letters in order (names only). */
function tokenScore(tok, text, fuzzy) {
  const t = String(text || "").toLowerCase();
  if (!t) return 0;
  const i = t.indexOf(tok);
  if (i === 0) return 100;
  if (i > 0) return /[\s\-–(&/]/.test(t[i - 1]) ? 80 : 50;
  if (!fuzzy || tok.length < 2) return 0;
  let at = -1, gaps = 0;
  for (const ch of tok) {
    const n = t.indexOf(ch, at + 1);
    if (n < 0) return 0;
    if (at >= 0) gaps += n - at - 1;
    at = n;
  }
  return Math.max(4, 30 - gaps * 2);
}

/** Every token must hit somewhere; the name counts most, then category, then the description and keywords. */
function score(query, fields) {
  const toks = query.toLowerCase().split(/\s+/).filter(Boolean);
  let total = 0;
  for (const tok of toks) {
    const best = Math.max(tokenScore(tok, fields.name, true) * 3, tokenScore(tok, fields.cat, false) * 2,
      tokenScore(tok, fields.desc, false), tokenScore(tok, fields.keys, false) * 2);
    if (!best) return 0;
    total += best;
  }
  return total;
}

// ---------- rows ----------

function usedOn(id) { return S.screens.filter((s) => s.enabled !== false && s.template === id); }

function build(resetSel, keepKey) {
  const q = S.query.trim();
  const byID = Object.fromEntries(S.templates.map((t) => [t.id, t]));
  const tRow = (t) => ({ kind: "t", key: "t:" + t.id, t });
  const aRow = (a) => ({ kind: "a", key: "a:" + a.id, a });
  const sections = [];
  if (!q) {
    const recents = S.recents.filter((id) => byID[id]).slice(0, 4);
    if (recents.length) sections.push(["Recent", recents.map((id) => tRow(byID[id]))]);
    const rest = S.templates.filter((t) => !recents.includes(t.id));
    rest.sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));  // stable: favourites first, else store order
    sections.push([recents.length ? "All templates" : "Templates", rest.map(tRow)]);
    sections.push(["Actions", S.actions.map(aRow)]);
  } else {
    const ranked = (items, fields) => items.map((x) => [x, score(q, fields(x))]).filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1]).map(([x]) => x);
    const ts = ranked(S.templates, (t) => ({ name: t.name, cat: t.category, desc: t.description }));
    const as = ranked(S.actions, (a) => ({ name: a.title, desc: a.desc, keys: a.keywords }));
    // the section with the better top hit goes first
    const tTop = ts.length ? score(q, { name: ts[0].name, cat: ts[0].category, desc: ts[0].description }) : 0;
    const aTop = as.length ? score(q, { name: as[0].title, desc: as[0].desc, keys: as[0].keywords }) : 0;
    const tSec = ["Templates", ts.map(tRow)], aSec = ["Actions", as.map(aRow)];
    sections.push(...(aTop > tTop ? [aSec, tSec] : [tSec, aSec]));
  }

  S.rows = [];
  const html = [];
  for (const [label, rows] of sections) {
    if (!rows.length) continue;
    html.push(`<div class="lbl" role="presentation">${esc(label)}</div>`);
    for (const r of rows) {
      const i = S.rows.length;
      S.rows.push(r);
      html.push(r.kind === "t" ? templateRow(r.t, i) : actionRow(r.a, i));
    }
  }
  const list = $("list");
  list.innerHTML = html.length ? html.join("") : `<div class="empty">Nothing matches “${esc(q)}”.</div>`;
  hookThumbs(list);
  let sel = 0;
  if (!resetSel && keepKey) sel = Math.max(0, S.rows.findIndex((r) => r.key === keepKey));
  if (resetSel) list.scrollTop = 0;
  select(sel, true);
}

function thumb(t, big) {
  const c = CAT_COLOR[t.category] || "#444";
  const url = S.thumbs[t.id];
  const img = url && !badThumbs.has(url) ? `<img alt="" src="${esc(url)}" data-url="${esc(url)}">` : "";
  return `<div class="th${t.category === "Print & paper" ? " paper" : ""}" style="--c:${c}"><div class="wash"></div><div class="cv"></div>` +
    `${big ? `<span class="lt">${esc(t.category)}</span>` : ""}${img}</div>`;
}

/** A thumbnail fades in over its tile once it loads; one that 404s (not rendered yet) leaves the tile. */
function hookThumbs(root) {
  for (const img of root.querySelectorAll(".th img")) {
    const ok = () => img.classList.add("ok");
    const bad = () => { badThumbs.add(img.dataset.url); img.remove(); };
    if (img.complete) { img.naturalWidth ? ok() : bad(); } else { img.addEventListener("load", ok, { once: true }); img.addEventListener("error", bad, { once: true }); }
  }
}

function templateRow(t, i) {
  const used = usedOn(t.id), on = S.screens.filter((s) => s.enabled !== false).length;
  let where = "";
  if (used.length && used.length === on) where = " · <b>On your desktop</b>";
  else if (used.length) where = ` · <b>On ${esc(used.map((s) => s.name).join(", "))}</b>`;
  return `<div class="row" role="option" id="r${i}" data-i="${i}">${thumb(t)}<div><div class="nm">${esc(t.name)}</div>` +
    `<div class="sub">${esc(t.category)}${where}</div></div><div class="end">${t.favorite ? '<span class="star" aria-label="Favourite">★</span>' : ""}<span class="ret">↩</span></div></div>`;
}

function actionRow(a, i) {
  return `<div class="row${a.enabled === false ? " off" : ""}" role="option" id="r${i}" data-i="${i}" aria-disabled="${a.enabled === false}">` +
    `<span class="ic">${ICON[a.icon] || ""}</span><div><div class="nm">${esc(a.title)}</div><div class="sub">${esc(a.sub || "")}</div></div>` +
    `<div class="end">${a.kbd ? `<span>${esc(a.kbd)}</span>` : '<span class="ret">↩</span>'}</div></div>`;
}

// ---------- selection & preview ----------

function select(i, scroll) {
  if (!S.rows.length) { S.sel = 0; renderPreview(); renderHints(); $("query").removeAttribute("aria-activedescendant"); return; }
  S.sel = Math.max(0, Math.min(S.rows.length - 1, i));
  for (const el of $("list").querySelectorAll(".row")) {
    el.classList.toggle("on", +el.dataset.i === S.sel);
    el.setAttribute("aria-selected", String(+el.dataset.i === S.sel));
  }
  const el = $("r" + S.sel);
  if (el) {
    $("query").setAttribute("aria-activedescendant", el.id);
    if (scroll) el.scrollIntoView({ block: "nearest" });
  }
  renderPreview();
  renderHints();
}

function renderPreview() {
  const r = S.rows[S.sel], box = $("prev");
  if (!r) { box.innerHTML = ""; return; }
  if (r.kind === "a") {
    box.innerHTML = `<div class="bigic">${ICON[r.a.icon] || ""}</div><div><h4>${esc(r.a.title)}</h4></div><p>${esc(r.a.desc || "")}</p>`;
    return;
  }
  const t = r.t;
  const screens = S.screens.length > 1 ? `<div class="screens"><div class="lbl">Screens</div>${S.screens.map((s) =>
    `<div class="scr${s.enabled !== false && s.template === t.id ? " use" : ""}">${ICON.screen}<span>${esc(s.name)}</span>${s.enabled === false ? '<span class="here">off</span>' : s.mouse ? '<span class="here">pointer</span>' : ""}</div>`).join("")}</div>`
    : `<div class="screens"><div class="scr${usedOn(t.id).length ? " use" : ""}">${ICON.screen}<span>${usedOn(t.id).length ? "On your desktop now" : "Not on your desktop"}</span></div></div>`;
  box.innerHTML = `${thumb(t, true)}<div><h4>${esc(t.name)}</h4><div class="cat" style="--c:${CAT_COLOR[t.category] || "#444"}"><i></i>${esc(t.category)}${t.favorite ? " · ★ Favourite" : ""}</div></div>` +
    `<p>${esc(t.description || "")}</p>${screens}`;
  hookThumbs(box);
}

function renderHints() {
  const r = S.rows[S.sel];
  let h;
  if (!r) h = "esc close";
  else if (r.kind === "a") h = "↑↓ move · <kbd>↩</kbd> run · esc close";
  else {
    const here = S.screens.find((s) => s.mouse);
    h = S.screens.length > 1
      ? `<kbd>↩</kbd> all screens · <kbd>⌥↩</kbd> ${esc(here ? here.name : "this screen")} · <kbd>⌘↩</kbd> open in Home`
      : "↑↓ move · <kbd>↩</kbd> use · <kbd>⌘↩</kbd> open in Home";
  }
  $("hints").innerHTML = h;
}

function run(r, mods) {
  if (!r) return;
  if (r.kind === "t") {
    if (mods.meta) post({ type: "home", id: r.t.id });
    else post({ type: "apply", id: r.t.id, scope: mods.alt && S.screens.length > 1 ? "mouse" : "all" });
  } else if (r.a.enabled !== false) {
    post({ type: "action", id: r.a.id });
  }
}

// ---------- input ----------

const q = $("query");
q.addEventListener("input", () => { S.query = q.value; build(true); });
q.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) { e.preventDefault(); select(S.sel + 1, true); }
  else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) { e.preventDefault(); select(S.sel - 1, true); }
  else if (e.key === "PageDown") { e.preventDefault(); select(S.sel + 6, true); }
  else if (e.key === "PageUp") { e.preventDefault(); select(S.sel - 6, true); }
  else if (e.key === "Enter") { e.preventDefault(); run(S.rows[S.sel], { alt: e.altKey, meta: e.metaKey }); }
  else if (e.key === "Escape") { e.preventDefault(); if (q.value) { q.value = ""; S.query = ""; build(true); } else post({ type: "close" }); }
  else if (e.key === "Tab") { e.preventDefault(); }
});
// keep typing going to the field even after a click elsewhere in the panel
document.addEventListener("mousedown", (e) => { if (e.target !== q) { e.preventDefault(); q.focus(); } });

// hover selects only when the pointer really moves (not when the list scrolls under a still pointer)
let lastPointer = "";
$("list").addEventListener("mousemove", (e) => {
  const p = e.screenX + "," + e.screenY;
  if (p === lastPointer) return;
  lastPointer = p;
  const row = e.target.closest(".row");
  if (row && +row.dataset.i !== S.sel) select(+row.dataset.i, false);
});
$("list").addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (row) { select(+row.dataset.i, false); run(S.rows[S.sel], { alt: e.altKey, meta: e.metaKey }); }
});

post({ type: "ready" });
