#!/usr/bin/env node
// HBA Content Backend for Claude: an MCP server (stdio) so Claude Desktop or Claude Code can run the clipping workflow in
// a chat — add a video, read the transcript, propose clips, get approval, render, check the renders and schedule
// posts. It's a thin layer over the app's own API (http://localhost:5173 by default), so everything Claude does
// shows up in the app and the other way round. No dependencies: the protocol is JSON-RPC over stdin/stdout.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const BASE = (process.env.CLIP_STUDIO_URL || "http://localhost:5173").replace(/\/$/, "");
const PROTOCOL = "2025-06-18";

// ---------- talking to the app ----------

async function api(method, route, body) {
  let res;
  try {
    res = await fetch(`${BASE}${route}`, {
      method,
      headers: body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`HBA Content Backend isn't running at ${BASE}. Start it (node server.js in the app folder) and try again.`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  if (!res.ok) throw new Error(data.error || `HBA Content Backend answered ${res.status}`);
  return data;
}

const secs = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

/** A clip as Claude needs to see it: what it is, where it sits, whether it's approved, how its render is doing. */
function clipView(c) {
  const r = c.render || {};
  const kept = c.parts?.length ? c.parts.reduce((sum, p) => sum + (p.end - p.start), 0) : c.end - c.start;
  return {
    id: c.id,
    rank: c.rank,
    title: c.title,
    start: secs(c.start),
    end: secs(c.end),
    seconds_before_tightening: secs(kept),
    hook: c.hook || null,
    score: c.score ?? null,
    why: c.reason || null,
    payoff: c.payoff || null,
    approved: Boolean(c.approved),
    render: r.status
      ? { status: r.status, progress: r.progress ?? null, message: r.message || null, seconds: r.duration ?? null, file: r.file || null, qa: r.qa || null }
      : null,
  };
}

async function projectView(id) {
  const p = await api("GET", `/api/projects/${encodeURIComponent(id)}`);
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    message: p.message,
    error: p.error || null,
    video_seconds: secs(p.source?.duration),
    clips: (p.clips || []).map(clipView),
    summary: p.analysis?.summary || null,
    title_ideas: (p.analysis?.titles || []).slice(0, 5).map((t) => t.title),
  };
}

const BUSY = new Set(["queued", "downloading", "probing", "preparing", "transcribing", "analyzing"]);

// ---------- tools ----------

const TOOLS = [
  {
    name: "studio_status",
    description:
      "Start here. Without project_id: every project in HBA Content Backend (id, name, status, clip counts). With project_id: that project's clips — title, range, score, whether approved, render status and QA. Call it to find out where things stand before doing anything else.",
    inputSchema: { type: "object", properties: { project_id: { type: "string" } } },
    run: async ({ project_id }) => (project_id ? projectView(project_id) : api("GET", "/api/projects")),
  },
  {
    name: "add_video",
    description:
      "Add a video to HBA Content Backend from a file on this computer (path) or a YouTube/web link (url). It gets a working copy, cleaned audio and a local transcript. With auto_pick false (the default here) it stops after transcription so you can read the transcript and propose clips yourself; with auto_pick true the app's own picker chooses clips. Returns the project id right away — use wait_for until status is ready.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to a video file" },
        url: { type: "string", description: "YouTube or other video link" },
        notes: { type: "string", description: "Audience, niche or what to look for (max 500 chars)" },
        auto_pick: { type: "boolean", default: false },
        language: { type: "string", default: "en" },
      },
    },
    run: async ({ path: file, url, notes = "", auto_pick = false, language = "en" }) => {
      if (url) return api("POST", "/api/projects/import", { url, notes, language, autoPick: auto_pick });
      if (!file) throw new Error("Give either path or url.");
      if (!fs.existsSync(file)) throw new Error(`No file at ${file}`);
      const form = new FormData();
      form.append("language", language);
      form.append("notes", notes);
      form.append("autoPick", String(auto_pick));
      form.append("video", await fs.openAsBlob(file), path.basename(file));
      const p = await api("POST", "/api/projects", form);
      return { id: p.id, name: p.name, status: p.status, next: "Call wait_for with this project_id until status is ready." };
    },
  },
  {
    name: "wait_for",
    description:
      "Wait for a project to finish processing, or a clip to finish rendering. Returns as soon as something changes, or after wait_seconds (max 60). Between calls, give the user a one-line progress update. Keep calling while status is still busy.",
    inputSchema: {
      type: "object",
      required: ["project_id"],
      properties: { project_id: { type: "string" }, clip_id: { type: "string" }, wait_seconds: { type: "number", default: 30 } },
    },
    run: async ({ project_id, clip_id, wait_seconds = 30 }) => {
      const limit = Date.now() + Math.min(60, Math.max(1, wait_seconds)) * 1000;
      const snapshot = async () => {
        const p = await projectView(project_id);
        if (!clip_id) return { key: `${p.status}|${p.message}`, done: !BUSY.has(p.status), view: { id: p.id, status: p.status, message: p.message, error: p.error, clips: p.clips.length } };
        const c = p.clips.find((x) => x.id === clip_id);
        if (!c) throw new Error(`No clip ${clip_id} in this project.`);
        const r = c.render || {};
        return { key: `${r.status}|${r.progress}`, done: !r.status || !["queued", "rendering"].includes(r.status), view: c };
      };
      let first = await snapshot();
      while (!first.done && Date.now() < limit) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const now = await snapshot();
        if (now.key !== first.key || now.done) return { ...now.view, done: now.done };
        first = now;
      }
      return { ...first.view, done: first.done };
    },
  },
  {
    name: "read_transcript",
    description:
      "Read a project's transcript as timestamped phrase lines ([mm:ss.s-mm:ss.s] text), with long pauses and existing clips marked. Long episodes come back in parts: if the result has `more`, call again with from set to more.from. Read the whole episode before proposing clips.",
    inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" }, from: { type: "number" }, to: { type: "number" } } },
    run: async ({ project_id, from, to }) => {
      const q = new URLSearchParams();
      if (Number.isFinite(from)) q.set("from", String(from));
      if (Number.isFinite(to)) q.set("to", String(to));
      return api("GET", `/api/projects/${encodeURIComponent(project_id)}/transcript${q.size ? `?${q}` : ""}`);
    },
  },
  {
    name: "propose_clips",
    description:
      "Add your clip picks to a project as unapproved clips (nothing renders). Before calling this, show the user your picks as a numbered list — timestamps, length, the hook, the payoff, why it will perform, a title — and get their OK. Each pick: start/end in seconds; a premium title (no emoji, no ALL-CAPS, no clickbait, no profanity); payoff (what the viewer gets by the end, 5+ words); standalone (only if the first word leans on earlier context, say why it still works); reasoning; optional cut [{start,end}] ranges to drop inside the clip (rambles, restarts, asides); optional hook {start,end} — a complete strong sentence from elsewhere in the video to open on; optional score 1–100. Aim for 30–42s after cuts, never over 60. HBA Content Backend then removes filler, false starts, dead air and any sentence with a curse word. A list with problems is rejected with every problem named — fix them and call again. replace: true swaps out unapproved, unrendered clips.",
    inputSchema: {
      type: "object",
      required: ["project_id", "picks"],
      properties: {
        project_id: { type: "string" },
        replace: { type: "boolean", default: false },
        picks: {
          type: "array",
          items: {
            type: "object",
            required: ["start", "end", "title", "payoff"],
            properties: {
              start: { type: "number" },
              end: { type: "number" },
              title: { type: "string" },
              payoff: { type: "string" },
              standalone: { type: "string" },
              reasoning: { type: "string" },
              score: { type: "number" },
              cut: { type: "array", items: { type: "object", properties: { start: { type: "number" }, end: { type: "number" } } } },
              hook: { type: "object", properties: { start: { type: "number" }, end: { type: "number" } } },
            },
          },
        },
      },
    },
    run: async ({ project_id, picks, replace = false }) => {
      const out = await api("POST", `/api/projects/${encodeURIComponent(project_id)}/clips/propose`, { picks, replace });
      return { added: out.added.map(clipView), total_clips: out.clips, next: "Show the user the clips and ask which to approve (approve_clips), then render_clips." };
    },
  },
  {
    name: "update_clip",
    description:
      "Change one clip: title, start/end (seconds), hook ({start,end} to pin an opening line, or null to let the app choose), approved, style (podcast | talk | bold | minimal), music_level (0–0.3, default 0.13), music ('auto', 'none' or a track id). Only change what the user asked for.",
    inputSchema: {
      type: "object",
      required: ["project_id", "clip_id"],
      properties: {
        project_id: { type: "string" },
        clip_id: { type: "string" },
        title: { type: "string" },
        start: { type: "number" },
        end: { type: "number" },
        hook: { type: ["object", "null"], properties: { start: { type: "number" }, end: { type: "number" } } },
        approved: { type: "boolean" },
        style: { type: "string" },
        music_level: { type: "number" },
        music: { type: "string" },
      },
    },
    run: async ({ project_id, clip_id, style, music_level, music, ...rest }) => {
      const body = { ...rest };
      if (style || Number.isFinite(music_level) || music) {
        body.design = { ...(style ? { style } : {}), ...(Number.isFinite(music_level) ? { musicLevel: music_level } : {}), ...(music ? { musicBed: music } : {}) };
      }
      return clipView(await api("PATCH", `/api/projects/${encodeURIComponent(project_id)}/clips/${encodeURIComponent(clip_id)}`, body));
    },
  },
  {
    name: "approve_clips",
    description: "Mark clips approved after the user says yes to them. Approved clips are the ones render_clips will render.",
    inputSchema: { type: "object", required: ["project_id", "clip_ids"], properties: { project_id: { type: "string" }, clip_ids: { type: "array", items: { type: "string" } } } },
    run: async ({ project_id, clip_ids }) => {
      const done = [];
      for (const id of clip_ids) done.push(clipView(await api("PATCH", `/api/projects/${encodeURIComponent(project_id)}/clips/${encodeURIComponent(id)}`, { approved: true })));
      return { approved: done };
    },
  },
  {
    name: "render_clips",
    description:
      "Render clips to finished vertical videos (queued; a clip takes 1–3 minutes). Renders the given clip_ids, or every approved clip when clip_ids is omitted. Unapproved clips are refused unless force is true — only use force when the user asked for that specific render. Follow with wait_for per clip, then check each render's qa.",
    inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" }, clip_ids: { type: "array", items: { type: "string" } }, force: { type: "boolean", default: false } } },
    run: async ({ project_id, clip_ids, force = false }) => {
      const p = await api("GET", `/api/projects/${encodeURIComponent(project_id)}`);
      const targets = (clip_ids?.length ? clip_ids.map((id) => p.clips.find((c) => c.id === id) || { id, missing: true }) : p.clips.filter((c) => c.approved));
      if (!targets.length) throw new Error("No approved clips to render. Approve some first (approve_clips) or pass clip_ids.");
      const queued = [];
      const refused = [];
      for (const c of targets) {
        if (c.missing) refused.push({ id: c.id, why: "no such clip" });
        else if (!c.approved && !force) refused.push({ id: c.id, why: "not approved" });
        else {
          const out = await api("POST", `/api/projects/${encodeURIComponent(project_id)}/clips/${encodeURIComponent(c.id)}/render`, {});
          queued.push({ id: c.id, title: c.title, status: out.render?.status || "queued" });
        }
      }
      return { queued, refused, next: queued.length ? "Use wait_for with each clip_id; report QA problems to the user." : null };
    },
  },
  {
    name: "cancel_render",
    description: "Stop a clip's render (clip_id), or every render in the project when clip_id is omitted.",
    inputSchema: { type: "object", required: ["project_id"], properties: { project_id: { type: "string" }, clip_id: { type: "string" } } },
    run: async ({ project_id, clip_id }) =>
      clip_id
        ? clipView(await api("POST", `/api/projects/${encodeURIComponent(project_id)}/clips/${encodeURIComponent(clip_id)}/cancel`, {}))
        : { ok: Boolean(await api("POST", `/api/projects/${encodeURIComponent(project_id)}/cancel-all`, {})) },
  },
  {
    name: "list_renders",
    description: "Every finished render across all projects: title, length, file path, QA result (loudness, black/frozen picture, silence) and how many times it's been scheduled.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const items = await api("GET", "/api/library");
      const root = process.env.CLIP_STUDIO_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
      return items.map((i) => ({ project_id: i.projectId, clip_id: i.clipId, kind: i.kind || "clip", title: i.title, seconds: i.duration, file: path.join(root, "projects", i.projectId, i.file), qa: i.qa, scheduled: i.scheduledCount }));
    },
  },
  {
    name: "list_accounts",
    description: "The Instagram accounts connected to the scheduler (ids for schedule_post).",
    inputSchema: { type: "object", properties: {} },
    run: async () => api("GET", "/api/accounts"),
  },
  {
    name: "schedule_post",
    description:
      "Schedule a rendered clip to post to Instagram accounts. This publishes publicly at the scheduled time, so ONLY call it after the user has explicitly confirmed this clip, these accounts, the time and the caption in this conversation. scheduled_at is an ISO date-time.",
    inputSchema: {
      type: "object",
      required: ["project_id", "clip_id", "account_ids", "scheduled_at", "caption"],
      properties: { project_id: { type: "string" }, clip_id: { type: "string" }, account_ids: { type: "array", items: { type: "string" } }, scheduled_at: { type: "string" }, caption: { type: "string" } },
    },
    run: async ({ project_id, clip_id, account_ids, scheduled_at, caption }) => api("POST", "/api/posts", { projectId: project_id, clipId: clip_id, accountIds: account_ids, scheduledAt: scheduled_at, caption }),
  },
];

