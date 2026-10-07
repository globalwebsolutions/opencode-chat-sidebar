import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyError, describeForLog, safeMessage } from "../src/core/errors";

const ctx = { modelName: "MiniMax M3", providerName: "OpenCode Go" };

describe("upstream error UX", () => {
  it("explains insufficient funds and names the model/provider", () => {
    const f = classifyError(
      {
        type: "provider.api",
        message: "Upstream request failed: Insufficient account funds",
        status: null,
        body: null,
      },
      ctx,
    );
    assert.equal(f.kind, "funds");
    assert.equal(f.title, "MiniMax M3 (OpenCode Go) reported insufficient funds.");
    assert.deepEqual(f.actions, ["changeModel", "retry"]);
    assert.match(f.detail, /Insufficient account funds/);
  });

  for (const [msg, status, kind] of [
    ["Rate limit exceeded", 429, "rate-limit"],
    ["Invalid API key provided", 401, "auth"],
    ["This model's maximum context length is 128000 tokens", 400, "context-length"],
    ["The model `foo` does not exist", 404, "model-not-found"],
    ["Overloaded", 529, "overloaded"],
    ["ConnectionRefused: Unable to connect", null, "network"],
    ["You exceeded your current quota", 429, "quota"],
    ["Monthly limit reached for this key", null, "quota"],
    ["Something odd", 500, "unknown"],
  ] as const) {
    it(`classifies "${msg}" as ${kind}`, () => {
      assert.equal(classifyError({ type: "provider.api", message: msg, status, body: null }, ctx).kind, kind);
    });
  }

  it("treats provider.transport errors as network problems", () => {
    assert.equal(
      classifyError({ type: "provider.transport", message: "boom", status: null, body: null }, ctx).kind,
      "network",
    );
  });

  it("works without model context", () => {
    const f = classifyError(
      { type: "x", message: "payment required", status: 402, body: null },
      { modelName: null, providerName: null },
    );
    assert.equal(f.title, "The model provider reported insufficient funds.");
  });

  it("keeps full diagnostics for the log without secrets", () => {
    const line = describeForLog(
      {
        type: "provider.api",
        message: "Insufficient funds; key sk-abcdefghijklmnopqrstuvwxyz123456",
        status: 402,
        body: '{"error":"x","api_key":"secret"}',
      },
      { providerID: "opencode-go", modelKey: "opencode-go/minimax-m3" },
    );
    assert.match(line, /type=provider\.api/);
    assert.match(line, /status=402/);
    assert.match(line, /provider=opencode-go/);
    assert.match(line, /model=opencode-go\/minimax-m3/);
    assert.ok(!line.includes("sk-abcdefghij"));
    assert.ok(!line.includes('"secret"'));
  });

  it("bounds and flattens messages", () => {
    assert.equal(safeMessage("a\n\nb"), "a b");
    assert.ok(safeMessage("x".repeat(1000)).length <= 300);
  });
});
