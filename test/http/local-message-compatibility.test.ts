import assert from "node:assert/strict";
import { test } from "vitest";
import { adaptLocalBridgeRequest } from "../../src/http/local-bridge.js";
import {
  toHistoryItem,
  validateRequest,
} from "../../src/http/chat-validate.js";
import { materializePdfParts } from "../../src/http/pdf-input.js";
import { silentLogger } from "../support/logger.js";
import { createLogger } from "../../src/core/logger.js";
import { HttpError } from "../../src/http/errors.js";
import { syntheticPdf } from "../support/pdf.js";
import { zipSync } from "fflate";

/** Builds a minimal synthetic XLSX without persisting user-like file content. */
function syntheticXlsx(): Buffer {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": Buffer.from(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    "_rels/.rels": Buffer.from(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    "xl/workbook.xml": Buffer.from(
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": Buffer.from(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    "xl/worksheets/sheet1.xml": Buffer.from(
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>example</t></is></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>',
    ),
  };
  return Buffer.from(zipSync(files));
}

/** Exercises the same compatibility and validation path used by the HTTP route. */
function parse(messages: unknown[], extra: Record<string, unknown> = {}) {
  return validateRequest(
    adaptLocalBridgeRequest(
      { model: "synthetic", messages, ...extra },
      "synthetic",
    ),
    silentLogger,
    "synthetic-test",
    true,
  );
}

test("client agent and request metadata do not affect message content or tool replay", () => {
  const messages = [
    { role: "system", content: "synthetic" },
    { role: "user", content: [{ type: "text", text: "question" }] },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call",
          type: "function",
          function: { name: "Bash", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "call", content: "result" },
  ];
  const decorated = messages.map((message) => ({
    ...message,
    agent: { name: "synthetic-client" },
    conversationRequestId: "synthetic-request",
  }));
  const before = JSON.stringify(decorated);
  assert.deepEqual(parse(decorated).messages, parse(messages).messages);
  assert.equal(JSON.stringify(decorated), before);
  assert.doesNotThrow(() =>
    parse([{ ...decorated[1], unknownSemanticField: "keep rejected" }]),
  );
  assert.throws(
    () =>
      validateRequest(
        { model: "synthetic", messages: decorated },
        silentLogger,
        "synthetic-test",
        true,
      ),
    /unsupported fields: agent, conversationRequestId/,
  );
});

test("WorkBuddy response bookkeeping preserves follow-ups and tool-result history", () => {
  const metadata = {
    entryId: "synthetic-entry",
    messageId: "synthetic-message",
    model: "synthetic-old-model",
    rawUsage: { input_tokens: 123 },
    requestModelId: "synthetic-model-id",
    requestModelName: "synthetic-model-name",
    traceId: "synthetic-trace",
    usage: { total_tokens: 456 },
  };
  const messages = [
    { role: "system", content: "synthetic policy" },
    { role: "user", content: "first question" },
    { role: "assistant", content: "first answer" },
    { role: "user", content: "follow-up" },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call",
          type: "function",
          function: { name: "Bash", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "call", content: "synthetic result" },
  ];
  const decorated = messages.map((message) => ({ ...message, ...metadata }));
  const before = JSON.stringify(decorated);
  const parsed = parse(decorated);
  assert.deepEqual(parsed.messages, parse(messages).messages);
  assert.equal(parsed.model, "synthetic");
  assert.equal(JSON.stringify(decorated), before);
  assert.throws(
    () => parse([{ ...decorated[2], content: 42 }]),
    /Message content/,
  );
  assert.doesNotThrow(() =>
    parse([{ ...decorated[2], unknownSemanticField: true }]),
  );
  assert.throws(
    () =>
      validateRequest(
        { model: "synthetic", messages: decorated },
        silentLogger,
        "synthetic-test",
        true,
      ),
    /unsupported fields/,
  );
});

test("entryId on long WorkBuddy history is bookkeeping, not a message limit", () => {
  const messages = Array.from({ length: 64 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `synthetic-${index}`,
  }));
  const decorated = messages.map((message, index) => ({
    ...message,
    entryId: `synthetic-entry-${index}`,
  }));
  const before = JSON.stringify(decorated);
  assert.deepEqual(parse(decorated).messages, parse(messages).messages);
  assert.equal(JSON.stringify(decorated), before);
  assert.doesNotThrow(() =>
    parse([{ ...decorated[63], unknownSemanticField: true }]),
  );
  assert.throws(
    () =>
      validateRequest(
        { model: "synthetic", messages: decorated },
        silentLogger,
        "synthetic-test",
        true,
      ),
    /unsupported fields: entryId/,
  );
});