const PROMPTS = [
  {
    name: "clip_workflow",
    description: "Turn a podcast or long video into premium short clips with HBA Content Backend, step by step with approval before rendering.",
    arguments: [{ name: "video", description: "File path or link to the episode", required: false }],
    text: (video) => `You're running HBA Content Backend for a premium creator brand. Core audience: healthcare professionals (doctors, chiropractors, physical therapists); growing into lifestyle, which sells in any niche — so strong lifestyle and personal moments are as clip-worthy as clinical or business lessons.
${video ? `The video: ${video}\n` : ""}
1. studio_status to see what's there. If the video isn't in yet, add_video (auto_pick false), then wait_for until ready, with a one-line update each time.
2. read_transcript for the whole episode (follow \`more\` until done). Map the topics silently.
3. Pick the 3–5 strongest standalone moments. Each opens on a hook in the first 3 seconds (a bold claim, question or tension; if the moment is an answer, start on the question), builds to a payoff and ends on a complete sentence, 30–42s after cuts. Mark rambles, restarts and asides to cut. Skip anything that needs earlier context or only works with profanity. Titles are calm and specific: no emoji, no ALL-CAPS, no clickbait.
4. Show a numbered table: timestamps, length, hook, payoff, why it performs, title — plus moments you skipped and why. STOP and wait for the user's yes.
5. propose_clips with the approved picks, approve_clips, render_clips, then wait_for each clip and report its length and QA.
6. Only schedule with schedule_post after the user confirms clip, accounts, time and caption.`,
  },
];

