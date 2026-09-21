// Analytics tab (#/analytics): channel stats for every connected account. YouTube channels come from
// analytics/ (public Data API + this app's own daily history); Instagram numbers come from the Instagram
// module's insights by way of /api/performance. Owned by the ANALYTICS session.
const API = "/api/analytics";
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const svg = (body, size = 15) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  plus: svg(`<path d="M12 5v14M5 12h14"/>`),
  refresh: svg(`<path d="M20 11a8 8 0 1 0-1.6 5.6"/><path d="M20 5v6h-6"/>`),
  eye: svg(`<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.7"/>`, 17),
  close: svg(`<path d="M6 6l12 12M18 6 6 18"/>`, 16),
  link: svg(`<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>`, 13),
  search: svg(`<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>`, 16),
  trash: svg(`<path d="M5 7h14M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7M7 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7"/>`, 14),
};

const RANGES = [["7d", "7D"], ["30d", "30D"], ["3m", "3M"], ["6m", "6M"], ["1y", "1Y"]];
const MAX_COMPARE = 3;
const LINES = ["var(--info)", "var(--warn)", "var(--pending)"]; // competitor colours, in pick order

const state = {
  data: null,
  view: "youtube",
  selected: null,
  compare: [],
  compareMine: false,
  grain: "daily",
  range: "7d",
  metric: "views",
  sort: "recent",
  ig: null,
};

// ---------------------------------------------------------------------------
// Formatting

const full = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US") : "—");
const compact = (n) => {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${+(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${+(n / 1e3).toFixed(2)}K`;
  return String(Math.round(n));
};
const signed = (n) => (Number.isFinite(n) ? `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n)).toLocaleString("en-US")}` : "—");
const money = (n) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString("en-US")}` : "—");

function badge(percent) {
  if (!Number.isFinite(percent)) return "";
  const rounded = Math.abs(percent) >= 100 ? Math.round(percent) : Math.round(percent * 100) / 100;
  return `<em class="an-delta ${percent >= 0 ? "up" : "down"}">${percent >= 0 ? "+" : "−"}${Math.abs(rounded)}%</em>`;
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)} seconds`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} minutes`;
  return `${(seconds / 3600).toFixed(1)} hours`;
}

function cadence(perWeek) {
  if (!Number.isFinite(perWeek) || perWeek <= 0) return "No uploads lately";
  if (perWeek >= 1) return `~${perWeek < 10 ? perWeek.toFixed(1).replace(/\.0$/, "") : Math.round(perWeek)} uploads per week`;
  const perMonth = perWeek * 4.345;
  if (perMonth >= 1) return `~${perMonth.toFixed(1).replace(/\.0$/, "")} uploads per month`;
  return "Less than one upload a month";
}

const regions = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();
// The API reports a two-letter code; the public channel page reports the country's name already.
const country = (value) => {
  if (!value) return "Not set";
  if (!/^[A-Z]{2}$/.test(value)) return value;
  try {
    return regions?.of(value) || value;
  } catch {
    return value;
  }
};

