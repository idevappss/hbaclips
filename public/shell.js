// App shell (Design session): search / ⌘K, mobile sidebar, credits bar and the account row.
// Page content is app.js's job; this file only drives the frame around it.
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const getJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))));

// ---------- mobile sidebar ----------
const setNav = (open) => document.body.classList.toggle("nav-open", open);
$("#menu-btn").onclick = () => setNav(!document.body.classList.contains("nav-open"));
$("#scrim").onclick = () => setNav(false);
window.addEventListener("hashchange", () => setNav(false));

// Library links point at scheduler tabs; mark the one that matches the current URL.
const markLibrary = () => {
  for (const a of document.querySelectorAll('.nav[aria-label="Library"] a')) {
    a.classList.toggle("on", a.getAttribute("href") === location.hash);
  }
};
window.addEventListener("hashchange", markLibrary);
markLibrary();

// ---------- search ----------
const PAGES = [
  ["Home", "#/", "Upload a video"],
  ["Projects", "#/projects", "Every video"],
  ["Study", "#/study", "References and taste"],
  ["Titles", "#/titles", "Saved titles and ideas"],
  ["Sounds", "#/sounds", "Music library"],
  ["Assets", "#/assets", "Brand kit and resources"],
  ["Scheduler", "#/scheduler", "Review clips"],
  ["Calendar", "#/scheduler?tab=calendar", "Scheduled posts"],
  ["Accounts", "#/scheduler?tab=accounts", "Posting accounts"],
  ["Integrations", "/api/integrations/", "Keys and credits"],
];
const input = $("#search-input");
const box = $("#search-results");
let index = { at: 0, items: [] };
let active = 0;

async function loadIndex() {
  if (Date.now() - index.at < 30_000) return index.items;
  const [projects, library] = await Promise.all([getJson("/api/projects").catch(() => []), getJson("/api/library").catch(() => [])]);
  index = {
    at: Date.now(),
    items: [
      ...projects.map((p) => ({ kind: "Project", label: p.name, sub: p.clipCount ? `${p.clipCount} clips` : p.status, href: `#/p/${p.id}` })),
      ...library.map((c) => ({ kind: "Clip", label: c.title || c.postTitle || "Clip", sub: c.projectName, href: `#/p/${c.projectId}` })),
      ...PAGES.map(([label, href, sub]) => ({ kind: "Page", label, sub, href })),
    ],
  };
  return index.items;
}

async function renderResults() {
  const q = input.value.trim().toLowerCase();
  const items = await loadIndex();
  const hits = (q ? items.filter((it) => `${it.label} ${it.sub}`.toLowerCase().includes(q)) : items.filter((it) => it.kind !== "Clip")).slice(0, 8);
  active = Math.min(active, Math.max(hits.length - 1, 0));
  box.innerHTML = hits.length
    ? hits
        .map((it, i) => `<a href="${esc(it.href)}" class="${i === active ? "on" : ""}"><span class="sr-kind">${it.kind}</span><span class="sr-label">${esc(it.label)}</span><span class="sr-sub">${esc(it.sub || "")}</span></a>`)
        .join("")
    : `<p class="sr-empty">Nothing matches “${esc(input.value)}”</p>`;
  box.hidden = false;
}

const closeSearch = () => {
  box.hidden = true;
  active = 0;
};
input.addEventListener("focus", renderResults);
input.addEventListener("input", () => {
  active = 0;
  renderResults();
});
input.addEventListener("keydown", (e) => {
  const links = [...box.querySelectorAll("a")];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!links.length) return;
    active = (active + (e.key === "ArrowDown" ? 1 : -1) + links.length) % links.length;
    links.forEach((a, i) => a.classList.toggle("on", i === active));
  } else if (e.key === "Enter") {
    links[active]?.click();
  } else if (e.key === "Escape") {
    input.blur();
  }
});
box.addEventListener("click", (e) => {
  if (e.target.closest("a")) {
    input.value = "";
    input.blur();
    closeSearch();
  }
});
input.addEventListener("blur", () => setTimeout(closeSearch, 150));
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    input.focus();
    input.select();
  }
});
if (!/Mac|iPhone|iPad/.test(navigator.platform)) $(".search kbd").textContent = "Ctrl K";

// ---------- credits bar (the text itself comes from integrations' credits.js) ----------
async function refreshCredits() {
  try {
    const { credits } = (await getJson("/api/integrations/status")).claude;
    const bar = $("#credits-bar");
    const total = credits?.balance?.amountUsd;
    bar.hidden = !total;
    if (total) {
      const pct = Math.max(0, Math.min(100, (100 * credits.remainingUsd) / total));
      $("i", bar).style.width = `${pct}%`;
      bar.classList.toggle("low", Boolean(credits.low));
    }
  } catch {
    $("#credits-bar").hidden = true;
  }
}
refreshCredits();
setInterval(refreshCredits, 60_000);

// ---------- account row ----------
async function refreshAccount() {
  const el = $("#sidebar-account");
  const accounts = await getJson("/api/accounts").catch(() => []);
  if (!accounts.length) {
    el.hidden = false;
    el.innerHTML = `<span class="sa-avatar">+</span><span class="sa-text"><b>Add an account</b><small>To schedule posts</small></span>`;
    return;
  }
  const a = accounts[0];
  const name = a.handle ? `@${a.handle.replace(/^@/, "").toLowerCase()}` : a.name;
  const initials = (a.name || a.handle || "?").replace(/^@/, "").slice(0, 2).toUpperCase();
  const platform = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", x: "X", facebook: "Facebook", linkedin: "LinkedIn" }[a.platform] || "Account";
  el.hidden = false;
  el.innerHTML = `<span class="sa-avatar">${esc(initials)}</span><span class="sa-text"><b>${esc(name)}</b><small>${platform}${accounts.length > 1 ? ` · +${accounts.length - 1} more` : ""}</small></span><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6" /></svg>`;
}
refreshAccount();
