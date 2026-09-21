// Instagram state lives in one JSON file: connected accounts (with tokens) and per-target publish records.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const empty = () => ({ version: 1, connections: [], jobs: [] });

export function createStore(file) {
  let data = null;
  let chain = Promise.resolve();

  async function read() {
    if (data) return data;
    try {
      data = { ...empty(), ...JSON.parse(await fs.readFile(file, "utf8")) };
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      data = empty();
    }
    return data;
  }

  /**
   * Mutate state inside fn and persist it. Updates are serialized so writes never interleave;
   * if fn throws, the in-memory copy is dropped and reloaded from disk on the next read.
   */
  function update(fn) {
    const next = chain.then(async () => {
      const state = await read();
      try {
        const result = await fn(state);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
        await fs.rename(tmp, file);
        return result;
      } catch (err) {
        data = null;
        throw err;
      }
    });
    chain = next.catch(() => {});
    return next;
  }

  return { read, update };
}
