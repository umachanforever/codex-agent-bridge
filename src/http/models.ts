import type { ServerResponse } from "node:http";
import { readModelCatalog, type CatalogModel } from "../app-server/models.js";
import type { JsonRpcTransport } from "../app-server/json-rpc.js";
import type { Logger } from "../core/logger.js";
import { appServerError, HttpError, writeJson } from "./errors.js";

/** Standard OpenAI-compatible representation of one available model. */
export interface ModelListItem {
  id: string;
  object: "model";
  created: 0;
  owned_by: "openai";
}

/** Standard OpenAI-compatible response returned by the models collection. */
export interface ModelListResponse {
  object: "list";
  data: ModelListItem[];
}

/** Dependencies required to translate one app-server model catalog request. */
export interface ModelListHandlerOptions {
  includeLocalAlias?: boolean;
  rpc: Pick<JsonRpcTransport, "request">;
  log: Logger;
  requestId: string;
  signal: AbortSignal;
}

/** Lists visible app-server models using the standard OpenAI collection shape. */
export async function handleModelList(
  response: ServerResponse,
  { rpc, log, requestId, signal, includeLocalAlias }: ModelListHandlerOptions,
): Promise<void> {
  const visible = await visibleModels({ rpc, log, requestId, signal });
  if (includeLocalAlias && !visible.has("codex-cli"))
    visible.set("codex-cli", {
      id: "codex-cli",
      object: "model",
      created: 0,
      owned_by: "openai",
    });
  writeJson(response, 200, {
    object: "list",
    data: [...visible.values()],
  } satisfies ModelListResponse);
}

/** Returns one model item for OpenAI clients that validate a configured model. */
export async function handleModelRetrieve(
  response: ServerResponse,
  modelId: string,
  options: ModelListHandlerOptions,
): Promise<void> {
  const visible = await visibleModels(options);
  const model = visible.get(modelId);
  if (!model)
    throw new HttpError(
      404,
      `The model '${modelId}' does not exist.`,
      "invalid_request_error",
      "model_not_found",
      "model",
    );
  writeJson(response, 200, model);
}

/** Reads and filters the catalog once for collection and item endpoints. */
async function visibleModels({
  rpc,
  log,
  requestId,
  signal,
  includeLocalAlias,
}: ModelListHandlerOptions): Promise<Map<string, ModelListItem>> {
  let catalog: CatalogModel[];
  try {
    catalog = await readModelCatalog(rpc, { includeHidden: false, signal });
  } catch (cause) {
    if (signal.aborted) throw signal.reason;
    log.failure("models_list_failed", { request_id: requestId }, cause);
    throw appServerError("The app-server could not list models.");
  }
  const visible = new Map(
    catalog
      .filter((model) => !model.hidden)
      .map((model) => [model.model, modelListItem(model)] as const),
  );
  if (includeLocalAlias && !visible.has("codex-cli"))
    visible.set("codex-cli", {
      id: "codex-cli",
      object: "model",
      created: 0,
      owned_by: "openai",
    });
  return visible;
}

/** Converts the app-server's public model selector to OpenAI's stable shape. */
function modelListItem(model: CatalogModel): ModelListItem {
  return {
    id: model.model,
    object: "model",
    // Catalog metadata has no OpenAI creation or owner equivalent, so retain
    // deterministic compatibility placeholders instead of inventing values.
    created: 0,
    owned_by: "openai",
  };
}