test("WorkBuddy compaction flags preserve summary text and tool history without scheduling work", () => {
  const messages = [
    { role: "system", content: "synthetic policy" },
    {
      role: "user",
      content: [{ type: "text", text: "Synthetic summary: marker=COMPACT_OK" }],
    },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "call",
          type: "function",
          function: { name: "Bash", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call",
      content: "synthetic cancelled result",
    },
    { role: "user", content: "Continue with the summary." },
  ];
  for (const value of [true, false, null]) {
    const decorated = messages.map((message) => ({
      ...message,
      compactType: "pre-message-auto",
      isCompactInternal: value,
      isCompacted: value,
      isSummary: value,
      skipRun: value,
    }));
    const before = JSON.stringify(decorated);
    assert.deepEqual(parse(decorated).messages, parse(messages).messages);
    assert.equal(JSON.stringify(decorated), before);
    assert.throws(
      () => parse([{ ...decorated[1], content: null }]),
      /Message content/,
    );
    assert.doesNotThrow(() =>
      parse([{ ...decorated[1], unknownSemanticField: true }]),
    );
    assert.throws(
      () =>
        validateRequest(
          { model: "synthetic", messages: decorated },
          silentLogger,
          "synthetic-test",
          true,
        ),
      /unsupported fields/,
    );
  }
});

test("response formats become native schemas instead of ignored prompt hints", () => {
  const messages = [{ role: "user", content: "synthetic" }];
  const schema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  };
  assert.deepEqual(
    parse(messages, {
      response_format: {
        type: "json_schema",
        json_schema: { name: "result", strict: true, schema },
      },
    }).generation?.outputSchema,
    schema,
  );
  assert.deepEqual(
    parse(messages, { response_format: { type: "json_object" } }).generation
      ?.outputSchema,
    { type: "object" },
  );
  assert.equal(
    parse(messages, { response_format: { type: "text" } }).generation,
    undefined,
  );
  assert.throws(
    () =>
      parse(messages, {
        response_format: { type: "json_schema", json_schema: { schema: [] } },
      }),
    /schema/,
  );
  assert.equal(
    parse(messages, { response_format: { type: "unknown" } }).generation,
    undefined,
  );
});

test("verbosity and service tiers delegate unknown names to app-server", () => {
  const messages = [{ role: "user", content: "synthetic" }];
  assert.deepEqual(
    parse(messages, { verbosity: "high", service_tier: "fast" }).generation,
    { verbosity: "high", serviceTier: "priority" },
  );
  assert.deepEqual(parse(messages, { service_tier: "default" }).generation, {
    serviceTier: "default",
  });
  assert.equal(
    parse(messages, { service_tier: "auto", verbosity: null }).generation,
    undefined,
  );
  assert.deepEqual(
    parse(messages, { service_tier: "flex", verbosity: "future_verbosity" })
      .generation,
    { serviceTier: "flex", verbosity: "future_verbosity" },
  );
  assert.throws(() => parse(messages, { verbosity: 1 }), /verbosity/);
  assert.throws(() => parse(messages, { service_tier: {} }), /service_tier/);
});

test("input_text parts use the same lossless text conversion as text parts", () => {
  assert.equal(
    parse([
      {
        role: "user",
        content: [
          { type: "input_text", text: "one" },
          { type: "text", text: "\ntwo" },
        ],
      },
    ]).messages[0]?.content,
    "one\ntwo",
  );
});

/** Checks the common compatibility behavior before native policy resolution. */
test("unmapped controls are accepted with one warning in every profile", () => {
  const body = {
    model: "synthetic",
    messages: [{ role: "user", content: "synthetic" }],
  };
  for (const profile of ["bare", "local", "agent"]) {
    const entries: Record<string, unknown>[] = [];
    const parsed = validateRequest(
      adaptLocalBridgeRequest(
        {
          ...body,
          n: 3,
          parallel_tool_calls: false,
          tool_choice: "required",
          stream_options: { include_usage: false, include_obfuscation: true },
          response_format: { type: "future_format" },
          temperature: 0,
          custom_option: { enabled: true },
        },
        profile === "bare" ? undefined : "synthetic",
        profile === "agent",
      ),
      createLogger("warn", (entry) => {
        entries.push(entry);
      }),
      "synthetic",
      true,
    );
    assert.equal(parsed.includeUsage, false);
    assert.equal(parsed.generation, undefined);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.event, "unsupported_chat_fields_ignored");
    assert.deepEqual(entries[0]?.fields, [
      "custom_option",
      "n",
      "parallel_tool_calls",
      "response_format",
      "stream_options.include_obfuscation",
      "temperature",
      "tool_choice",
    ]);
  }
  for (const extra of [
    { n: 0 },
    { n: "3" },
    { parallel_tool_calls: "false" },
    { tool_choice: 1 },
    { stream_options: { include_usage: "yes" } },
  ])
    assert.throws(
      () => validateRequest({ ...body, ...extra }, silentLogger, "test", true),
      HttpError,
    );
});