const ago = (iso) => {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const dayLabel = (date) =>
  date.length === 7
    ? new Date(`${date}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" })
    : new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

async function api(url, { method = "GET", body } = {}) {
  const res = await fetch(API + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2600);
}

// ---------------------------------------------------------------------------
// Cards

const mine = () => (state.data?.channels || []).filter((c) => c.kind === "mine");
const competitors = () => (state.data?.channels || []).filter((c) => c.kind !== "mine");
const current = () => (state.data?.channels || []).find((c) => c.id === state.selected) || null;

function statCard({ label, value, note, sub, wide }) {
  return `<div class="an-card${wide ? " wide" : ""}">
    <span class="an-card-label">${esc(label)}</span>
    <div class="an-card-value">${value}${note || ""}</div>
    ${sub ? `<span class="an-card-sub">${sub}</span>` : ""}
  </div>`;
}

function gainedCard(channel) {
  const gained = channel.cards.viewsGained;
  if (!gained || gained.value == null) {
    return statCard({
      label: "Views gained (7 days)",
      value: `<b class="an-waiting">Collecting</b>`,
      sub: `Needs a second daily reading — ${channel.historyDays ? "one day recorded so far" : "the first was just taken"}`,
    });
  }
  return statCard({
    label: "Views gained (7 days)",
    value: `<b>${signed(gained.value)}</b>`,
    note: badge(gained.percent),
    sub: gained.partial
      ? `Over the ${gained.covered} day${gained.covered === 1 ? "" : "s"} recorded so far`
      : Number.isFinite(gained.percent)
        ? `vs ${signed(gained.previous)} the week before`
        : "",
  });
}

function headlineCards(channel) {
  const c = channel.cards;
  const subs = c.subscribers;
  return `
    <div class="an-cards">
      ${statCard({ label: "Total views", value: `<b>${full(c.totalViews.value)}</b>`, note: badge(c.totalViews.percent), sub: c.totalViews.percent == null ? "Growth shows once there's history" : "Last 30 days" })}
      ${gainedCard(channel)}
      ${statCard({
        label: "Subscribers",
        value: `<b>${subs.hidden ? "Hidden" : compact(subs.value)}</b>`,
        note: badge(subs.percent),
        sub: subs.gained?.value != null ? `${signed(subs.gained.value)} in ${subs.gained.partial ? `${subs.gained.covered}d` : "7 days"} · YouTube rounds this` : "YouTube rounds this to 3 digits",
      })}
      ${statCard({
        label: "Est. monthly earnings",
        value: `<b>${money(c.earnings.value)}</b>`,
        sub: `${compact(c.earnings.monthlyViews)} views/mo × $${c.earnings.rpm} RPM · from ${esc(c.earnings.from)}`,
      })}
    </div>
    <div class="an-cards four">
      ${statCard({ label: "Category", value: `<b>${esc(channel.category || "Not set")}</b>`, sub: channel.topics.slice(1, 3).join(" · ") })}
      ${statCard({ label: "Country", value: `<b>${esc(country(channel.country))}</b>`, sub: channel.startedAt ? `Started ${new Date(channel.startedAt).toLocaleDateString("en-US", { month: "short", year: "numeric" })}` : "" })}
      ${statCard({ label: "Videos published", value: `<b>${compact(c.videosPublished.value)}</b>`, sub: c.newUploads.count ? `${c.newUploads.count} in the last 7 days` : "None in the last 7 days" })}
      ${statCard({ label: "Avg. video length", value: `<b>${duration(c.avgVideoLength.seconds)}</b>`, sub: Number.isFinite(c.uploadFrequency.shortsShare) ? `${Math.round(c.uploadFrequency.shortsShare * 100)}% are Shorts-length` : "" })}
    </div>
    ${statCard({
      label: "Upload frequency",
      value: `<b>${cadence(c.uploadFrequency.perWeek)}</b>`,
      sub: c.newUploads.count ? `Those 7 days of uploads have ${full(c.newUploads.views)} views so far` : "",
      wide: true,
    })}`;
}

function competitorStrip() {
  const list = competitors();
  if (!list.length) {
    return `<div class="an-panel an-rivals">
      <span class="an-card-label">Competitors</span>
      <p class="muted small">Add the channels you measure yourself against — their stats sit next to yours and go on the same chart.</p>
      <button class="btn sm" data-act="add" data-kind="competitor">${ICON.plus} Add competitor</button>
    </div>`;
  }
  return `<div class="an-panel an-rivals">
    <span class="an-card-label">Competitors</span>
    <div class="an-rival-row">${list.map((c) => {
      const on = state.compare.includes(c.id);
      return `<div class="an-rival${c.id === state.selected ? " on" : ""}">
        <button class="an-rival-main" data-act="select" data-id="${esc(c.id)}">
          ${c.avatar ? `<img src="${esc(c.avatar)}" alt="" loading="lazy" />` : `<i class="an-avatar-fallback">${esc((c.title || "?").slice(0, 1))}</i>`}
          <span><b>${esc(c.title)}</b><em>${c.cards.subscribers.hidden ? "Subs hidden" : `${compact(c.cards.subscribers.value)} subscribers`}</em></span>
        </button>
        <button class="an-icon-btn${on ? " on" : ""}" data-act="compare" data-id="${esc(c.id)}" title="${on ? "Remove from the chart" : "Put on the chart"}">${ICON.eye}</button>
        <button class="an-icon-btn" data-act="remove" data-id="${esc(c.id)}" title="Stop tracking">${ICON.trash}</button>
      </div>`;
    }).join("")}</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Chart

/** Area + line chart of daily (or monthly) gains, with every compared channel drawn over it. */
function chartSvg(sets) {
  const W = 1000;
  const H = 260;
  const pad = { top: 18, right: 16, bottom: 26, left: 52 };
  const points = sets[0]?.points || [];
  if (points.length < 2) return null;

  // A little headroom so the busiest day isn't drawn flat against the top edge.
  const peak = Math.max(1, ...sets.flatMap((s) => s.points.map((p) => p.value)));
  const max = peak * 1.12;
  const min = Math.min(0, ...sets.flatMap((s) => s.points.map((p) => p.value)));
  const x = (i, n) => pad.left + (i / Math.max(1, n - 1)) * (W - pad.left - pad.right);
  const y = (v) => pad.top + (1 - (v - min) / Math.max(1, max - min)) * (H - pad.top - pad.bottom);

  const line = (set) => set.points.map((p, i) => `${i ? "L" : "M"}${x(i, set.points.length).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const grid = [peak, (peak + min) / 2, min].map((v) => `
    <line x1="${pad.left}" x2="${W - pad.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="an-grid" />
    <text x="${pad.left - 10}" y="${(y(v) + 4).toFixed(1)}" class="an-axis" text-anchor="end">${compact(v)}</text>`).join("");

  const ticks = points
    .map((p, i) => ({ p, i }))
    .filter((_, i, arr) => i === 0 || i === arr.length - 1 || i === Math.floor(arr.length / 2))
    .map(({ p, i }) => `<text x="${x(i, points.length).toFixed(1)}" y="${H - 6}" class="an-axis" text-anchor="${i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}">${dayLabel(p.date)}</text>`)
    .join("");

  const body = sets.map((set, n) => {
    const path = line(set);
    const area = n === 0 ? `<path d="${path} L${x(set.points.length - 1, set.points.length).toFixed(1)},${y(min).toFixed(1)} L${pad.left},${y(min).toFixed(1)} Z" class="an-area" />` : "";
    return `${area}<path d="${path}" class="an-line" style="stroke:${set.color}" />`;
  }).join("");

  const hover = points.map((p, i) => `<rect x="${(x(i, points.length) - (W / points.length) / 2).toFixed(1)}" y="0" width="${(W / points.length).toFixed(1)}" height="${H}" fill="transparent" data-i="${i}" />`).join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="an-svg" preserveAspectRatio="none" role="img">
    ${grid}${body}${ticks}
    <g class="an-hover">${hover}</g>
    <line class="an-cursor" x1="0" x2="0" y1="${pad.top}" y2="${H - pad.bottom}" hidden />
  </svg>`;
}

function chartPanel(sets, loading) {
  const total = sets[0]?.points.reduce((a, p) => a + p.value, 0) ?? null;
  const chart = loading ? null : chartSvg(sets);
  const legend = sets.length > 1
    ? `<div class="an-legend">${sets.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.title)}</span>`).join("")}</div>`
    : "";
  return `<div class="an-panel an-chart">
    <div class="an-chart-head">
      <div class="an-chart-title">${ICON.eye}<b>${state.metric === "subs" ? "Subscribers gained" : "Views gained"}</b><span class="an-chart-total">${signed(total)}</span></div>
      <div class="an-chart-controls">
        <div class="an-seg" data-seg="metric">
          <button data-value="views" class="${state.metric === "views" ? "on" : ""}">Views</button>
          <button data-value="subs" class="${state.metric === "subs" ? "on" : ""}">Subs</button>
        </div>
        <div class="an-seg" data-seg="grain">
          <button data-value="daily" class="${state.grain === "daily" ? "on" : ""}">Daily</button>
          <button data-value="monthly" class="${state.grain === "monthly" ? "on" : ""}">Monthly</button>
        </div>
        <div class="an-seg" data-seg="range">${RANGES.map(([id, label]) => `<button data-value="${id}" class="${state.range === id ? "on" : ""}">${label}</button>`).join("")}</div>
      </div>
    </div>
    ${legend}
    <div class="an-chart-body">
      ${chart || `<div class="an-chart-empty">${loading ? "Loading…" : `<b>The chart fills in from here.</b><span>Each daily reading adds a point — come back tomorrow for the first one.</span>`}</div>`}
      <div class="an-tip" hidden></div>
    </div>
  </div>`;
}


// ---------------------------------------------------------------------------
// What's working

/** A tiny bar sparkline of a video's daily views. */
function spark(series) {
  if (!series?.length) return `<span class="an-dim">—</span>`;
  const max = Math.max(1, ...series.map((p) => p.value));
  return `<span class="an-spark" title="${series.map((p) => `${dayLabel(p.date)}: ${signed(p.value)}`).join(" · ")}">${series
    .map((p) => `<i style="height:${Math.max(8, Math.round((p.value / max) * 100))}%"></i>`)
    .join("")}</span>`;
}

function moversPanel(insights) {
  if (!insights.tracked) {
    return `<div class="an-panel an-movers empty-ish">
      <span class="an-card-label">Moving today</span>
      <p class="muted small">Once a second day is recorded, this shows which videos are pulling the views right now — not which ones did well at some point.</p>
    </div>`;
  }
  if (!insights.movers.length) {
    return `<div class="an-panel an-movers empty-ish"><span class="an-card-label">Moving today</span><p class="muted small">No movement recorded since the last reading.</p></div>`;
  }
  return `<div class="an-panel an-movers">
    <span class="an-card-label">Moving today <em>${signed(insights.movingTotal)} views across ${insights.tracked} tracked videos</em></span>
    <div class="an-mover-row">${insights.movers.map((m) => `
      <a class="an-mover" href="https://www.youtube.com/watch?v=${esc(m.id)}" target="_blank" rel="noopener">
        ${m.thumb ? `<img src="${esc(m.thumb)}" alt="" loading="lazy" />` : ""}
        <b>${esc(m.title)}</b>
        <span class="an-mover-num">${signed(m.today)}<em>today</em></span>
        <span class="an-mover-meta">${full(m.views)} total${m.multiple ? ` · ${m.multiple}× typical` : ""}</span>
        ${spark(m.series)}
      </a>`).join("")}</div>
  </div>`;
}

function benchPanel(insights) {
  const b = insights.benchmarks;
  const g = insights.growth;
  const rows = [
    ["Typical video", b.medianViews == null ? "—" : `${full(b.medianViews)} views`, "Median, so one hit doesn't move it"],
    ["Typical pace", b.medianViewsPerDay == null ? "—" : `${full(b.medianViewsPerDay)} views/day`, "What every multiple below is measured against"],
    ["First-day views", b.firstDayViews == null ? "Not tracked yet" : full(b.firstDayViews), "Median across videos watched from publish"],
    ["Likes per 1,000 views", b.likesPer1k ?? "—", "Same yardstick for a big video and a small one"],
    ["Comments per 1,000 views", b.commentsPer1k ?? "—", "How much it actually starts conversations"],
    ["Channel pace", g.viewsPerDay == null ? "Building" : `${signed(g.viewsPerDay)} views/day`, g.covered ? `Measured over ${g.covered} day${g.covered === 1 ? "" : "s"}` : ""],
    ["Next 30 days", g.projected30 ? `${signed(g.projected30.views)} views${g.projected30.subs != null ? ` · ${signed(g.projected30.subs)} subs` : ""}` : "Building", "At the current rate"],
    ["Next milestone", g.milestone ? `${compact(g.milestone.target)} subs${g.milestone.days != null ? ` in ~${g.milestone.days} days` : ""}` : "—", g.milestone?.at ? new Date(g.milestone.at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "Needs a few days of subscriber history"],
  ];
  return `<div class="an-panel">
    <span class="an-card-label">This channel's own bar <em>${b.videos} videos read</em></span>
    <div class="an-bench">${rows.map(([label, value, note]) => `
      <div class="an-bench-row"><span>${esc(label)}</span><b>${typeof value === "number" ? full(value) : value}</b><em>${esc(note || "")}</em></div>`).join("")}</div>
  </div>`;
}

function groupBars(title, note, groups) {
  if (!groups?.length) return "";
  const max = Math.max(1, ...groups.map((g) => g.multiple || 0));
  return `<div class="an-panel an-groups">
    <span class="an-card-label">${esc(title)} <em>${esc(note)}</em></span>
    ${groups.map((g) => `
      <div class="an-group${g.thin ? " thin" : ""}">
        <span class="an-group-label">${esc(g.label)}<em>${g.count} video${g.count === 1 ? "" : "s"}${g.thin ? " · thin" : ""}</em></span>
        <span class="an-group-bar"><i style="width:${Math.round(((g.multiple || 0) / max) * 100)}%" class="${(g.multiple || 0) >= 1 ? "good" : ""}"></i></span>
        <b class="${(g.multiple || 0) >= 1 ? "good" : ""}">${g.multiple == null ? "—" : `${g.multiple}×`}</b>
      </div>`).join("")}
  </div>`;
}

function workingPanels(insights) {
  return `
    ${moversPanel(insights)}
    <div class="an-split">
      ${benchPanel(insights)}
      ${groupBars("Best length", "Views per day vs this channel's typical video", insights.lengths)}
    </div>
    <div class="an-split">
      ${groupBars("Best day to post", "By when the video went up", insights.byWeekday.slice(0, 7))}
      ${groupBars("Best time of day", "Local time of the upload", insights.hours)}
    </div>
    ${insights.titles.length ? groupBars("Title shapes that work", "Every title tested against the channel median", insights.titles) : ""}
    ${insights.tags.length ? groupBars("Tags that carry", "Tags used on at least three videos", insights.tags.slice(0, 8)) : ""}`;
}

// ---------------------------------------------------------------------------
// Videos

const SORTS = [["recent", "Newest"], ["today", "Moving today"], ["views", "Most views"], ["rate", "Views per day"], ["engagement", "Engagement"]];

function videoTable(channel) {
  const videos = [...(channel.videos || [])];
  if (!videos.length) return `<div class="empty">No videos read yet.</div>`;
  const sorters = {
    recent: (a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0),
    today: (a, b) => (b.today || 0) - (a.today || 0),
    views: (a, b) => b.views - a.views,
    rate: (a, b) => (b.viewsPerDay || 0) - (a.viewsPerDay || 0),
    engagement: (a, b) => (b.engagement || 0) - (a.engagement || 0),
  };
  videos.sort(sorters[state.sort] || sorters.recent);
  const median = channel.insights?.benchmarks?.medianViews || 0; // the same bar the panels above use

  return `<div class="an-panel an-videos">
    <div class="an-videos-head">
      <span class="an-card-label">Videos <em>${videos.length} read${median ? ` · median ${compact(median)} views` : ""}</em></span>
      <div class="an-seg" data-seg="sort">${SORTS.map(([id, label]) => `<button data-value="${id}" class="${state.sort === id ? "on" : ""}">${label}</button>`).join("")}</div>
    </div>
    <div class="an-table">
      <div class="an-row an-head"><span>Video</span><span>Published</span><span>Length</span><span>Views</span><span>Today</span><span>vs typical</span><span>Per day</span><span>Engagement</span></div>
      ${videos.slice(0, 50).map((v) => `
        <a class="an-row" href="${esc(v.url)}" target="_blank" rel="noopener">
          <span class="an-vid">${v.thumb ? `<img src="${esc(v.thumb)}" alt="" loading="lazy" />` : ""}<b>${esc(v.title)}</b></span>
          <span class="an-dim">${v.publishedAt ? new Date(v.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }) : "—"}</span>
          <span class="an-dim">${v.durationSec < 60 ? `${Math.round(v.durationSec)}s` : `${Math.floor(v.durationSec / 60)}:${String(Math.round(v.durationSec % 60)).padStart(2, "0")}`}</span>
          <span class="an-num${median && v.views >= median * 2 ? " good" : ""}">${full(v.views)}</span>
          <span class="an-num">${v.today == null ? `<em class="an-dim">—</em>` : signed(v.today)}</span>
          <span class="an-num${v.multiple >= 1.2 ? " good" : ""}">${v.multiple == null ? "—" : `${v.multiple}×`}</span>
          <span class="an-num">${full(v.viewsPerDay)}</span>
          <span class="an-num">${Number.isFinite(v.engagement) ? `${v.engagement.toFixed(1)}%` : "—"}</span>
        </a>`).join("")}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Instagram

function instagramView() {
  const ig = state.ig;
  if (!ig) return `<div class="loading">Loading…</div>`;
  if (!ig.accounts.length) {
    return `<div class="empty"><b>No Instagram account connected yet.</b><br />Connect one on the Accounts tab and its Reels insights show up here.</div>`;
  }
  const posts = ig.posts || [];
  const totals = posts.reduce((a, p) => ({ views: a.views + (p.views || 0), n: a.n + 1 }), { views: 0, n: 0 });
  const withRetention = posts.filter((p) => Number.isFinite(p.retention));
  return `
    <div class="an-cards">
      ${ig.accounts.map((a) => statCard({
        label: `@${esc(a.username || a.handle || "account")}`,
        value: `<b>${compact(a.followersCount ?? a.followers ?? NaN)}</b>`,
        sub: "Followers",
      })).join("")}
      ${statCard({ label: "Reels with insights", value: `<b>${totals.n}</b>`, sub: totals.n ? `${full(totals.views)} views in total` : "Insights arrive a day after posting" })}
      ${statCard({ label: "Avg. retention", value: `<b>${withRetention.length ? `${Math.round((withRetention.reduce((a, p) => a + p.retention, 0) / withRetention.length) * 100)}%` : "—"}</b>`, sub: "Watch time ÷ clip length" })}
    </div>
    ${posts.length ? `<div class="an-panel an-videos">
      <div class="an-videos-head"><span class="an-card-label">Posted clips <em>${posts.length}</em></span></div>
      <div class="an-table ig">
        <div class="an-row an-head"><span>Clip</span><span>Posted</span><span>Views</span><span>vs typical</span><span>Retention</span><span>Pick score</span></div>
        ${[...posts].sort((a, b) => (b.views || 0) - (a.views || 0)).map((p) => `
          <div class="an-row">
            <span class="an-vid"><b>${esc(p.title || "Clip")}</b></span>
            <span class="an-dim">${p.publishedAt ? new Date(p.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}</span>
            <span class="an-num">${full(p.views)}</span>
            <span class="an-num${p.relViews >= 1.2 ? " good" : ""}">${Number.isFinite(p.relViews) ? `${p.relViews.toFixed(2)}×` : "—"}</span>
            <span class="an-num">${Number.isFinite(p.retention) ? `${Math.round(p.retention * 100)}%` : "—"}</span>
            <span class="an-num">${p.pickScore ?? "—"}</span>
          </div>`).join("")}
      </div>
    </div>` : `<div class="empty">No Reel insights yet — they appear a day or so after the first post goes out.</div>`}`;
}

async function loadInstagram() {
  const [status, performance] = await Promise.all([
    fetch("/api/integrations/instagram/status").then((r) => (r.ok ? r.json() : { accounts: [] })).catch(() => ({ accounts: [] })),
    fetch("/api/performance").then((r) => (r.ok ? r.json() : { posts: [] })).catch(() => ({ posts: [] })),
  ]);
  state.ig = { accounts: status.accounts || [], posts: performance.posts || [] };
}

// ---------------------------------------------------------------------------
// Page

function sourceNote(channel) {
  const gaps = channel?.partial?.length ? channel.partial.join(" · ") : "the last 15 uploads only";
  return `<div class="an-panel an-setup">
    <b>Reading without an API key</b>
    <p class="muted small">These numbers come from what YouTube serves the public anyway — the channel's RSS feed and its About page. Totals, growth, gains and the chart are all real. What this route can't see: ${esc(gaps)}.</p>
    <p class="muted small">A free API key lifts that to 200 uploads with tags, comment counts and topics, and it never gets rate-limited. <button class="an-inline-btn" data-act="how">How to add one</button></p>
  </div>`;
}

function setupCard() {
  return `<div class="an-panel an-setup">
    <b>Add a free YouTube API key</b>
    <p class="muted">Everything works without one. A key just widens what can be read — 200 uploads instead of 15, plus tags, comment counts and topics — and avoids rate limits.</p>
    <ol class="muted small">
      <li>Open <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">Google Cloud → YouTube Data API v3</a> and enable it.</li>
      <li>Make an API key under <em>Credentials</em>.</li>
      <li>Put <code>YOUTUBE_API_KEY=…</code> in the app's <code>.env</code>, then restart.</li>
    </ol>
  </div>`;
}

function render(root) {
  const data = state.data;
  const channel = current();
  const youtube = state.view === "youtube";

  // Without a key the numbers still come in, just from a narrower source — say which, don't block.
  const keyless = data && !data.hasKey;

  $("#an-body", root).innerHTML = !youtube
    ? instagramView()
    : !data?.channels.length
      ? `<div class="empty"><b>No channel tracked yet.</b><br />Add your YouTube channel and the stats start building from today.${keyless ? "<br />No API key needed." : ""}<br /><br /><button class="btn primary" data-act="add" data-kind="mine">${ICON.plus} Add my channel</button></div>`
      : channel
          ? `${channel.error ? `<div class="an-error">${esc(channel.error.message)}</div>` : ""}
             ${headlineCards(channel)}
             ${competitorStrip()}
             ${chartPanel([], true)}
             ${channel.insights ? workingPanels(channel.insights) : ""}
             ${videoTable(channel)}
             ${keyless ? sourceNote(channel) : ""}`
          : `<div class="empty">Pick a channel above.</div>`;

  $("#an-switch", root).innerHTML = renderSwitch();
  $("#an-title", root).innerHTML = youtube && channel
    ? `Channel stats for <em>${esc(channel.title)}</em>${channel.handle ? ` <a class="an-handle" href="${esc(channel.url)}" target="_blank" rel="noopener">${esc(channel.handle)} ${ICON.link}</a>` : ""}`
    : youtube
      ? "Channel stats"
      : "Instagram";
  $("#an-updated", root).textContent = youtube && channel?.fetchedAt ? `Read ${ago(channel.fetchedAt)}` : "";

  if (youtube && channel) drawChart(root);
}

function renderSwitch() {
  const tabs = [];
  for (const c of mine()) {
    tabs.push(`<button class="an-tab${state.view === "youtube" && state.selected === c.id ? " on" : ""}" data-act="select" data-id="${esc(c.id)}">
      ${c.avatar ? `<img src="${esc(c.avatar)}" alt="" />` : `<i class="an-avatar-fallback">${esc((c.title || "?").slice(0, 1))}</i>`}
      <span><b>${esc(c.title)}</b><em>YouTube · ${c.cards.subscribers.hidden ? "subs hidden" : `${compact(c.cards.subscribers.value)} subs`}</em></span>
    </button>`);
  }
  for (const a of state.ig?.accounts || []) {
    tabs.push(`<button class="an-tab${state.view === "instagram" ? " on" : ""}" data-act="instagram">
      ${a.profilePictureUrl ? `<img src="${esc(a.profilePictureUrl)}" alt="" />` : `<i class="an-avatar-fallback">@</i>`}
      <span><b>@${esc(a.username || a.handle || "instagram")}</b><em>Instagram · ${compact(a.followersCount ?? a.followers ?? NaN)} followers</em></span>
    </button>`);
  }
  if (!tabs.length) return "";
  return tabs.join("");
}

async function drawChart(root) {
  const channel = current();
  if (!channel) return;
  const ids = [channel.id, ...state.compare.filter((id) => id !== channel.id).slice(0, MAX_COMPARE)];
  if (state.compareMine) for (const c of mine()) if (!ids.includes(c.id)) ids.push(c.id);

  const panel = $(".an-chart", root);
  const loaded = await Promise.all(ids.map((id) =>
    api(`/channels/${encodeURIComponent(id)}/series?metric=${state.metric}&grain=${state.grain}&range=${state.range}`).catch(() => null)));

  const byId = new Map((state.data?.channels || []).map((c) => [c.id, c]));
  const sets = loaded
    .map((s, i) => s && { title: byId.get(s.id)?.title || s.id, points: s.points, color: i === 0 ? "var(--accent)" : LINES[(i - 1) % LINES.length] })
    .filter(Boolean)
    .filter((s) => s.points.length);

  const html = chartPanel(sets.length ? sets : [{ title: channel.title, points: [], color: "var(--accent)" }], false);
  if (panel?.isConnected) panel.outerHTML = html;
  bindChartHover(root, sets);
}

/** Follow the pointer across the chart and read the day under it. */
function bindChartHover(root, sets) {
  const svgEl = $(".an-svg", root);
  const tip = $(".an-tip", root);
  if (!svgEl || !tip || !sets.length) return;
  const cursor = $(".an-cursor", svgEl);
  svgEl.addEventListener("mousemove", (e) => {
    const target = e.target.closest("[data-i]");
    if (!target) return;
    const i = Number(target.dataset.i);
    const box = svgEl.getBoundingClientRect();
    const x = Number(target.getAttribute("x")) + Number(target.getAttribute("width")) / 2;
    cursor.setAttribute("x1", x);
    cursor.setAttribute("x2", x);
    cursor.hidden = false;
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max((x / 1000) * box.width, 60), box.width - 60)}px`;
    tip.innerHTML = `<b>${dayLabel(sets[0].points[i].date)}</b>${sets.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.title)}<em>${signed(s.points[i]?.value)}</em></span>`).join("")}`;
  });
  svgEl.addEventListener("mouseleave", () => {
    cursor.hidden = true;
    tip.hidden = true;
  });
}

