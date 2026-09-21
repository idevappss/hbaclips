// Instagram API with Instagram Login (graph.instagram.com): posts to Business/Creator accounts, no Facebook Page needed.
// Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing
import fs from "node:fs";

const GRAPH = "https://graph.instagram.com";
const SCOPES = ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_insights"];
const REEL_METRICS = ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions", "ig_reels_avg_watch_time"];

export class InstagramError extends Error {
  constructor(body, status) {
    const e = body?.error || {};
    super(e.error_user_msg || e.message || `Instagram API error (HTTP ${status})`);
    this.name = "InstagramError";
    this.httpStatus = status;
    this.code = e.code;
    this.subcode = e.error_subcode;
    this.fbtraceId = e.fbtrace_id;
    // Bad tokens (190), missing permissions (10, 200) and invalid parameters (100) won't fix themselves on retry.
    this.permanent = !e.is_transient && [10, 100, 190, 200].includes(e.code);
  }
}

export function createInstagramClient({ appId, appSecret, redirectUri, apiVersion = "v25.0", fetch = globalThis.fetch } = {}) {
  const base = `${GRAPH}/${apiVersion}`;
  const igId = (account) => account.id || "me";

  async function call(url, { method = "GET", params = {}, headers, body } = {}) {
    const target = new URL(url);
    const form = method === "GET" || body ? null : new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      (form || target.searchParams).set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    const res = await fetch(target, { method, headers, body: body ?? form ?? undefined });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = res.ok ? {} : { error: { message: `Instagram returned HTTP ${res.status}: ${text.slice(0, 160)}` } };
    }
    if (!res.ok || data.error) throw new InstagramError(data, res.status);
    return data;
  }

  return {
    oauthConfigured: Boolean(appId && appSecret && redirectUri),

    authorizeUrl(state) {
      const url = new URL("https://www.instagram.com/oauth/authorize");
      url.search = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, response_type: "code", scope: SCOPES.join(","), state });
      return url.toString();
    },

    /** OAuth code → long-lived (60-day) token. */
    async exchangeCode(code) {
      const short = await call("https://api.instagram.com/oauth/access_token", {
        method: "POST",
        params: { client_id: appId, client_secret: appSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code },
      });
      return this.exchangeForLongLived(short.access_token);
    },

    async exchangeForLongLived(accessToken) {
      const long = await call(`${GRAPH}/access_token`, { params: { grant_type: "ig_exchange_token", client_secret: appSecret, access_token: accessToken } });
      return { accessToken: long.access_token, expiresIn: long.expires_in };
    },

    /** Only works on long-lived tokens that are at least 24 hours old and not yet expired. */
    async refreshToken(account) {
      const data = await call(`${GRAPH}/refresh_access_token`, { params: { grant_type: "ig_refresh_token", access_token: account.accessToken } });
      return { accessToken: data.access_token, expiresIn: data.expires_in };
    },

    async getProfile(accessToken) {
      const me = await call(`${base}/me`, {
        params: { fields: "user_id,username,name,account_type,profile_picture_url,followers_count,media_count", access_token: accessToken },
      });
      return {
        id: String(me.user_id || me.id),
        username: me.username,
        name: me.name || "",
        accountType: me.account_type || null,
        profilePictureUrl: me.profile_picture_url || null,
        followersCount: me.followers_count ?? null,
        mediaCount: me.media_count ?? null,
      };
    },

    async publishingLimit(account) {
      const since = Math.floor(Date.now() / 1000) - 86400 + 60;
      const data = await call(`${base}/${igId(account)}/content_publishing_limit`, {
        params: { fields: "quota_usage,config", since, access_token: account.accessToken },
      });
      const row = data.data?.[0] || {};
      return { quotaUsage: row.quota_usage ?? 0, quotaTotal: row.config?.quota_total ?? null };
    },

    /** Creates a Reels container that expects the video bytes via uploadVideo(). */
    async createReelContainer(account, { caption, shareToFeed = true, thumbOffsetMs }) {
      const data = await call(`${base}/${igId(account)}/media`, {
        method: "POST",
        params: {
          media_type: "REELS",
          upload_type: "resumable",
          caption,
          share_to_feed: shareToFeed,
          thumb_offset: Number.isFinite(thumbOffsetMs) ? Math.max(0, Math.round(thumbOffsetMs)) : undefined,
          access_token: account.accessToken,
        },
      });
      return { id: data.id, uri: data.uri || `https://rupload.facebook.com/ig-api-upload/${apiVersion}/${data.id}` };
    },

    async uploadVideo(account, { uri, filePath }) {
      const { size } = await fs.promises.stat(filePath);
      const data = await call(uri, {
        method: "POST",
        headers: { Authorization: `OAuth ${account.accessToken}`, offset: "0", file_size: String(size) },
        body: await fs.openAsBlob(filePath),
      });
      if (data.success === false) throw new InstagramError({ error: { message: data.message || "Video upload failed." } }, 200);
    },

    async containerStatus(account, containerId) {
      const data = await call(`${base}/${containerId}`, { params: { fields: "status_code,status", access_token: account.accessToken } });
      return { statusCode: data.status_code, status: data.status || null };
    },

    async publishContainer(account, containerId) {
      const data = await call(`${base}/${igId(account)}/media_publish`, {
        method: "POST",
        params: { creation_id: containerId, access_token: account.accessToken },
      });
      return { id: String(data.id) };
    },

    getMedia(account, mediaId) {
      return call(`${base}/${mediaId}`, {
        params: { fields: "id,caption,permalink,shortcode,timestamp,thumbnail_url,media_product_type", access_token: account.accessToken },
      });
    },

    async recentMedia(account, limit = 25) {
      const data = await call(`${base}/${igId(account)}/media`, {
        params: { fields: "id,caption,permalink,timestamp", limit, access_token: account.accessToken },
      });
      return data.data || [];
    },

    /** Current Reels metrics as a flat { views, reach, likes, … } object. */
    async mediaInsights(account, mediaId) {
      const data = await call(`${base}/${mediaId}/insights`, { params: { metric: REEL_METRICS.join(","), access_token: account.accessToken } });
      const out = {};
      for (const row of data.data || []) out[row.name] = row.total_value?.value ?? row.values?.[0]?.value ?? null;
      return out;
    },
  };
}