/** Converts old function declarations without discarding requested client tools. */
test("legacy functions and selectors map to native tools and reject ambiguous declarations", () => {
  const messages = [{ role: "user", content: "synthetic" }];
  const functions = [
    {
      name: "lookup",
      description: "synthetic",
      parameters: { type: "object" },
    },
  ];
  for (const function_call of ["auto", "required", { name: "lookup" }])
    assert.deepEqual(
      parse(messages, { functions, function_call }).dynamicTools,
      [
        {
          type: "function",
          name: "lookup",
          description: "synthetic",
          inputSchema: { type: "object" },
        },
      ],
    );
  assert.deepEqual(
    parse(messages, { functions, function_call: "none" }).dynamicTools,
    [],
  );
  assert.equal(
    parse(messages, { functions }).requestPolicy.sandbox,
    "disabled",
  );
  for (const extra of [
    { functions: {} },
    { functions: [{ name: "unsafe/name" }] },
    { functions, tools: [] },
    { function_call: "auto", tool_choice: "none" },
    { tool_choice: { type: "function", function: {} } },
  ])
    assert.throws(() => parse(messages, extra), HttpError);
});

/** Accepts client probe token caps without promising an unavailable limit. */
test("token caps are validated and ignored with one explicit warning in every profile", () => {
  const body = {
    model: "synthetic",
    messages: [{ role: "user", content: "Reply with OK." }],
    stream: true,
  };
  for (const profile of ["bare", "local", "agent"]) {
    const adapt = (extra: Record<string, unknown>) =>
      adaptLocalBridgeRequest(
        { ...body, ...extra },
        profile === "bare" ? undefined : "synthetic",
        profile === "agent",
      );
    for (const field of ["max_tokens", "max_completion_tokens"]) {
      const warnings: unknown[] = [];
      const parsed = validateRequest(
        adapt({ [field]: 16, temperature: 0 }),
        createLogger("warn", (entry) => {
          const warning = { ...entry };
          delete warning.time;
          warnings.push(warning);
        }),
        "synthetic-probe",
        true,
      );
      assert.equal(parsed.stream, true);
      assert.equal(parsed.generation, undefined);
      assert.deepEqual(warnings, [
        {
          level: "warn",
          event: "unsupported_chat_fields_ignored",
          request_id: "synthetic-probe",
          fields: [field, "temperature"].sort(),
          output_token_limit_enforced: false,
        },
      ]);
      for (const value of [
        0,
        -1,
        1.5,
        "16",
        true,
        {},
        Number.MAX_SAFE_INTEGER + 1,
      ])
        assert.throws(
          () =>
            validateRequest(
              adapt({ [field]: value }),
              silentLogger,
              "test",
              true,
            ),
          (error: unknown) =>
            error instanceof HttpError &&
            error.status === 400 &&
            error.param === field,
        );
    }
    assert.doesNotThrow(() =>
      validateRequest(
        adapt({ max_tokens: 16, max_completion_tokens: 16 }),
        silentLogger,
        "test",
        true,
      ),
    );
  }
});

test("text part arrays preserve order, whitespace, escapes and every message role", () => {
  for (const role of ["system", "developer", "user", "assistant", "tool"]) {
    const input = {
      role,
      content: [
        { type: "text", text: '中文 "x"\\path\n' },
        { type: "text", text: "" },
        { type: "text", text: "tail" },
      ],
      ...(role === "tool" ? { tool_call_id: "test-call" } : {}),
    };
    const before = JSON.stringify(input);
    const parsed = parse([input]);
    assert.equal(parsed.messages[0]?.content, '中文 "x"\\path\ntail');
    assert.equal(JSON.stringify(input), before);
  }
});

