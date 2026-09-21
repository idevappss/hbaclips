# Instagram for HBA Clips

Posts scheduled clips to your Instagram Business or Creator accounts as Reels. HBA Clips's Scheduler decides *when*. This module handles *how*:

- connecting accounts
- uploading and publishing
- renewing tokens
- pulling insights

```
Scheduler tick ─► publish({ post, account, videoPath })
                    │  pre-flight (caption ≤ 2,200 chars, ≤ 30 hashtags, 3 s–15 min, ≤ 300 MB)
                    ├─► create Reels container ─► upload the MP4 (resumable, no public URL needed)
                    ├─► wait for Instagram to process it ─► media_publish
                    └─► { mediaId, permalink, publishedAt }
upkeep (every 10 min) ─► refresh 60-day tokens · pull views/reach/likes/comments/shares/saves
```

It uses the **Instagram API with Instagram Login** (`graph.instagram.com`), so no Facebook Page is needed.

## Connect an account

1. In the Instagram app, switch the account to **Business** or **Creator**.
2. At [developers.facebook.com/apps](https://developers.facebook.com/apps), create an app of type **Business** and add the **Instagram** product.
3. Under **Instagram → API setup with Instagram business login**, add the account and click **Generate token**. If Meta asks, add the account as a tester under App roles and accept the invite in Instagram.
4. Open **Scheduler → Accounts → Connect Instagram** (`/api/integrations/instagram/connect`), paste the token, and set that page's posting times and timezone.
5. In the Scheduler, the Instagram account's handle must match the connected username.

Apps that only post to accounts you own or manage don't need Meta's App Review.

### Optional: "Log in with Instagram" button

Set these in `.env`. The redirect URI must be HTTPS and exactly match the one registered under *Business login settings*, so a tunnel is the easiest way to get one locally.

```
IG_APP_ID=
IG_APP_SECRET=
IG_REDIRECT_URI=https://<your-host>/api/integrations/instagram/oauth/callback
```

## Good to know

- **Double posts:** nothing posts twice. Every step is saved, so retries, overlapping ticks and restarts resume the same upload or report the Reel that already went out.
- **Posting limit:** Instagram allows a limited number of API posts per account per 24 hours (currently 100). Hitting it gives a retryable error.
- **Where data lives:** tokens are in `data/instagram/instagram.json`, and upload snapshots in `data/instagram/uploads/` (deleted once posted). `data/` is git-ignored.
- **Security:** whoever can reach the server can post to your accounts, so keep it on localhost or put auth in front of it before exposing it.
- **Tests:** `node --test instagram/test/`

The integration contract with HBA Clips is in [`shared/CONTRACT.md`](../shared/CONTRACT.md).
