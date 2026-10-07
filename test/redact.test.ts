import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redact } from "../src/core/redact";

describe("log redaction", () => {
  it("redacts authorization headers", () => {
    assert.equal(
      redact("authorization: Basic b3BlbmNvZGU6c2VjcmV0cGFzc3dvcmQ="),
      "authorization: Basic [redacted]",
    );
  });
  it("redacts password/token fields", () => {
    const out = redact('{"password":"hunter2","token": "abc", "api_key"=xyz}');
    assert.ok(!/hunter2|abc|xyz/.test(out), out);
  });
  it("redacts provider-style keys and URL credentials", () => {
    assert.ok(!redact("key sk-ant-REDACTED_EXAMPLE_KEY_000000000000").includes("sk-ant"));
    assert.equal(redact("http://opencode:pw@127.0.0.1:1"), "http://opencode:[redacted]@127.0.0.1:1");
  });
  it("leaves ordinary text alone", () => {
    assert.equal(
      redact("Connected to OpenCode 2.0.24 at http://127.0.0.1:49374"),
      "Connected to OpenCode 2.0.24 at http://127.0.0.1:49374",
    );
  });
});
