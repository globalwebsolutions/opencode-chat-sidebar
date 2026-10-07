import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SseParser } from "../src/opencode/sse";

describe("SSE parser", () => {
  it("parses events split across chunks and skips heartbeats", () => {
    const p = new SseParser();
    const out = [
      ...p.push('id: 1\ndata: {"type":"a"'),
      ...p.push("}\n\n: heartbeat\n\n"),
      ...p.push('data: {"type":"b"}\r\n\r\n'),
    ];
    assert.deepEqual(
      out.map((m) => JSON.parse(m.data).type),
      ["a", "b"],
    );
    assert.equal(out[0].id, "1");
  });

  it("joins multi-line data and handles a CRLF split across chunks", () => {
    const p = new SseParser();
    const out = [...p.push("event: x\ndata: line1\r"), ...p.push("\ndata: line2\n\n")];
    assert.deepEqual(out, [{ id: null, event: "x", data: "line1\nline2" }]);
  });
});
