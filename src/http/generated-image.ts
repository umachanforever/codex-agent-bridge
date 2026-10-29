import { HttpError } from "./errors.js";

/** Largest generated image accepted by the existing image-input contract. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Public, path-free representation of one completed native image result. */
export interface GeneratedImage {
  markdown: string;
  mime: string;
  bytes: number;
}

/** Converts bounded inline image bytes without reading paths or fetching file IDs. */
export function generatedImage(item: Record<string, unknown>): GeneratedImage {
  if (item.failure || item.status !== "completed")
    throw new HttpError(
      502,
      "Native image generation did not complete.",
      "server_error",
      "image_generation_failed",
    );
  const result = item.result;
  if (
    typeof result !== "string" ||
    !result ||
    result.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(result)
  )
    throw new HttpError(
      502,
      "Native image generation returned no supported inline image.",
      "server_error",
      "image_generation_output_unavailable",
    );
  const bytes = Buffer.from(result, "base64");
  if (
    !bytes.length ||
    bytes.length > MAX_IMAGE_BYTES ||
    bytes.toString("base64") !== result
  )
    throw new HttpError(
      502,
      "Native image generation returned invalid image data.",
      "server_error",
      "invalid_generated_image",
    );
  const mime = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "image/jpeg"
      : bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
          bytes.subarray(8, 12).toString("ascii") === "WEBP"
        ? "image/webp"
        : ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
          ? "image/gif"
          : undefined;
  if (!mime)
    throw new HttpError(
      502,
      "Native image generation returned an unsupported image format.",
      "server_error",
      "invalid_generated_image",
    );
  return {
    markdown: `\n\n![Generated image](data:${mime};base64,${result})\n\n`,
    mime,
    bytes: bytes.length,
  };
}
