import type { JsonRpcTransport } from "./json-rpc.js";
import { record } from "../core/canonical.js";

/**
 * A validated app-server catalog model. Only the selector and its visibility
 * are required, so an entry carrying unfamiliar presentation metadata never
 * fails the whole catalog; every other field is retained untouched.
 */
export interface CatalogModel {
  model: string;
  hidden: boolean;
  [metadata: string]: unknown;
}

/** Options that control the app-server model catalog request. */
export interface ReadModelCatalogOptions {
  includeHidden?: boolean;
  signal?: AbortSignal;
}

/** Reads every app-server model-list page while validating only its used shape. */
export async function readModelCatalog(
  rpc: Pick<JsonRpcTransport, "request">,
  options: ReadModelCatalogOptions = {},
): Promise<CatalogModel[]> {
  const models: CatalogModel[] = [];
  for await (const page of catalogPages(rpc, options)) models.push(...page);
  return models;
}

/** Streams validated pages and rejects cycles before issuing a duplicate RPC. */
async function* catalogPages(
  rpc: Pick<JsonRpcTransport, "request">,
  options: ReadModelCatalogOptions,
): AsyncGenerator<CatalogModel[]> {
  const visited = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = validatePage(
      await rpc.request(
        "model/list",
        {
          cursor,
          limit: 100,
          includeHidden: options.includeHidden ?? false,
        },
        options.signal,
      ),
    );
    yield page.data.map(validateModel);
    if (page.nextCursor === null) return;
    if (visited.has(page.nextCursor))
      throw new Error("model/list returned a repeated pagination cursor.");
    visited.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

/** The narrow, runtime-validated portion of an app-server model-list page. */
interface ModelCatalogPage {
  data: unknown[];
  nextCursor: string | null;
}

/** Validates the pagination envelope without imposing generated Model details. */
function validatePage(value: unknown): ModelCatalogPage {
  const page = record(value);
  if (
    !page ||
    !Array.isArray(page.data) ||
    !(page.nextCursor === null || typeof page.nextCursor === "string")
  )
    throw new Error("model/list returned an invalid page.");
  return { data: page.data, nextCursor: page.nextCursor };
}

/** Validates the two required catalog fields while preserving metadata. */
function validateModel(value: unknown): CatalogModel {
  const model = record(value);
  if (
    !model ||
    typeof model.model !== "string" ||
    model.model.trim() === "" ||
    typeof model.hidden !== "boolean"
  )
    throw new Error("model/list returned an invalid model.");
  return model as CatalogModel;
}