test("assistant tool-only history may omit content without losing call IDs or arguments", () => {
  const call = {
    id: "test-call",
    type: "function",
    function: { name: "Bash", arguments: '{"command":"mock"}' },
  };
  const parsed = parse([
    { role: "assistant", tool_calls: [call] },
    {
      role: "tool",
      tool_call_id: call.id,
      content: [{ type: "text", text: "mock result" }],
    },
  ]);
  assert.equal(parsed.messages[0]?.content, null);
  assert.deepEqual(parsed.messages[0]?.toolCalls, [
    { id: call.id, name: "Bash", arguments: call.function.arguments },
  ]);
  assert.equal(parsed.messages[1]?.toolCallId, call.id);
  assert.equal(parsed.messages[1]?.content, "mock result");
  assert.throws(() => parse([{ role: "assistant" }]), /Message content/);
  assert.throws(
    () => parse([{ role: "assistant", tool_calls: [] }]),
    /Message content/,
  );
});

test("inline user images keep text order in turn and replay mappings", () => {
  const url = "data:image/png;base64,AA==";
  const message = parse([
    {
      role: "user",
      content: [
        { type: "text", text: "before" },
        { type: "image_url", image_url: { url, detail: "low" } },
        { type: "text", text: "after" },
      ],
    },
  ]).messages[0]!;
  assert.equal(message.content, "beforeafter");
  assert.deepEqual(message.contentParts, [
    { type: "text", text: "before" },
    { type: "image", url, detail: "low" },
    { type: "text", text: "after" },
  ]);
  assert.deepEqual(toHistoryItem(message), {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "before" },
      { type: "input_image", image_url: url, detail: "low" },
      { type: "input_text", text: "after" },
    ],
  });
});

test("invalid image URLs and details fail before model dispatch", () => {
  for (const [image, param] of [
    [
      { url: "https://example.invalid/image.png" },
      "messages.0.content.0.image_url.url",
    ],
    [
      { url: "data:image/png;base64,%%%" },
      "messages.0.content.0.image_url.url",
    ],
    [
      { url: "data:image/png;base64,AA==", detail: "original" },
      "messages.0.content.0.image_url.detail",
    ],
    [
      { url: "data:image/png;base64,AA==", unexpected: true },
      "messages.0.content.0.image_url",
    ],
  ] as const) {
    assert.throws(
      () =>
        parse([
          { role: "user", content: [{ type: "image_url", image_url: image }] },
        ]),
      (error: unknown) =>
        error instanceof HttpError &&
        error.status === 400 &&
        error.param === param,
    );
  }
});

test("inline audio is forwarded as a data URL and retained in replay history", () => {
  const message = parse([
    {
      role: "user",
      content: [
        { type: "text", text: "transcribe" },
        { type: "input_audio", input_audio: { data: "AA==", format: "wav" } },
      ],
    },
  ]).messages[0]!;
  assert.deepEqual(message.contentParts, [
    { type: "text", text: "transcribe" },
    { type: "audio", url: "data:audio/wav;base64,AA==" },
  ]);
  assert.deepEqual(toHistoryItem(message), {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "transcribe" },
      { type: "input_audio", audio_url: "data:audio/wav;base64,AA==" },
    ],
  });
});

test("inline PDF becomes ordered page text and images in replay history", async () => {
  const file_data = `data:application/pdf;base64,${syntheticPdf().toString("base64")}`;
  const message = parse([
    {
      role: "user",
      content: [
        { type: "text", text: "summarize" },
        { type: "file", file: { filename: "sample.pdf", file_data } },
      ],
    },
  ]).messages[0]!;
  assert.deepEqual(message.contentParts, [
    { type: "text", text: "summarize" },
    { type: "file", filename: "sample.pdf", data: file_data },
  ]);
  // First use loads PDF.js and a native Canvas binary; Windows CI cold starts
  // can exceed Vitest's five-second default before the small page is rendered.
  await materializePdfParts([message], AbortSignal.timeout(45_000));
  assert.equal(message.contentParts?.[0]?.type, "text");
  assert.match(
    message.contentParts?.[1]?.type === "text"
      ? message.contentParts[1].text
      : "",
    /Synthetic PDF/,
  );
  assert.match(
    message.contentParts?.[2]?.type === "image"
      ? message.contentParts[2].url
      : "",
    /^data:image\/png;base64,/,
  );
  const history = toHistoryItem(message) as {
    content: Array<Record<string, unknown>>;
  };
  assert.equal(history.content[0]?.text, "summarize");
  assert.match(String(history.content[1]?.text), /Synthetic PDF/);
  assert.equal(history.content[2]?.type, "input_image");
}, 60_000);

