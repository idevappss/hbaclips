// Brand and spelling fixes for transcripts (data/caption-corrections.json): the speech model's usual mistakes on
// names and jargon, corrected once so captions, hooks and titles all read right. A multi-word fix becomes one
// caption word spanning the words it replaces.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./tools.js";

const FILE = path.join(ROOT, "data", "caption-corrections.json");
let cached = { mtime: 0, rules: [] };

const norm = (w) => String(w || "").toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

function rules() {
  try {
    const { mtimeMs } = fs.statSync(FILE);
    if (mtimeMs !== cached.mtime) {
      const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
      const list = Object.entries(data)
        .filter(([from, to]) => !from.startsWith("_") && typeof to === "string")
        .map(([from, to]) => ({ from: from.split(/\s+/).map(norm).filter(Boolean), to }))
        .filter((r) => r.from.length)
        .sort((a, b) => b.from.length - a.from.length); // longest phrase first
      cached = { mtime: mtimeMs, rules: list };
    }
  } catch {
    cached = { mtime: 0, rules: [] };
  }
  return cached.rules;
}

/** Words [{ text, start, end }] with corrections applied; punctuation on the last replaced word is kept. */
export function correctWords(words) {
  const list = rules();
  if (!list.length || !words?.length) return words;
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const rule = list.find((r) => r.from.every((part, k) => norm(words[i + k]?.text) === part));
    if (!rule) {
      out.push(words[i]);
      continue;
    }
    const last = words[i + rule.from.length - 1];
    const trailing = String(last.text).match(/[.,!?;:]+$/)?.[0] || "";
    out.push({ ...words[i], text: rule.to + (rule.to.match(/[.,!?;:]$/) ? "" : trailing), end: last.end });
    i += rule.from.length - 1;
  }
  return out;
}
