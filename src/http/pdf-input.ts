import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import readXlsxFile from "read-excel-file/node";
import type { ChatMessage, UserContentPart } from "./chat-validate.js";
import { HttpError } from "./errors.js";

/** Upper bounds keep a small PDF from expanding into unbounded render work. */
const MAX_PAGES = 16;
const MAX_PIXELS_PER_PAGE = 5_000_000;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_PAGE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Limits local spreadsheet parsing before app-server receives any input. */
const MAX_TABLE_ROWS = 10_000;
const MAX_TABLE_COLUMNS = 256;
const MAX_SHEETS = 16;
const MAX_XLSX_EXPANDED_BYTES = 32 * 1024 * 1024;

/** Request-wide PDF rendering work already consumed. */
interface PdfBudget {
  pages: number;
  imageBytes: number;
  textBytes: number;
}

/** Reports an invalid or unsupported PDF without leaking its contents. */
function invalidPdf(message: string, param: string): never {
  throw new HttpError(
    400,
    message,
    "invalid_request_error",
    "invalid_pdf",
    param,
  );
}

/** Reports a file conversion failure with its content kept out of the error. */
function invalidFile(message: string, param: string): never {
  throw new HttpError(
    400,
    message,
    "invalid_request_error",
    "invalid_file",
    param,
  );
}

/** Checks ZIP central-directory sizes before a reader expands an XLSX archive. */
function checkXlsxArchive(bytes: Buffer, param: string): void {
  let end = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65_557);
    offset -= 1
  ) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) invalidFile("XLSX ZIP directory is missing.", param);
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  const start = bytes.readUInt32LE(end + 16);
  if (
    count === 0 ||
    count > 512 ||
    start + size > end ||
    count === 0xffff ||
    size === 0xffffffff
  )
    invalidFile("XLSX archive exceeds the supported ZIP limits.", param);
  let offset = start;
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      invalidFile("XLSX ZIP directory is malformed.", param);
    const uncompressed = bytes.readUInt32LE(offset + 24);
    if (
      uncompressed === 0xffffffff ||
      (bytes.readUInt16LE(offset + 8) & 1) !== 0
    )
      invalidFile("Encrypted or ZIP64 XLSX archives are unsupported.", param);
    expanded += uncompressed;
    if (expanded > MAX_XLSX_EXPANDED_BYTES)
      invalidFile("XLSX expanded data exceeds 32 MiB.", param);
    offset +=
      46 +
      bytes.readUInt16LE(offset + 28) +
      bytes.readUInt16LE(offset + 30) +
      bytes.readUInt16LE(offset + 32);
  }
  if (offset !== start + size)
    invalidFile("XLSX ZIP directory is malformed.", param);
}