function addDialog(root, kind) {
  const wrap = document.createElement("div");
  wrap.className = "an-backdrop";
  wrap.innerHTML = `<div class="an-modal card">
    <div class="an-modal-head"><b>${kind === "mine" ? "Add your channel" : "Add a competitor"}</b><button class="an-icon-btn" data-close>${ICON.close}</button></div>
    <label class="field"><span>Channel link, @handle, or a link to one of its videos</span>
      <input id="an-input" placeholder="https://youtube.com/@drodellmiller" autocomplete="off" /></label>
    <p class="muted small">Stats start from today: totals are read straight away, and gains build as the days record. No API key needed.</p>
    <div class="an-modal-actions">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn primary" data-add>Add channel</button>
    </div>
  </div>`;
  root.append(wrap);
  const input = $("#an-input", wrap);
  input.focus();

  const close = () => wrap.remove();
  const submit = async () => {
    const value = input.value.trim();
    if (!value) return;
    const button = $("[data-add]", wrap);
    button.disabled = true;
    button.textContent = "Reading channel…";
    try {
      const { channel } = await api("/channels", { method: "POST", body: { input: value, kind } });
      close();
      toast(`Tracking ${channel.title}`);
      if (kind === "mine" || !state.selected) state.selected = channel.id;
      await refresh(root);
    } catch (err) {
      button.disabled = false;
      button.textContent = "Add channel";
      $(".an-modal", wrap).insertAdjacentHTML("beforeend", `<div class="an-error">${esc(err.message)}</div>`);
      $$(".an-error", wrap).slice(0, -1).forEach((el) => el.remove());
    }
  };
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest("[data-close]")) close();
    if (e.target.closest("[data-add]")) submit();
  });
  input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
}

