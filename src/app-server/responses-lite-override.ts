import { join } from "node:path";
import type { Logger } from "../core/logger.js";
import { readPrivateFile, updatePrivateText } from "../core/private-file.js";
import { record } from "../core/canonical.js";

/** Cache filename owned and refreshable by Codex. */
const SOURCE_CATALOG_FILENAME = "models_cache.json";

/** Proxy-owned catalog filename that Codex loads instead of its cache. */
export const RESPONSES_LITE_OVERRIDE_CATALOG_FILENAME =
  "models.no-responses-lite.json";

/** Codex user configuration filename within the selected Codex home. */
const CODEX_CONFIG_FILENAME = "config.toml";

/** Start marker for the temporary proxy-owned configuration block. */
const CONFIG_BLOCK_START =
  "# BEGIN codex-openai-proxy temporary Responses Lite override";

/** End marker for the temporary proxy-owned configuration block. */
const CONFIG_BLOCK_END =
  "# END codex-openai-proxy temporary Responses Lite override";

/** Matches a previously installed temporary configuration block. */
const CONFIG_BLOCK_PATTERN =
  /^# BEGIN codex-openai-proxy temporary Responses Lite override\r?\n[\s\S]*?^# END codex-openai-proxy temporary Responses Lite override(?:\r?\n)?/gmu;

/** Matches an existing one-line top-level catalog override. */
const MODEL_CATALOG_KEY_PATTERN =
  /^[\t ]*(?:model_catalog_json|"model_catalog_json"|'model_catalog_json')[\t ]*=.*(?:\r?\n|$)/gmu;

/** Result of attempting to install the temporary catalog override. */
export type ResponsesLiteOverrideResult =
  | { status: "missing-cache" }
  | { status: "applied"; changed: boolean; modelCount: number };

/** Clones and patches every model entry in a Codex cache document. */
function disableResponsesLite(source: string): {
  content: string;
  modelCount: number;
} {
  let catalog: unknown;
  try {
    catalog = JSON.parse(source);
  } catch {
    throw new Error("Codex models_cache.json is not valid JSON.");
  }
  const document = record(catalog);
  if (!document || !Array.isArray(document.models))
    throw new Error("Codex models_cache.json has no models array.");
  if (document.models.length === 0)
    throw new Error("Codex models_cache.json contains no models.");

  const models = document.models.map((entry, index) => {
    const model = record(entry);
    if (!model)
      throw new Error(
        `Codex models_cache.json model ${index} is not an object.`,
      );
    const patched: Record<string, unknown> = {
      ...model,
      use_responses_lite: false,
    };
    // Converted models must use direct tools; native code-mode models stay intact.
    if (model.use_responses_lite === true) delete patched.tool_mode;
    return patched;
  });

  return {
    content: `${JSON.stringify({ ...document, models }, null, 2)}\n`,
    modelCount: models.length,
  };
}

/** Removes only the static catalog selection for a fresh Codex model fetch. */
export function configWithoutModelCatalogOverride(existing: string): string {
  const withoutManagedBlock = existing.replace(CONFIG_BLOCK_PATTERN, "");
  const withoutCatalogKey = withoutManagedBlock.replace(
    MODEL_CATALOG_KEY_PATTERN,
    "",
  );
  return withoutCatalogKey.replace(/^(?:\r?\n)+/u, "");
}

/** Renders the managed top-level override while preserving other Codex config. */
function renderConfig(existing: string, catalogPath: string): string {
  const remainder = configWithoutModelCatalogOverride(existing);
  const managedBlock = [
    CONFIG_BLOCK_START,
    "# Temporary workaround for the Codex 0.154.0 Responses request framing.",
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    CONFIG_BLOCK_END,
    "",
  ].join("\n");
  return remainder === "" ? managedBlock : `${managedBlock}\n${remainder}`;
}

/**
 * Installs a separate catalog that disables Responses Lite and restores direct
 * tools for converted models, without mutating the cache.
 */
export async function installResponsesLiteOverride(
  codexHome: string,
  log: Logger,
): Promise<ResponsesLiteOverrideResult> {
  const sourcePath = join(codexHome, SOURCE_CATALOG_FILENAME);
  const source = (await readPrivateFile(sourcePath))?.toString("utf8");
  if (source === undefined) {
    log("debug", "responses_lite_override_waiting_for_catalog");
    return { status: "missing-cache" };
  }

  const overridePath = join(
    codexHome,
    RESPONSES_LITE_OVERRIDE_CATALOG_FILENAME,
  );
  const configPath = join(codexHome, CODEX_CONFIG_FILENAME);
  const { content, modelCount } = disableResponsesLite(source);
  const catalogChanged = await updatePrivateText(overridePath, content);
  const existingConfig =
    (await readPrivateFile(configPath))?.toString("utf8") ?? "";
  const configChanged = await updatePrivateText(
    configPath,
    renderConfig(existingConfig, overridePath),
  );
  const changed = catalogChanged || configChanged;
  if (changed)
    log("info", "responses_lite_override_installed", {
      model_count: modelCount,
    });
  return { status: "applied", changed, modelCount };
}
