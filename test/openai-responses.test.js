import assert from "node:assert/strict";
import test from "node:test";

import { cacheKeyFor, extractInputFile, parseOptions } from "../src/openai-responses.js";

test("extractInputFile reads OpenAI Responses-style input_file", () => {
  const body = {
    model: "brevyn-doc-parse",
    input: [{
      role: "user",
      content: [{
        type: "input_file",
        filename: "lecture.pdf",
        file_data: `data:application/pdf;base64,${Buffer.from("pdf-bytes").toString("base64")}`
      }]
    }]
  };

  const file = extractInputFile(body);
  assert.equal(file.filename, "lecture.pdf");
  assert.equal(file.mediaType, "application/pdf");
  assert.equal(file.buffer.toString("utf8"), "pdf-bytes");
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
});

test("parseOptions merges supported option fields", () => {
  const options = parseOptions({
    parse_options: { is_ocr: true },
    document_parse_options: { language: "ch" }
  });

  assert.deepEqual(options, {
    is_ocr: true,
    language: "ch"
  });
});

test("cache key is stable for identical file and options", () => {
  const file = {
    sha256: "abc",
    filename: "a.pdf"
  };
  const input = {
    file,
    model: "brevyn-doc-parse",
    mineruModel: "MinerU2.5",
    options: { table_enable: true }
  };

  assert.equal(cacheKeyFor(input), cacheKeyFor(input));
});
