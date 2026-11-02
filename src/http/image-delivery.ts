import { randomUUID } from "node:crypto";
import { record } from "../core/canonical.js";
import type { StoredToolCall } from "../continuation/state.js";
import { usesImageFiles, IMAGE_FILE_PREFIX } from "./image-files.js";

/** Selects only client file tools whose advertised schema supports safe downloads. */
export function nativeImageTool(
  tools: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  if (!usesImageFiles(tools)) return;
  for (const tool of tools) {
    const schema = record(tool.inputSchema),
      properties = record(schema?.properties);
    if (tool.name !== "Bash" || record(properties?.command)?.type !== "string")
      continue;
    if (
      schema?.required !== undefined &&
      (!Array.isArray(schema.required) ||
        !schema.required.every(
          (key) =>
            typeof key === "string" &&
            ["command", "description", "timeout"].includes(key),
        ))
    )
      continue;
    if (
      Array.isArray(schema?.required) &&
      schema.required.some(
        (key) => key !== "command" && !record(properties?.[key]),
      )
    )
      continue;
    if (
      Array.isArray(schema?.required) &&
      schema.required.some((key) =>
        key === "description"
          ? record(properties?.description)?.type !== "string"
          : key === "timeout"
            ? !["number", "integer"].includes(
                String(record(properties?.timeout)?.type),
              )
            : false,
      )
    )
      continue;
    return schema;
  }
  return;
}

/** Builds one client-side download; only this listener's exact capabilities are allowed. */
export function nativeImageDownload(
  sources: string[],
  origin: string,
  schema: Record<string, unknown>,
): StoredToolCall {
  if (!sources.length || sources.length > 16)
    throw new Error("Invalid generated image count");
  const files = [...new Set(sources)].map((source) => {
    const url = new URL(source);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !new RegExp(
        "^" + IMAGE_FILE_PREFIX + "[a-f0-9]{64}\\.(png|jpg|webp|gif)$",
        "u",
      ).test(url.pathname)
    )
      throw new Error("Invalid generated image source");
    return {
      url: url.href,
      name:
        "bridge-" +
        randomUUID().replaceAll("-", "") +
        "." +
        url.pathname.split(".").at(-1)!,
    };
  });
  // URLs are Python data; the shell only sees generated destinations. Verify original
  // bytes before explicit cp publication, which triggers WorkBuddy's native card.
  const script = `import json, pathlib, sys, urllib.request
files = json.loads(${JSON.stringify(JSON.stringify(files))})
root = pathlib.Path('outputs')
root.mkdir(exist_ok=True)
images = []
total = 0
if len(files) != len(sys.argv) - 1:
    raise RuntimeError('Invalid destination count')
for entry, destination in zip(files, sys.argv[1:]):
    with urllib.request.urlopen(entry['url'], timeout=60) as response:
        data = response.read(20 * 1024 * 1024 + 1)
    total += len(data)
    if not data or len(data) > 20 * 1024 * 1024 or total > 80 * 1024 * 1024:
        raise RuntimeError('Generated image exceeds download limit')
    extension = entry['name'].rsplit('.', 1)[1]
    valid = (extension == 'png' and data.startswith(b'\\x89PNG\\r\\n\\x1a\\n') or
             extension == 'jpg' and data.startswith(b'\\xff\\xd8\\xff') or
             extension == 'webp' and data.startswith(b'RIFF') and data[8:12] == b'WEBP' or
             extension == 'gif' and data[:6] in (b'GIF87a', b'GIF89a'))
    if not valid:
        raise RuntimeError('Invalid original image file')
    path = pathlib.Path(destination)
    if path != root / entry['name']:
        raise RuntimeError('Invalid original image destination')
    if path.exists():
        raise FileExistsError('Original image destination already exists')
    with path.with_suffix('.download').open('xb') as output:
        output.write(data)
    images.append({'localPath': str(path.resolve())})
print(json.dumps({'type': 'image_gen_tool_result', 'status': 'completed', 'images': images}))
`;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const paths = files.map((file) => "outputs/" + file.name);
  const copies = paths.map((path) => {
    const staging = path.replace(/\.(png|jpg|webp|gif)$/, ".download");
    return (
      "cp -n " + quote(staging) + " " + quote(path) + " && rm " + quote(staging)
    );
  });
  const args: Record<string, unknown> = {
    command:
      "python3 -c " +
      quote("exec(" + JSON.stringify(script) + ")") +
      " " +
      paths.map(quote).join(" ") +
      " && " +
      copies.join(" && "),
  };
  const properties = record(schema.properties);
  if (record(properties?.description)?.type === "string")
    args.description = "保存生成的原始图片，供聊天卡片预览、复制和下载";
  const timeout = record(properties?.timeout);
  if (timeout?.type === "number" || timeout?.type === "integer")
    args.timeout = Math.min(
      120000,
      typeof timeout.maximum === "number" ? timeout.maximum : 120000,
    );
  return {
    callId: "call_imgfile_" + randomUUID().replaceAll("-", ""),
    name: "Bash",
    arguments: JSON.stringify(args),
  };
}
