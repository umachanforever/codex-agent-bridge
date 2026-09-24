import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** Runs bounded Docker commands without a shell or model credentials. */
const exec = promisify(execFile);
/** Isolates this smoke's resources from any production Compose project. */
const name = `codex-bridge-smoke-${randomUUID()}`;
/** Image built from this checkout, overridable for release validation. */
const image = process.env.BRIDGE_TEST_IMAGE ?? "codex-agent-bridge:dev";
/** Synthetic server uses the production HTTP/auth implementation, no app-server. */
const server = `
import {createProxyServer} from './dist/http/server.js';
import {parseServeOptions,resolveServeOptions} from './dist/core/config.js';
import {createLogger} from './dist/core/logger.js';
const options = await resolveServeOptions(parseServeOptions([
  '--agent-service-model','synthetic','--root','/workspace',
  '--state-dir','/data/state','--codex-home','/data/codex'
]));
const proxy = createProxyServer(options,createLogger('error'));
await proxy.listen();
process.on('SIGTERM', async () => { await proxy.close(); process.exit(0); });
`;

/** Executes a finite Docker operation; no secrets are supplied by this smoke. */
async function docker(args) {
  return exec("docker", args, { timeout: 120000, maxBuffer: 1024 * 1024 });
}

try {
  const version = await docker(["run", "--rm", image, "node", "node_modules/@openai/codex/bin/codex.js", "--version"]);
  assert.match(version.stdout, /codex-cli/);
  await docker(["run", "-d", "--name", name, "-p", "127.0.0.1::8080", "-e", "CODEX_BRIDGE_TOKEN=synthetic-smoke-key", image, "node", "--input-type=module", "-e", server]);
  await docker(["run", "-d", "--name", `${name}-gateway`, "--network", `container:${name}`, "--user", "101:101", "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "-v", `${resolve("docker/nginx.conf")}:/etc/nginx/nginx.conf:ro`, "--entrypoint", "nginx", "nginx:1.28-alpine", "-g", "daemon off;"]);
  const mapping = (await docker(["port", name, "8080/tcp"])).stdout.trim();
  assert.match(mapping, /^127\.0\.0\.1:\d+$/);
  const origin = `http://${mapping}`;
  let response;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.status === 401) break;
    } catch { /* The gateway may still be starting. */ }
    await delay(250);
  }
  assert.equal(response?.status, 401);
  const headers = { Authorization: "Bearer synthetic-smoke-key" };
  assert.equal((await fetch(`${origin}/health`, {headers})).status, 200);
  assert.equal((await fetch(`${origin}/ready`, {headers})).status, 503);
  assert.equal((await fetch(`${origin}/health`, {headers: {...headers, Origin: "https://example.invalid"}})).status, 403);
  process.stdout.write("Docker smoke passed: Codex executable, loopback gateway, bearer auth, readiness and Origin rejection; zero model calls.\n");
} finally {
  // Only remove uniquely named resources created by this test.
  await docker(["rm", "-f", `${name}-gateway`]).catch(() => {});
  await docker(["rm", "-f", name]).catch(() => {});
}
