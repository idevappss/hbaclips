// Standalone preview of the Integrations page on :5192 (Clip Studio itself runs on :5173).
// It keeps its own ledger in data/integrations/dev so it never writes over the studio's.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import { createIntegrations } from "./index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

const PORT = Number(process.env.INTEGRATIONS_PORT) || 5192;
const app = express();
app.get("/", (_req, res) => res.redirect("/api/integrations/"));
app.use(express.static(path.join(ROOT, "public"))); // styles.css + theme.css
app.use("/api/integrations", createIntegrations({ dataDir: path.join(ROOT, "data", "integrations", "dev") }).router);
app.listen(PORT, () => console.log(`Integrations preview: http://localhost:${PORT}/api/integrations/`));