test("inline CSV and XLSX become ordered model-visible table text", async () => {
  const csv = Buffer.from("name,value\nexample,42\n").toString("base64");
  const xlsx = syntheticXlsx().toString("base64");
  const messages = parse([
    {
      role: "user",
      content: [
        { type: "text", text: "Compare the files" },
        {
          type: "file",
          file: {
            filename: "sample.csv",
            file_data: `data:text/csv;base64,${csv}`,
          },
        },
        {
          type: "file",
          file: {
            filename: "sample.xlsx",
            file_data: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${xlsx}`,
          },
        },
      ],
    },
  ]).messages;
  await materializePdfParts(messages, AbortSignal.timeout(5000));
  const parts = messages[0]!.contentParts!;
  assert.equal(parts.length, 3);
  assert.match(
    parts[1]?.type === "text" ? parts[1].text : "",
    /sample.csv[\s\S]*example/,
  );
  assert.match(
    parts[2]?.type === "text" ? parts[2].text : "",
    /\[sheet: Data\][\s\S]*42/,
  );
});

test("inline files reject undecodable binary and invalid spreadsheets before dispatch", async () => {
  for (const [filename, mime, bytes] of [
    ["sample.bin", "application/octet-stream", Buffer.from([0, 1, 2])],
    [
      "sample.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      Buffer.from("invalid"),
    ],
  ] as const) {
    const messages = parse([
      {
        role: "user",
        content: [
          {
            type: "file",
            file: {
              filename,
              file_data: `data:${mime};base64,${bytes.toString("base64")}`,
            },
          },
        ],
      },
    ]).messages;
    await assert.rejects(
      materializePdfParts(messages, AbortSignal.timeout(5000)),
      (error: unknown) =>
        error instanceof HttpError && error.code === "invalid_file",
    );
  }
});

/** Rejects a ZIP whose directory and local header understate actual expansion. */
test("inline XLSX caps actual decompression despite forged ZIP sizes", async () => {
  const bytes = Buffer.from(
    zipSync({ "xl/worksheets/sheet1.xml": Buffer.alloc(33 * 1024 * 1024, 65) }),
  );
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central > 0);
  bytes.writeUInt32LE(1, 22);
  bytes.writeUInt32LE(1, central + 24);
  const messages = parse([
    {
      role: "user",
      content: [
        {
          type: "file",
          file: {
            filename: "sample.xlsx",
            file_data: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${bytes.toString("base64")}`,
          },
        },
      ],
    },
  ]).messages;
  await assert.rejects(
    materializePdfParts(messages, AbortSignal.timeout(5000)),
    (error: unknown) =>
      error instanceof HttpError && error.code === "invalid_file",
  );
});

test("inline text is preserved and malformed CSV is rejected", async () => {
  const textData = Buffer.from("hello, model", "utf8").toString("base64");
  const textMessages = parse([
    {
      role: "user",
      content: [
        {
          type: "file",
          file: {
            filename: "notes.txt",
            file_data: `data:text/plain;base64,${textData}`,
          },
        },
      ],
    },
  ]).messages;
  await materializePdfParts(textMessages, AbortSignal.timeout(5000));
  assert.match(
    textMessages[0]?.contentParts?.[0]?.type === "text"
      ? textMessages[0].contentParts[0].text
      : "",
    /notes\.txt[\s\S]*hello, model/,
  );
  const badCsv = Buffer.from('"unterminated').toString("base64");
  const csvMessages = parse([
    {
      role: "user",
      content: [
        {
          type: "file",
          file: {
            filename: "bad.csv",
            file_data: `data:text/csv;base64,${badCsv}`,
          },
        },
      ],
    },
  ]).messages;
  await assert.rejects(
    materializePdfParts(csvMessages, AbortSignal.timeout(5000)),
    (error: unknown) =>
      error instanceof HttpError && error.code === "invalid_file",
  );
});

test("inline PDF rejects uploaded IDs, paths, MIME mismatches, and malformed data", () => {
  const file_data = `data:application/pdf;base64,${Buffer.from("%PDF-1.4\nsynthetic").toString("base64")}`;
  for (const [file, param] of [
    [
      { file_id: "file-synthetic", filename: "sample.pdf" },
      "messages.0.content.0.file.file_data",
    ],
    [
      { file_data, filename: "../sample.pdf" },
      "messages.0.content.0.file.filename",
    ],
    [
      { file_data: "data:application/pdf;base64,AA==", filename: "sample.pdf" },
      "messages.0.content.0.file.file_data",
    ],
  ] as const) {
    assert.throws(
      () => parse([{ role: "user", content: [{ type: "file", file }] }]),
      (error: unknown) =>
        error instanceof HttpError &&
        error.status === 400 &&
        error.param === param,
    );
  }
});

