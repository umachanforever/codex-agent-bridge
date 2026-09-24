import { createHash } from "node:crypto";

/** Reads a plain JSON object without accepting arrays or null. */
export function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || Array.isArray(value) || typeof value !== "object")
    return undefined;
  return value as Record<string, unknown>;
}

/** Serializes JSON-compatible data with object keys in a stable order. */
export function canonicalJson(value: unknown): string {
  const object = record(value);
  if (object) {
    const fields: string[] = [];
    for (const key of Object.keys(object).sort()) {
      fields.push(`${JSON.stringify(key)}:${canonicalJson(object[key])}`);
    }
    return `{${fields.join(",")}}`;
  }
  if (Array.isArray(value)) {
    const elements: string[] = [];
    for (const element of value) elements.push(canonicalJson(element));
    return `[${elements.join(",")}]`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Produces the stable hexadecimal SHA-256 key used for state bindings. */
export function bindingHash(value: unknown): string {
  const encoded = canonicalJson(value);
  const digest = createHash("sha256");
  digest.update(encoded, "utf8");
  return digest.digest("hex");
}
