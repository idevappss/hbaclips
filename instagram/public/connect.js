const $ = (sel, el = document) => el.querySelector(sel);
const BASE = location.pathname.replace(/\/connect\/?$/, "");
const TIMEZONES = Intl.supportedValuesOf?.("timeZone") ?? [];
const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const state = { accounts: [] };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

async function api(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}/${pathname}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2400);
}

function flash(message, isError = false) {
  const el = $("#flash");
  el.textContent = message;
  el.classList.toggle("err", isError);
  el.hidden = false;
}

function accountType(type) {
  const t = String(type || "").toLowerCase();
  return t.includes("creator") ? "Creator" : t.includes("business") ? "Business" : "";
}

function tokenChip(a) {
  if (a.tokenError) return `<span class="chip error" title="${esc(a.tokenError)}">Reconnect needed</span>`;
  const days = Math.floor((Date.parse(a.tokenExpiresAt) - Date.now()) / 864e5);
  if (days < 0) return `<span class="chip error">Token expired</span>`;
  if (days <= 5 && !a.tokenExpiryEstimated) return `<span class="chip warn" title="Renews automatically">Token renews soon</span>`;
  return `<span class="chip done" title="Token renews automatically before it expires">Connected</span>`;
}

function timezoneOptions(selected) {
  const zones = TIMEZONES.includes(selected) ? TIMEZONES : [selected, ...TIMEZONES];
  return zones.map((z) => `<option value="${esc(z)}" ${z === selected ? "selected" : ""}>${esc(z.replace(/_/g, " "))}</option>`).join("");
}

function accountCard(a) {
  const meta = [a.name, accountType(a.accountType), a.followersCount != null ? `${compact.format(a.followersCount)} followers` : ""].filter(Boolean).join(" · ");
  const avatar = a.profilePictureUrl
    ? `<img class="ig-avatar" src="${esc(a.profilePictureUrl)}" alt="" referrerpolicy="no-referrer" />`
    : `<div class="ig-avatar">${esc((a.username || "?")[0].toUpperCase())}</div>`;
  return `
    <article class="card ig-account" data-id="${esc(a.id)}">
      <div class="ig-account-top">
        ${avatar}
        <div class="ig-who">
          <div class="ig-username">@${esc(a.username)}</div>
          <div class="ig-meta">${esc(meta)}</div>
        </div>
        ${tokenChip(a)}
        <div class="ig-actions">
          <button class="btn ghost sm" data-sync>Refresh</button>
          <button class="btn ghost sm danger" data-remove>Disconnect</button>
        </div>
      </div>
      <div class="ig-settings">
        <div class="ig-field">
          <span>Posting times <em>· used for "next open slot"</em></span>
          <div class="ig-slots">
            ${a.slots.map((s) => `<span class="ig-slot">${esc(s)}<button data-remove-slot="${esc(s)}" title="Remove ${esc(s)}" aria-label="Remove ${esc(s)}">×</button></span>`).join("")}
            <span class="ig-add-slot"><input type="time" data-new-slot aria-label="New posting time" /><button class="btn sm" data-add-slot>Add</button></span>
          </div>
        </div>
        <label class="ig-field"><span>Timezone</span><select data-timezone>${timezoneOptions(a.timeZone)}</select></label>
        <label class="ig-field"><span>Posts per day <em>· 0 = no cap</em></span><input type="number" min="0" max="50" step="1" value="${esc(a.dailyLimit)}" data-limit /></label>
      </div>
      ${a.tokenError ? `<p class="ig-note">Instagram rejected the saved token: ${esc(a.tokenError)} Paste a new token below to reconnect.</p>` : ""}
    </article>`;
}

function render() {
  const list = $("#accounts");
  $("#count").textContent = state.accounts.length ? String(state.accounts.length) : "";
  list.innerHTML = state.accounts.length
    ? state.accounts.map(accountCard).join("")
    : `<div class="ig-empty">No Instagram accounts connected yet. Add one below.</div>`;
}

async function save(id, patch, message = "Saved") {
  try {
    const updated = await api(`accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
    state.accounts = state.accounts.map((a) => (a.id === id ? updated : a));
    render();
    toast(message);
  } catch (err) {
    toast(err.message);
    render();
  }
}

$("#accounts").addEventListener("click", async (e) => {
  const card = e.target.closest("[data-id]");
  if (!card) return;
  const account = state.accounts.find((a) => a.id === card.dataset.id);

  const removeSlot = e.target.closest("[data-remove-slot]");
  if (removeSlot) return save(account.id, { slots: account.slots.filter((s) => s !== removeSlot.dataset.removeSlot) }, "Posting time removed");

  if (e.target.closest("[data-add-slot]")) {
    const value = $("[data-new-slot]", card).value;
    if (!value) return toast("Pick a time first");
    return save(account.id, { slots: [...account.slots, value] }, "Posting time added");
  }

  if (e.target.closest("[data-sync]")) {
    try {
      const updated = await api(`accounts/${encodeURIComponent(account.id)}/sync`, { method: "POST" });
      state.accounts = state.accounts.map((a) => (a.id === account.id ? updated : a));
      render();
      toast("Profile refreshed");
    } catch (err) {
      toast(err.message);
    }
  }

  if (e.target.closest("[data-remove]")) {
    if (!confirm(`Disconnect @${account.username}? Scheduled Instagram posts for it will fail until you reconnect. Nothing on Instagram is deleted.`)) return;
    try {
      await api(`accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
      state.accounts = state.accounts.filter((a) => a.id !== account.id);
      render();
      toast(`Disconnected @${account.username}`);
    } catch (err) {
      toast(err.message);
    }
  }
});

$("#accounts").addEventListener("change", (e) => {
  const card = e.target.closest("[data-id]");
  if (!card) return;
  if (e.target.matches("[data-timezone]")) save(card.dataset.id, { timeZone: e.target.value });
  if (e.target.matches("[data-limit]")) save(card.dataset.id, { dailyLimit: Number(e.target.value) });
});

$("#token-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const button = $("button", form);
  button.disabled = true;
  button.textContent = "Connecting…";
  try {
    const account = await api("accounts", { method: "POST", body: { accessToken: form.accessToken.value, timeZone: BROWSER_TZ } });
    state.accounts = [...state.accounts.filter((a) => a.id !== account.id), account];
    form.reset();
    render();
    flash(`Connected @${account.username}. In the Scheduler, give your Instagram account the handle @${account.username} so posts go here.`);
  } catch (err) {
    flash(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Connect";
  }
});

// ---------- boot ----------

const params = new URLSearchParams(location.search);
if (params.get("connected")) flash(`Connected @${params.get("connected")}.`);
if (params.get("error")) flash(params.get("error"), true);
if (params.size) history.replaceState(null, "", location.pathname);

try {
  const status = await api("status");
  state.accounts = status.accounts;
  $("#oauth").hidden = !status.oauth;
  render();
} catch (err) {
  $("#accounts").innerHTML = `<div class="ig-empty">Couldn't load accounts: ${esc(err.message)}</div>`;
}