// ---------- JSON-RPC over stdio ----------

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const result = (id, value) => send({ id, result: value });
const failure = (id, code, message) => send({ id, error: { code, message } });

async function onMessage(msg) {
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return; // notifications (initialized, cancelled) need no answer
  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion: params.protocolVersion || PROTOCOL,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "clip-studio", version: "1.0.0" },
        instructions:
          "HBA Content Backend turns long videos into premium vertical clips. Call studio_status first. Never render without the user's approval of the picks, and never schedule posts without explicit confirmation. The clip_workflow prompt has the full process.",
      });
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: TOOLS.map(({ run, ...tool }) => tool) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return failure(id, -32602, `Unknown tool: ${params.name}`);
      try {
        const value = await tool.run(params.arguments || {});
        return result(id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
      } catch (err) {
        return result(id, { content: [{ type: "text", text: err.message }], isError: true });
      }
    }
    case "prompts/list":
      return result(id, { prompts: PROMPTS.map(({ text, ...p }) => p) });
    case "prompts/get": {
      const prompt = PROMPTS.find((p) => p.name === params.name);
      if (!prompt) return failure(id, -32602, `Unknown prompt: ${params.name}`);
      return result(id, { description: prompt.description, messages: [{ role: "user", content: { type: "text", text: prompt.text(params.arguments?.video) } }] });
    }
    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return failure(null, -32700, "Parse error");
  }
  onMessage(msg).catch((err) => failure(msg.id ?? null, -32603, err.message));
});
