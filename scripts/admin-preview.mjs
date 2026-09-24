import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminStore } from "../dist/admin/store.js";
import { createAdminServer } from "../dist/admin/server.js";
import { parseServeOptions, resolveServeOptions } from "../dist/core/config.js";

/** Offline UI harness: isolated state, synthetic admin credential, no model backend. */
const root = await mkdtemp(join(tmpdir(), "codex-admin-preview-"));
/** Real persistence exercises UI operations without production credentials. */
const store = new AdminStore(root);
/** Loopback-only preview uses no Codex account or app-server process. */
const config = await resolveServeOptions(parseServeOptions(["--root", root, "--state-dir", root, "--agent-service-model", "synthetic"]));
/** Synthetic verifier must never be used in a real deployment. */
const server = createAdminServer({ host: "127.0.0.1", port: 0, store, config, verifyToken: value => value === "synthetic-admin-preview-token", status: () => ({ready:false,active:0}) });
process.stdout.write(`Offline admin preview: http://127.0.0.1:${await server.listen()}/admin/\n`);
/** Cleans only the uniquely allocated preview directory after disconnecting clients. */
async function stop() { await server.close(); store.close(); await rm(root, { recursive: true, force: true }); process.exit(0); }
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
