import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../core/logger.js";
import { readPrivateFile, replacePrivateFile } from "../core/private-file.js";
import { record } from "../core/canonical.js";
import { PINNED_CODEX_VERSION, startAppServer } from "./app-server.js";
import { configWithoutModelCatalogOverride } from "./responses-lite-override.js";

/** Inputs for one best-effort startup refresh of Codex-owned model metadata. */
export interface ModelCacheRefreshOptions {
  codexHome: string;
  codexPath: string;
  root: string;
  shutdownTimeoutMs: number;
  log: Logger;
  signal?: AbortSignal;
  /** Replaces only the catalog fetch in deterministic offline tests. */
  fetchCatalog?: (scratchHome: string) => Promise<void>;
}

/** Fetches through a fresh home so the selected static catalog cannot mask updates. */
async function fetchFreshCatalog(
  options: ModelCacheRefreshOptions,
  scratchHome: string,
): Promise<void> {
  const appServer = await startAppServer({
    codexPath: options.codexPath,
    codexHome: scratchHome,
    seedAuthFrom: options.codexHome,
    root: options.root,
    startupTimeoutMs: 30_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
    log: options.log,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  try {
    // An empty home makes OnlineIfUncached fetch remotely. The RPC can return
    // bundled fallback models after a failed fetch, so the cache file below is
    // the evidence that the refresh actually succeeded.
    await appServer.rpc.request(
      "model/list",
      { cursor: null, limit: 1, includeHidden: true },
      AbortSignal.any([
        options.signal ?? new AbortController().signal,
        AbortSignal.timeout(30_000),
      ]),
    );
  } finally {
    await appServer.stop();
  }
}

/** Compares optional private file contents without serializing secrets. */
function sameBytes(
  left: Buffer | undefined,
  right: Buffer | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && left.equals(right);
}

/** Preserves a token rotation without overwriting a concurrent login. */
async function retainRefreshedAuth(
  options: ModelCacheRefreshOptions,
  scratchHome: string,
  original: Buffer | undefined,
): Promise<void> {
  const refreshed = await readPrivateFile(join(scratchHome, "auth.json"));
  const target = join(options.codexHome, "auth.json");
  const current = await readPrivateFile(target);
  if (!sameBytes(current, original))
    throw new Error("Authentication changed during model cache refresh.");
  if (refreshed === undefined || sameBytes(refreshed, original)) return;
  await replacePrivateFile(target, refreshed);
}

/** Refreshes once in an isolated home, leaving the previous cache intact on failure. */
export async function refreshModelCache(
  options: ModelCacheRefreshOptions,
): Promise<void> {
  const scratchHome = await mkdtemp(
    join(tmpdir(), "codex-proxy-model-refresh-"),
  );
  let refreshed: { cache: Buffer; modelCount: number } | undefined;
  try {
    await chmod(scratchHome, 0o700);
    const selectedConfig = await readPrivateFile(
      join(options.codexHome, "config.toml"),
    );
    if (selectedConfig !== undefined)
      await writeFile(
        join(scratchHome, "config.toml"),
        configWithoutModelCatalogOverride(selectedConfig.toString("utf8")),
        { mode: 0o600 },
      );
    const originalAuth = await readPrivateFile(
      join(options.codexHome, "auth.json"),
    );
    try {
      await (
        options.fetchCatalog ?? ((home) => fetchFreshCatalog(options, home))
      )(scratchHome);
    } finally {
      // Token rotation can happen even when fetching rejects, including rejection
      // with undefined. Preserve it before propagating the original failure.
      await retainRefreshedAuth(options, scratchHome, originalAuth);
    }
    const cache = await readFile(join(scratchHome, "models_cache.json"));
    refreshed = { cache, modelCount: validateFreshCache(cache) };
  } finally {
    await rm(scratchHome, {
      recursive: true,
      force: true,
      maxRetries: 59,
      retryDelay: 500,
    });
  }
  if (refreshed === undefined)
    throw new Error("Codex model cache refresh produced no metadata.");
  // A cleanup failure leaves the prior cache intact, including its override.
  await mkdir(options.codexHome, { recursive: true, mode: 0o700 });
  await replacePrivateFile(
    join(options.codexHome, "models_cache.json"),
    refreshed.cache,
  );
  options.log("info", "model_cache_refreshed", {
    model_count: refreshed.modelCount,
  });
}

/** Validates the catalog before any bytes are published to the selected home. */
function validateFreshCache(cache: Buffer): number {
  const parsed: unknown = JSON.parse(cache.toString("utf8"));
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("Fresh Codex model cache is not an object.");
  const catalog = record(parsed);
  if (
    catalog?.client_version === PINNED_CODEX_VERSION &&
    Array.isArray(catalog.models) &&
    catalog.models.length > 0 &&
    catalog.models.every((entry) => {
      const model = record(entry);
      return typeof model?.slug === "string" && model.slug.trim() !== "";
    })
  )
    return catalog.models.length;
  throw new Error("Fresh Codex model cache has invalid version or models.");
}
