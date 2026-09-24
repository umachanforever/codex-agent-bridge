import { record } from "../core/canonical.js";
import { HttpError } from "./errors.js";

/** Native generation settings included in continuation identity. */
export interface GenerationOptions {
  outputSchema?: Record<string, unknown>;
  verbosity?: "low" | "medium" | "high";
  serviceTier?: "default" | "priority";
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
): GenerationOptions | undefined {
  const result: GenerationOptions = {};
  if (body.response_format != null) {
    const format = record(body.response_format);
    if (!format)
      invalid("response_format must be an object.", "response_format");
    if (format.type === "json_object")
      throw new HttpError(
        400,
        "response_format json_object is not supported on this bridge; use json_schema with an explicit object schema.",
        "invalid_request_error",
        "unsupported_parameter",
        "response_format.type",
      );
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
    } else if (format.type !== "text")
      invalid("Unsupported response_format type.", "response_format.type");
  }
  if (body.verbosity != null) {
    if (
      body.verbosity !== "low" &&
      body.verbosity !== "medium" &&
      body.verbosity !== "high"
    )
      invalid("verbosity must be low, medium or high.", "verbosity");
    result.verbosity = body.verbosity;
  }
  if (body.service_tier != null && body.service_tier !== "auto") {
    if (body.service_tier === "default") result.serviceTier = "default";
    else if (body.service_tier === "priority" || body.service_tier === "fast")
      result.serviceTier = "priority";
    else
      invalid(
        "service_tier supports auto, default, priority or fast.",
        "service_tier",
      );
  }
  return Object.keys(result).length ? result : undefined;
}
