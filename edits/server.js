// Standalone Dope Edits server (port 5190). Clip Studio can mount the same router instead; see README.md.
// Run only one of the two at a time: both would work the same job queue on disk.
import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import { ROOT } from "../lib/tools.js";
import { createEditsIntegration } from "./index.js";
import { hasClaudeKey } from "./director.js";

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const PORT = Number(process.env.EDITS_PORT) || 5190;
const edits = createEditsIntegration();
const app = express();
app.use("/", edits.router);
await edits.start();

app.listen(PORT, () => {
  console.log(`\n  Dope Edits → http://localhost:${PORT}`);
  console.log(`  Director: ${hasClaudeKey() ? "Claude (claude-opus-5)" : "heuristic — add ANTHROPIC_API_KEY to .env for Claude"}\n`);
});