async function refresh(root) {
  state.data = await api("/");
  const channels = state.data.channels;
  if (!channels.some((c) => c.id === state.selected)) state.selected = (mine()[0] || channels[0])?.id || null;
  if (state.selected) {
    const { channel } = await api(`/channels/${encodeURIComponent(state.selected)}`);
    Object.assign(channels.find((c) => c.id === channel.id), channel);
  }
  render(root);
}

export async function mountAnalytics(el) {
  el.innerHTML = `
    <div class="an-page">
      <div class="page-head">
        <div>
          <h1>Analytics</h1>
          <p class="muted">How every connected account is doing — channel totals, what they gained this week, and which videos carried it.</p>
        </div>
        <div class="head-actions">
          <span class="muted small" id="an-updated"></span>
          <button class="btn sm ghost" data-act="reload" title="Read every channel again now">${ICON.refresh} Refresh</button>
          <button class="btn" data-act="add" data-kind="competitor">${ICON.plus} Add competitor</button>
          <button class="btn primary" data-act="add" data-kind="mine">${ICON.plus} Add my channel</button>
        </div>
      </div>
      <div class="an-switch" id="an-switch"></div>
      <h2 class="an-h2" id="an-title">Channel stats</h2>
      <div id="an-body"><div class="loading">Loading…</div></div>
    </div>`;
  if (!$("link[data-analytics-css]")) {
    document.head.insertAdjacentHTML("beforeend", `<link rel="stylesheet" href="${API}/ui/analytics.css" data-analytics-css />`);
  }
  const root = $(".an-page", el);

  root.addEventListener("click", async (e) => {
    const seg = e.target.closest("[data-seg] button");
    if (seg) {
      const kind = seg.closest("[data-seg]").dataset.seg;
      state[kind] = seg.dataset.value;
      if (kind === "sort") return render(root);
      $$("[data-seg] button", root).forEach((b) => b.classList.toggle("on", b.dataset.value === state[b.closest("[data-seg]").dataset.seg]));
      return drawChart(root);
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const { id } = act.dataset;
    if (act.dataset.act === "add") return addDialog(root, act.dataset.kind);
    if (act.dataset.act === "how") {
      act.closest(".an-setup").outerHTML = setupCard();
      return;
    }
    if (act.dataset.act === "instagram") {
      state.view = "instagram";
      if (!state.ig) await loadInstagram();
      return render(root);
    }
    if (act.dataset.act === "select") {
      state.view = "youtube";
      state.selected = id;
      state.compare = state.compare.filter((c) => c !== id);
      return refresh(root);
    }
    if (act.dataset.act === "compare") {
      state.compare = state.compare.includes(id) ? state.compare.filter((c) => c !== id) : [...state.compare, id].slice(-MAX_COMPARE);
      return render(root);
    }
    if (act.dataset.act === "remove") {
      const channel = state.data.channels.find((c) => c.id === id);
      if (!confirm(`Stop tracking ${channel?.title || "this channel"}? Its recorded history is deleted too.`)) return;
      await api(`/channels/${encodeURIComponent(id)}`, { method: "DELETE" });
      state.compare = state.compare.filter((c) => c !== id);
      return refresh(root);
    }
    if (act.dataset.act === "reload") {
      act.disabled = true;
      try {
        await api("/refresh", { method: "POST" });
        await refresh(root);
        toast("Channels read again");
      } catch (err) {
        toast(err.message);
      }
      act.disabled = false;
    }
  });

  try {
    await loadInstagram();
    await refresh(root);
  } catch (err) {
    $("#an-body", root).innerHTML = `<div class="empty">Couldn't load analytics: ${esc(err.message)}</div>`;
  }
}
