import { record } from "../core/canonical.js";
import { HttpError } from "./errors.js";

/** Native generation settings included in continuation identity. */
export interface GenerationOptions {
  outputSchema?: Record<string, unknown>;
  verbosity?: string;
  serviceTier?: string;
}

/** Rejects a malformed generation control before any model work starts. */
function invalid(message: string, param: string): never {
  throw new HttpError(
    400,
    message,
    "invalid_request_error",
    "invalid_generation_parameter",
    param,
  );
}

/** Maps structured output directly to the pinned app-server schema capability. */
export function generationOptions(
  body: Record<string, unknown>,
  ignored: string[],
): GenerationOptions | undefined {
  const result: GenerationOptions = {};
  if (body.response_format != null) {
    const format = record(body.response_format);
    if (!format)
      invalid("response_format must be an object.", "response_format");
    if (typeof format.type !== "string" || !format.type.trim())
      invalid(
        "response_format.type must be a non-empty string.",
        "response_format.type",
      );
    if (format.type === "json_object") result.outputSchema = { type: "object" };
    else if (format.type === "json_schema") {
      const definition = record(format.json_schema);
      const schema = record(definition?.schema);
      if (!schema)
        invalid(
          "response_format.json_schema.schema must be a JSON Schema object.",
          "response_format.json_schema.schema",
        );
      if (
        definition?.strict !== undefined &&
        typeof definition.strict !== "boolean"
      )
        invalid(
          "response_format.json_schema.strict must be a boolean.",
          "response_format.json_schema.strict",
        );
      result.outputSchema = schema;
    } else if (format.type !== "text") ignored.push("response_format");
  }
  if (body.verbosity != null) {
    if (typeof body.verbosity !== "string" || !body.verbosity.trim())
      invalid("verbosity must be a non-empty string.", "verbosity");
    result.verbosity = body.verbosity;
  }
  if (body.service_tier != null && body.service_tier !== "auto") {
    if (typeof body.service_tier !== "string" || !body.service_tier.trim())
      invalid("service_tier must be a non-empty string.", "service_tier");
    result.serviceTier =
      body.service_tier === "fast" ? "priority" : body.service_tier;
  }
  return Object.keys(result).length ? result : undefined;
}
