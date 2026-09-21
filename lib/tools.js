// Paths to the external binaries the pipeline shells out to, plus a spawn helper.
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PROJECTS_DIR = path.join(ROOT, "projects");

// Bundled ffmpeg/ffprobe from npm so no Homebrew install is needed.
export const FFMPEG = process.env.FFMPEG_PATH || require("ffmpeg-static");
export const FFPROBE = process.env.FFPROBE_PATH || require("ffprobe-static").path;
export const HYPERFRAMES = path.join(ROOT, "node_modules", ".bin", "hyperframes");

// HyperFrames looks up ffmpeg/ffprobe (and cmake, for its one-time whisper.cpp build) on PATH.
export const toolEnv = {
  ...process.env,
  PATH: [path.dirname(FFMPEG), path.dirname(FFPROBE), process.env.PATH].join(path.delimiter),
  PRODUCER_BROWSER_GPU_MODE: process.env.PRODUCER_BROWSER_GPU_MODE || "hardware",
};

export function abortError() {
  const err = new Error("Stopped");
  err.name = "AbortError";
  return err;
}

/** All descendant pids of `pid` (HyperFrames spawns Chrome workers and ffmpeg under itself). */
function descendants(pid) {
  let table;
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const children = new Map();
  for (const line of table.trim().split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const out = [];
  const stack = [pid];
  while (stack.length) {
    for (const child of children.get(stack.pop()) || []) {
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

function signalAll(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Run a command, streaming each output line to onLine. Resolves with stdout;
 * rejects with the tail of the combined output when the exit code is non-zero.
 * Aborting `signal` terminates the whole process tree and rejects with an AbortError.
 */
export function run(cmd, args, { cwd, onLine, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(cmd, args, { cwd, env: toolEnv });

    let killTimer;
    const onAbort = () => {
      // Snapshot the tree first: once the parent dies its children get reparented and are hard to find.
      const tree = [...descendants(child.pid).reverse(), child.pid];
      signalAll(tree, "SIGTERM");
      killTimer = setTimeout(() => signalAll(tree, "SIGKILL"), 4000);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let stdout = "";
    const tail = [];
    const handle = (chunk, isStdout) => {
      const text = chunk.toString();
      if (isStdout) stdout += text;
      for (const raw of text.split(/\r?\n|\r/)) {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
        if (!line) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        onLine?.(line);
      }
    };
    child.stdout.on("data", (c) => handle(c, true));
    child.stderr.on("data", (c) => handle(c, false));
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        // Give stragglers the SIGKILL window, but settle the promise now.
        if (killTimer) killTimer.unref();
        return reject(abortError());
      }
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(cmd)} exited with code ${code}\n${tail.slice(-12).join("\n")}`));
    });
  });
}
