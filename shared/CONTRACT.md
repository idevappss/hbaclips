# HBA Content Backend ↔ Instagram integration contract

| Area | Owner | Files |
|---|---|---|
| Clip pipeline, library, scheduler queue + UI | ENGINE | `server.js`, `lib/`, `public/`, `data/scheduler.json` |
| Instagram connection, publishing, insights | SCHEDULER | `instagram/`, `data/instagram/` |

Neither side edits the other's files. Ask for hooks instead.

## Wiring (one-time, in `server.js`)

```js
import { createInstagramIntegration } from "./instagram/index.js";

const instagram = createInstagramIntegration({ dataDir: path.join(ROOT, "data", "instagram") });
app.use("/api/integrations/instagram", instagram.router);
PUBLISHERS.instagram = instagram.publish; // however lib/scheduler.js exposes registration
instagram.start(); // background token refresh + insights; instagram.stop() on shutdown
```

`dataDir` holds OAuth tokens, so keep `data/` out of git.

## Publisher

```js
const result = await instagram.publish({ post, account, videoPath });
// → { mediaId, permalink, publishedAt, username }
```

| Param | Meaning |
|---|---|
| `post` | HBA Content Backend post. The publisher reads `id`, `caption`, and optionally `thumbOffsetMs` (cover frame). |
| `account` | HBA Content Backend account with `platform: "instagram"`. It links to a connected Instagram login by `account.igUserId` if set, otherwise by `account.handle` matching the connected username (case-insensitive, leading `@` ignored). |
| `videoPath` | Absolute path to the finished MP4. No public URL is needed: the publisher uploads the local file with Instagram's resumable upload. |

- **On success** it resolves with the result above. Store `permalink` (and `mediaId`) on the target so the UI can link to the live Reel.
- **On failure** it throws an `Error` whose `message` is safe to show the user. `err.retryable === true` means the same call later may succeed (rate limit, processing still going, network). `false` means the post or connection needs fixing first. `err.code === "not_connected"` means the account has no connected Instagram login.
- **Before calling it**, `await instagram.canPublish(account)` tells you whether the account links to a connected login. When it's false, mark the target `"due"` for a manual post instead of calling `publish()`.
- **Duration:** 30 s to about 15 min, covering the upload plus Instagram's video processing.
- **Idempotent per `(post.id, account.id)`.** Progress is saved step by step, so calling again resumes the earlier attempt or returns its earlier result, never a second Reel. Concurrent calls for the same pair share one run.

### What the scheduler must do so nothing double-posts

1. **Before awaiting a publisher**, set the target to `status: "publishing"` and persist it. Ticks must only pick up `"scheduled"` targets.
2. **Don't let ticks overlap** (a simple in-progress flag), and **don't `await tick()` inside HTTP handlers**, because a publish can take minutes and would hold the request open.
3. **On startup**, put any target still in `"publishing"` back to `"scheduled"`. `publish()` will pick up where it left off or report the post that already went out.
4. Rescheduling a failed target and calling `publish()` again with the same `post.id` is safe.

## Composer helpers

```js
instagram.checkReel({ caption, videoPath }) // → { ok, errors: string[], warnings: string[], media }
instagram.suggestTimes({ account, taken, count = 3 }) // → ISO strings; taken = ISO times already booked for that account
```

- `checkReel` enforces Instagram's Reels limits:
  - caption at most 2,200 characters including hashtags
  - at most 30 hashtags and 20 @mentions
  - 3 s to 15 min long, at most 300 MB
  - it warns for non-9:16 video or fps outside 23–60
- `suggestTimes` uses the posting slots, timezone and daily cap the user set for that Instagram account, and falls back to 09:00 / 13:00 / 19:00 in the server's timezone.

## HTTP API: `/api/integrations/instagram`

| Method & path | Purpose |
|---|---|
| `GET /connect` | Self-contained page to connect accounts and edit posting slots. Link to it from the Scheduler tab. |
| `GET /status` | `{ oauth, limits, accounts }`. Accounts never include tokens. |
| `GET /accounts` | Connected Instagram accounts. |
| `POST /accounts` | `{ accessToken, timeZone? }`. Connects via a token generated in the Meta App Dashboard. |
| `PATCH /accounts/:igUserId` | `{ slots: ["09:00", …], timeZone, dailyLimit }` |
| `POST /accounts/:igUserId/sync` | Re-reads username, avatar and follower count. |
| `DELETE /accounts/:igUserId` | Forgets the token locally. Instagram itself is untouched. |
| `GET /oauth/start`, `GET /oauth/callback` | Instagram Business Login. Needs `IG_APP_ID`, `IG_APP_SECRET`, `IG_REDIRECT_URI`. |
| `POST /check` | `{ caption, videoPath }` or `{ caption, projectId, file }`, then the `checkReel` result. |
| `GET /suggested-times?handle=&igUserId=&taken=ISO,ISO&count=` | `{ times: [ISO…] }` for the Instagram account with that handle or id. |
| `GET /publications?postId=` | Per-target publish records: `{ postId, accountId, status, permalink, publishedAt, error, insights, insightsAt }` |
| `POST /publications/:postId/:accountId/insights` | Refresh views / reach / likes / comments / shares / saves now. |

## Environment

```
IG_APP_ID=            # Meta app (type Business) → Instagram → API setup with Instagram login
IG_APP_SECRET=
IG_REDIRECT_URI=      # https://<public host>/api/integrations/instagram/oauth/callback (Meta requires an exact match)
IG_API_VERSION=v25.0  # optional
```

OAuth is optional. Tokens pasted from the App Dashboard work without any of these, and they're refreshed automatically before their 60-day expiry.
