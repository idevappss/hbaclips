# Integrations & API keys

Owned by the **APIs** session. Keys themselves live in the root `.env` (template: `.env.example`).

This module adds an **Integrations page** that shows whether the Claude key works and roughly how many **Claude credits are left**. It also provides a small credits chip for HBA Content Backend's top bar.

## How "credits left" works

Anthropic has no API that returns an account's remaining prepaid balance. The Usage & Cost Admin API reports spend, not balance, and it needs an organization Admin key, which individual accounts can't create. So:

1. The creator copies their balance from Console billing (https://platform.claude.com/settings/billing) and saves it on the page.
2. The module wraps the global `fetch` that the Anthropic SDK uses, so it sees every `POST /v1/messages` response from any part of the server (clip analysis, titles, dope edits, …). No changes are needed in those files.
   - Each response is priced from its `usage`, using the model's rates (cache writes and reads, fallback passes, web search). The cost is subtracted from the saved balance.
   - Responses reach their caller untouched.
3. If Anthropic answers "credit balance is too low", the page and the chip switch to **Out of credits** until a call succeeds again or a new balance is saved.

Calls made outside this server (other apps, the Console workbench) aren't seen. The page asks the creator to re-save their balance now and then.

State: `data/integrations/claude.json`, holding the saved balance, spend since then, and the last 50 calls. No keys are stored there, and `/status` returns only the key's last four characters.

## Wiring (ENGINE, one time)

`server.js`:

```js
import { createIntegrations } from "./integrations/index.js";

const integrations = createIntegrations({ dataDir: path.join(ROOT, "data", "integrations") });
app.use("/api/integrations", integrations.router);
```

Mount it before or after the Instagram router; the two don't share any paths. Create it once at startup, since it installs the fetch watcher.

`public/index.html`, top bar chip (optional):

```html
<span id="credits"></span>
<script type="module" src="/api/integrations/ui/credits.js"></script>
```

The chip reads "$18.42 credits left" (amber when low; red for out of credits, a missing key or a rejected key) and links to the page. Place the span wherever it fits; the script does nothing if the span is missing.

## HTTP API: `/api/integrations`

| Method & path | Purpose |
|---|---|
| `GET /` | The Integrations page |
| `GET /status` | `{ claude: { key: { state, hint }, credits: { balance, remainingUsd, low, spentUsd, calls, outOfCredits, creditError, lifetime, recent }, billingUrl, pricesChecked } }`. `key.state` is `valid`, `rejected`, `missing`, `token`, `unreachable` or `unknown`. The key is checked with the free models endpoint and the result is cached for 10 minutes. |
| `POST /claude/balance` | `{ amountUsd }` saves the Console balance and restarts the spend count |
| `GET /ui/credits.js` | Top-bar chip script |

Prices come from the pricing page (checked 2026-09-11) in `claude-usage.js`. Update `PRICES` if Anthropic changes them.

## Dev

```bash
node --test integrations/test
node integrations/dev.js   # preview on http://localhost:5192/api/integrations/ (separate ledger in data/integrations/dev)
```
