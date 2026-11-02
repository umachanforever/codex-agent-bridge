import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GeneratedImage } from "./generated-image.js";
import { HttpError } from "./errors.js";
import type { ChatMessage } from "./chat-validate.js";

/** Nonstandard local image route; the random filename is a read-only capability. */
export const IMAGE_FILE_PREFIX = "/v1/x_codex/images/";
/** Native image filenames never expose paths or upstream identifiers. */
const IMAGE_FILE_PATH =
  /^\/v1\/x_codex\/images\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/u;
/** Image references live for at most seven days in this proxy process. */
const IMAGE_TTL = 7 * 24 * 60 * 60 * 1000;
/** Bound both total bytes and metadata for generated image retention. */
const IMAGE_CAPACITY = 128 * 1024 * 1024;
/** Bound replay expansion even when many short references repeat the same image. */
const HISTORY_IMAGE_CAPACITY = 40 * 1024 * 1024;
/** Client renderers that benefit from short original-image references. */
export function usesImageFiles(
  tools: readonly Record<string, unknown>[],
): boolean {
  return tools.some(
    (tool) => tool.name === "show_widget" || tool.name === "present_files",
  );
}
/** Keep native cards inline and let the client own preview, save and clipboard actions. */
export const IMAGE_FILE_INSTRUCTIONS =
  "For image requests, use the provider-hosted image generation tool (image_gen.imagegen when available), not the separate client ImageGen tool or SVG/HTML/canvas drawings. The bridge delivers the original image inline. When a compatible Bash file tool is available, the bridge downloads original files into outputs and WorkBuddy creates native image cards. Let that download finish and briefly confirm success. Do not automatically call present_files, show_widget, preview_url, open_result_view or open browser/side panels. The user clicks the card to preview, save or copy. Never redraw, compress or regenerate an image for export. Do not repeat the image as Markdown or print its source URL.";

/** An original image retained under a random, process-local read capability. */
interface ImageFile {
  data: Buffer;
  mime: string;
  expires: number;
}

/** Owns bounded image bytes without reading files, fetching URLs, or publishing paths. */
export class ImageFiles {
  readonly #files = new Map<string, ImageFile>();
  #bytes = 0;

  /** Publishes verified native bytes as a short Markdown image source. */
  publish(image: GeneratedImage, origin: string): string {
    this.#prune();
    while (
      this.#bytes + image.bytes > IMAGE_CAPACITY ||
      this.#files.size >= 128
    )
      this.#remove(this.#files.keys().next().value!);
    const extension = image.mime === "image/jpeg" ? "jpg" : image.mime.slice(6);
    const path = `${IMAGE_FILE_PREFIX}${randomBytes(32).toString("hex")}.${extension}`;
    const data = Buffer.from(image.data);
    this.#files.set(path, {
      data,
      mime: image.mime,
      expires: Date.now() + IMAGE_TTL,
    });
    this.#bytes += data.length;
    const source = `${origin}${path}`;
    return `\n\n![Generated image](${source})\n\n`;
  }

  /** Serves only exact capabilities; image loads need no client bearer header. */
  serve(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): void {
    this.#prune();
    const file = IMAGE_FILE_PATH.test(path) ? this.#files.get(path) : undefined;
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    if (!file) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("content-type", file.mime);
    response.setHeader("content-length", file.data.length);
    response.setHeader(
      "content-disposition",
      `inline; filename="generated-image.${path.split(".").at(-1)}"`,
    );
    response.writeHead(200);
    response.end(request.method === "HEAD" ? undefined : file.data);
  }

  /** Restores only this listener's cached images as visual history without network I/O. */
  restore(messages: ChatMessage[], origin: string): ChatMessage[] {
    this.#prune();
    const lastUser = messages
      .map((message) => message.role)
      .lastIndexOf("user");
    if (lastUser < 0) return messages;
    let restoredBytes = 0;
    const parts: NonNullable<ChatMessage["contentParts"]> = [];
    const restored = messages.map((message): ChatMessage => {
      if (message.role !== "assistant" || !message.content) return message;
      const content = message.content.replace(
        /!\[Generated image\]\((http:\/\/[^\s()]+)\)/gu,
        (match: string, source: string) => {
          let url: URL;
          try {
            url = new URL(source);
          } catch {
            return match;
          }
          if (
            url.username ||
            url.password ||
            url.origin !== origin ||
            url.search ||
            url.hash ||
            !IMAGE_FILE_PATH.test(url.pathname)
          )
            return match;
          const file = this.#files.get(url.pathname);
          if (!file) return match;
          restoredBytes += file.data.length;
          if (restoredBytes > HISTORY_IMAGE_CAPACITY)
            throw new HttpError(
              413,
              "Generated image history exceeds the 40 MiB replay limit.",
              "invalid_request_error",
              "image_history_too_large",
            );
          parts.push(
            {
              type: "text",
              text: `Previously generated image. Original source for explicit file export only; do not open or print automatically: ${source}`,
            },
            {
              type: "image",
              url: `data:${file.mime};base64,${file.data.toString("base64")}`,
            },
          );
          return "[Previously generated image]";
        },
      );
      return content === message.content ? message : { ...message, content };
    });
    // Keep assistant/tool adjacency and continuation selectors intact. Visual
    // context augments the existing user input instead of inserting new turns.
    if (parts.length) {
      const user = restored[lastUser]!;
      restored[lastUser] = {
        ...user,
        contentParts: [
          ...(user.contentParts ?? [
            { type: "text", text: user.content ?? "" },
          ]),
          ...parts,
        ],
      };
    }
    return restored;
  }

  /** Releases all original bytes when the listener closes. */
  clear(): void {
    this.#files.clear();
    this.#bytes = 0;
  }

  /** Removes expired references lazily without a process-wide timer. */
  #prune(): void {
    for (const [path, file] of this.#files)
      if (file.expires <= Date.now()) this.#remove(path);
  }

  /** Releases one cached image while maintaining the byte budget. */
  #remove(path: string): void {
    const file = this.#files.get(path);
    if (file) {
      this.#bytes -= file.data.length;
      this.#files.delete(path);
    }
  }
}