test("PDF page limit rejects the whole request before dispatch", async () => {
  const file_data = `data:application/pdf;base64,${syntheticPdf("Synthetic PDF", 17).toString("base64")}`;
  const messages = parse([
    {
      role: "user",
      content: [{ type: "file", file: { filename: "large.pdf", file_data } }],
    },
  ]).messages;
  await assert.rejects(
    materializePdfParts(messages, AbortSignal.timeout(5000)),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === "invalid_pdf" &&
      error.param === "messages.0.content.0.file",
  );
});

test("non-text and malformed parts have precise errors and are never dropped", () => {
  for (const [part, code, param] of [
    [
      {
        type: "image_url",
        image_url: { url: "https://example.invalid/image" },
      },
      "invalid_request",
      "messages.1.content.1.image_url.url",
    ],
    [
      {
        type: "input_audio",
        input_audio: { data: "synthetic", format: "wav" },
      },
      "invalid_request",
      "messages.1.content.1.input_audio.data",
    ],
    [
      { type: "file", file: { file_id: "synthetic" } },
      "invalid_request",
      "messages.1.content.1.file.file_data",
    ],
    [
      { type: "text", text: 123 },
      "invalid_content_part",
      "messages.1.content.1.text",
    ],
    [null, "invalid_content_part", "messages.1.content.1"],
    ["raw text", "invalid_content_part", "messages.1.content.1"],
  ] as const) {
    assert.throws(
      () =>
        parse([
          { role: "system", content: "test" },
          {
            role: "user",
            content: [
              { type: "text", text: "do not silently keep only this" },
              part,
            ],
          },
        ]),
      (error: unknown) =>
        error instanceof HttpError &&
        error.status === 400 &&
        error.code === code &&
        error.param === param,
    );
  }
});

test("compatibility keeps invalid roles, null user/tool content and broken calls rejected", () => {
  for (const message of [
    null,
    { role: "invalid", content: [] },
    { role: "user", content: null },
    { role: "tool", content: null, tool_call_id: "id" },
    { role: "tool", content: [] },
    { role: "assistant", tool_calls: [{ bad: true }] },
    {
      role: "assistant",
      tool_calls: [
        {
          id: "id",
          type: "function",
          function: { name: "Bash", arguments: { command: "mock" } },
        },
      ],
    },
  ])
    assert.throws(() => parse([message]), HttpError);
  assert.equal(parse([{ role: "user", content: [] }]).messages[0]?.content, "");
  const body = {
    messages: [{ role: "user", content: [{ type: "text", text: "test" }] }],
  };
  assert.equal(adaptLocalBridgeRequest(body, undefined), body);
  assert.doesNotThrow(() =>
    parse([{ role: "user", content: "test" }], { tool_choice: "required" }),
  );
});

test("a function with omitted parameters becomes an explicit zero-argument tool", () => {
  const parsed = parse([{ role: "user", content: "test" }], {
    tools: [
      {
        type: "function",
        function: { name: "get_status", description: "Status" },
      },
    ],
  });
  assert.deepEqual(parsed.dynamicTools[0]?.inputSchema, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  assert.throws(
    () =>
      parse([{ role: "user", content: "test" }], {
        tools: [
          {
            type: "function",
            function: { name: "get_status", parameters: null },
          },
        ],
      }),
    /parameters/,
  );
});

test("empty optional assistant response metadata can be replayed without dropping real values", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "reply" }],
    tool_calls: null,
    reasoning_content: null,
    reasoning: null,
    refusal: null,
    audio: null,
    annotations: [],
  };
  const before = JSON.stringify(message);
  assert.equal(parse([message]).messages[0]?.content, "reply");
  assert.equal(JSON.stringify(message), before);
  assert.throws(
    () => parse([{ ...message, audio: { id: "real-audio" } }]),
    /unsupported fields/,
  );
  assert.throws(
    () => parse([{ ...message, refusal: "real refusal" }]),
    /unsupported fields/,
  );
  assert.throws(
    () => parse([{ ...message, annotations: [{ type: "citation" }] }]),
    /unsupported fields/,
  );
});
