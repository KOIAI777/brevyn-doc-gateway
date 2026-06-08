import { sha256Buffer, sha256String } from "./util.js";

export function extractInputFile(body) {
  const stack = [body.input, body.messages, body.content, body];
  while (stack.length) {
    const current = stack.shift();
    if (!current) continue;
    if (Array.isArray(current)) {
      stack.unshift(...current);
      continue;
    }
    if (typeof current !== "object") continue;

    const type = current.type;
    if (type === "input_file" || current.file_data || current.fileData || current.data) {
      const filename = current.filename || current.name || current.file_name || current.fileName || "document";
      const rawData = current.file_data || current.fileData || current.data;
      if (typeof rawData !== "string" || rawData.length === 0) {
        continue;
      }
      const { buffer, mediaType } = decodeFileData(rawData);
      return {
        filename,
        mediaType: current.media_type || current.mime_type || current.mimeType || mediaType || "application/octet-stream",
        buffer,
        sha256: sha256Buffer(buffer)
      };
    }

    if (current.content) stack.push(current.content);
    if (current.file) stack.push(current.file);
  }

  throw new Error("No input_file with file_data was found");
}

export function parseOptions(body) {
  return {
    ...(body.parse_options || {}),
    ...(body.document_parse_options || {})
  };
}

export function cacheKeyFor({ file, model, mineruModel, options }) {
  return sha256String(JSON.stringify({
    fileSha256: file.sha256,
    filename: file.filename,
    model,
    mineruModel,
    mode: options.mode,
    options
  }));
}

function decodeFileData(value) {
  const dataUrlMatch = value.match(/^data:([^;,]+)?(?:;[^,]*)?,(.*)$/s);
  if (dataUrlMatch) {
    return {
      mediaType: dataUrlMatch[1] || "",
      buffer: Buffer.from(dataUrlMatch[2], "base64")
    };
  }
  return {
    mediaType: "",
    buffer: Buffer.from(value, "base64")
  };
}
