// "Credits left" chip for HBA Clips's top bar. It renders into <span id="credits"></span> and links to the
// Integrations page. Include with: <script type="module" src="/api/integrations/ui/credits.js"></script>
const host = document.getElementById("credits");

const style = document.createElement("style");
style.textContent = `
  .credits-chip { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; white-space: nowrap; transition: color 0.15s, border-color 0.15s; }
  .credits-chip:hover { color: var(--text); border-color: var(--line-2); }
  .credits-chip b { color: var(--text); font-weight: 600; }
  .credits-chip.low b { color: var(--warn); }
  .credits-chip.bad, .credits-chip.bad b { color: var(--danger); }
`;

async function refresh() {
  try {
    const res = await fetch("/api/integrations/status");
    if (!res.ok) throw new Error(res.statusText);
    const { key, credits } = (await res.json()).claude;
    const chip = document.createElement("a");
    chip.href = "/api/integrations/";
    chip.className = "credits-chip";
    chip.title = "Claude credits left (estimate). Click for details.";
    const strong = document.createElement("b");
    chip.append(strong);
    if (key.state === "missing" || key.state === "rejected") {
      chip.classList.add("bad");
      strong.textContent = key.state === "missing" ? "Add Claude key" : "Claude key rejected";
    } else if (credits.outOfCredits) {
      chip.classList.add("bad");
      strong.textContent = "Out of Claude credits";
    } else if (credits.balance) {
      if (credits.low) chip.classList.add("low");
      strong.textContent = `$${credits.remainingUsd.toFixed(2)}`;
      chip.append("credits left");
    } else {
      strong.textContent = "Set Claude credits";
    }
    host.replaceChildren(chip);
  } catch {
    host.replaceChildren();
  }
}

if (host) {
  document.head.append(style);
  refresh();
  setInterval(refresh, 60_000);
  window.addEventListener("focus", refresh);
}
