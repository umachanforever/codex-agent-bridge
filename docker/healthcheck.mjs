import { readFileSync } from "node:fs";

/** Reads the container bearer without printing credentials or response bodies. */
const token = process.env.CODEX_BRIDGE_TOKEN_FILE
  ? readFileSync(process.env.CODEX_BRIDGE_TOKEN_FILE, "utf8").replace(
      /\r?\n$/,
      "",
    )
  : process.env.CODEX_BRIDGE_TOKEN;
try {
  const response = await fetch("http://127.0.0.1:8787/ready", {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(4000),
  });
  process.exitCode = response.ok ? 0 : 1;
} catch {
  process.exitCode = 1;
}