/** Converts an inline text or spreadsheet file into bounded model-visible text. */
async function renderTextFile(
  file: Extract<UserContentPart, { type: "file" }>,
  param: string,
  budget: PdfBudget,
): Promise<UserContentPart[]> {
  const [header, payload] = file.data.split(",", 2);
  const mime = header!.slice(5, -7).toLowerCase();
  const bytes = Buffer.from(payload!, "base64");
  const extension = file.filename.split(".").at(-1)?.toLowerCase();
  let text: string;
  try {
    if (extension === "xlsx") {
      if (
        !/^(application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/octet-stream)$/.test(
          mime,
        )
      )
        invalidFile("XLSX MIME type does not match filename.", param);
      checkXlsxArchive(bytes, param);
      const sheets = await readXlsxFile(bytes);
      if (sheets.length < 1 || sheets.length > MAX_SHEETS)
        invalidFile("XLSX must contain 1 to 16 sheets.", param);
      let rows = 0;
      const lines: string[] = [];
      for (const sheet of sheets) {
        rows += sheet.data.length;
        if (rows > MAX_TABLE_ROWS)
          invalidFile("Spreadsheet exceeds 10,000 rows.", param);
        lines.push(`[sheet: ${sheet.sheet}]`);
        for (const row of sheet.data) {
          if (row.length > MAX_TABLE_COLUMNS)
            invalidFile("Spreadsheet exceeds 256 columns.", param);
          lines.push(JSON.stringify(row));
        }
      }
      text = lines.join("\n");
    } else {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (extension === "csv" || mime === "text/csv") {
        let rowCount = 0;
        const rows = parseCsv(decoded, {
          bom: true,
          relax_quotes: false,
          max_record_size: 64 * 1024,
          skip_empty_lines: false,
          on_record(record: string[]) {
            rowCount += 1;
            if (rowCount > MAX_TABLE_ROWS || record.length > MAX_TABLE_COLUMNS)
              invalidFile("CSV exceeds 10,000 rows or 256 columns.", param);
            return record;
          },
        }) as string[][];
        text = rows.map((row) => JSON.stringify(row)).join("\n");
      } else if (
        mime.startsWith("text/") ||
        [
          "application/json",
          "application/xml",
          "application/javascript",
          "application/x-yaml",
        ].includes(mime)
      ) {
        text = decoded;
      } else
        invalidFile(
          "This binary file format cannot be converted for app-server.",
          param,
        );
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    invalidFile("The inline file could not be decoded.", param);
  }
  const output = `[file: ${file.filename}; type: ${mime}]\n${text}`;
  budget.textBytes += Buffer.byteLength(output, "utf8");
  if (budget.textBytes > MAX_TEXT_BYTES)
    invalidFile("Extracted file text exceeds 2 MiB per request.", param);
  return [{ type: "text", text: output }];
}

/** Renders one inline PDF into ordered text and image inputs for app-server. */
async function renderPdf(
  file: Extract<UserContentPart, { type: "file" }>,
  param: string,
  signal: AbortSignal,
  budget: PdfBudget,
): Promise<UserContentPart[]> {
  const [{ getDocument, VerbosityLevel }, { createCanvas }] = await Promise.all(
    [import("pdfjs-dist/legacy/build/pdf.mjs"), import("@napi-rs/canvas")],
  );
  const require = createRequire(import.meta.url);
  const fonts =
    join(
      dirname(require.resolve("pdfjs-dist/package.json")),
      "standard_fonts",
    ) + sep;
  const payload = file.data.slice(file.data.indexOf(",") + 1);
  const task = getDocument({
    data: new Uint8Array(Buffer.from(payload, "base64")),
    standardFontDataUrl: fonts,
    verbosity: VerbosityLevel.ERRORS,
  });
  let document;
  try {
    document = await task.promise;
    if (document.numPages < 1 || budget.pages + document.numPages > MAX_PAGES)
      invalidPdf(
        `Inline PDFs may contain at most ${MAX_PAGES} pages per request.`,
        param,
      );
    budget.pages += document.numPages;
    const parts: UserContentPart[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      if (signal.aborted) throw signal.reason;
      const page = await document.getPage(pageNumber);
      const natural = page.getViewport({ scale: 1 });
      if (
        !Number.isFinite(natural.width) ||
        !Number.isFinite(natural.height) ||
        natural.width <= 0 ||
        natural.height <= 0
      )
        invalidPdf("PDF page dimensions are invalid.", param);
      const scale = Math.min(
        1.5,
        2400 / natural.width,
        2400 / natural.height,
        Math.sqrt(MAX_PIXELS_PER_PAGE / (natural.width * natural.height)),
      );
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(
        Math.max(1, Math.ceil(viewport.width)),
        Math.max(1, Math.ceil(viewport.height)),
      );
      // The native canvas implements PDF.js's rendering surface; its types
      // omit a browser-only focus method that PDF.js never calls here.
      const render = page.render({
        canvasContext: canvas.getContext(
          "2d",
        ) as unknown as CanvasRenderingContext2D,
        viewport,
      });
      const cancel = (): void => render.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await render.promise;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
      if (signal.aborted) throw signal.reason;
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .filter(Boolean)
        .join(" ");
      if (pageText) {
        const text = `[${file.filename}, page ${pageNumber}/${document.numPages}]\n${pageText}`;
        budget.textBytes += Buffer.byteLength(text, "utf8");
        if (budget.textBytes > MAX_TEXT_BYTES)
          invalidPdf("PDF extracted text exceeds the 2 MiB limit.", param);
        parts.push({ type: "text", text });
      }
      const png = canvas.toBuffer("image/png");
      budget.imageBytes += png.length;
      if (png.length > MAX_PAGE_IMAGE_BYTES)
        invalidPdf("A PDF page image exceeds the 8 MiB limit.", param);
      if (budget.imageBytes > MAX_IMAGE_BYTES)
        invalidPdf("PDF page images exceed the 40 MiB limit.", param);
      parts.push({
        type: "image",
        url: `data:image/png;base64,${png.toString("base64")}`,
      });
      page.cleanup();
    }
    return parts;
  } catch (error) {
    if (signal.aborted || error instanceof HttpError) throw error;
    return invalidPdf(
      "The inline PDF could not be decoded or rendered.",
      param,
    );
  } finally {
    if (document) await document.destroy();
    else await task.destroy();
  }
}

/** Materializes inline file parts before any app-server thread is started. */
export async function materializePdfParts(
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<void> {
  const budget: PdfBudget = { pages: 0, imageBytes: 0, textBytes: 0 };
  for (const [messageIndex, message] of messages.entries()) {
    if (!message.contentParts?.some((part) => part.type === "file")) continue;
    const parts: UserContentPart[] = [];
    for (const [partIndex, part] of message.contentParts.entries()) {
      if (part.type === "file") {
        const param = `messages.${messageIndex}.content.${partIndex}.file`;
        if (signal.aborted) throw signal.reason;
        if (/^data:application\/pdf;base64,/i.test(part.data)) {
          if (!/\.pdf$/i.test(part.filename))
            invalidFile("PDF MIME type does not match filename.", param);
          parts.push(...(await renderPdf(part, param, signal, budget)));
        } else {
          if (/\.pdf$/i.test(part.filename))
            invalidFile("PDF filename requires PDF MIME type.", param);
          parts.push(...(await renderTextFile(part, param, budget)));
        }
      } else parts.push(part);
    }
    message.contentParts = parts;
    message.content = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
}
