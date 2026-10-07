import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWebviewMessage } from "../src/shared/protocol";

describe("webview message schema", () => {
  it("accepts well-formed messages", () => {
    assert.deepEqual(parseWebviewMessage({ type: "ready" }), { type: "ready" });
    assert.deepEqual(parseWebviewMessage({ type: "send", text: "hi" }), { type: "send", text: "hi" });
    assert.ok(parseWebviewMessage({ type: "respondPermission", requestId: "per_1", decision: "once" }));
    assert.ok(parseWebviewMessage({ type: "openDiff", path: "src/a.ts" }));
  });

  it("rejects unknown types and non-objects", () => {
    for (const bad of [
      null,
      undefined,
      1,
      "send",
      [],
      { type: "eval", code: "1" },
      { type: "__proto__" },
      { type: "toString" },
    ]) {
      assert.equal(parseWebviewMessage(bad), undefined, JSON.stringify(bad));
    }
  });

  it("rejects wrong field types", () => {
    assert.equal(parseWebviewMessage({ type: "send", text: 42 }), undefined);
    assert.equal(parseWebviewMessage({ type: "selectSession", id: "" }), undefined);
    assert.equal(parseWebviewMessage({ type: "selectModel" }), undefined);
  });

  it("rejects unexpected extra fields", () => {
    assert.equal(parseWebviewMessage({ type: "stop", force: true }), undefined);
    assert.equal(parseWebviewMessage({ type: "send", text: "x", files: ["/etc/passwd"] }), undefined);
  });

  it("only allows real permission decisions", () => {
    assert.equal(
      parseWebviewMessage({ type: "respondPermission", requestId: "per_1", decision: "allow-all" }),
      undefined,
    );
    assert.equal(
      parseWebviewMessage({ type: "respondPermission", requestId: "per_1", decision: "always" })?.type,
      "respondPermission",
    );
  });

  it("bounds message sizes", () => {
    assert.equal(parseWebviewMessage({ type: "send", text: "x".repeat(200_001) }), undefined);
    assert.equal(parseWebviewMessage({ type: "selectSession", id: "x".repeat(513) }), undefined);
  });
});
