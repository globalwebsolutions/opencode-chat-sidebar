import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionController } from "../src/core/sessionController";
import { MemoryStore, MockClient } from "./mockClient";

const REPORT = [
  "# Release report",
  "",
  "## Summary",
  "- Inventory sync **done**",
  "- Finance: *pending*",
  "  - nested item with `inline code`",
  "1. First",
  "2. Second",
  "",
  "| Module | Status |",
  "|:--|--:|",
  "| Inventory | ✓ |",
  "| المالية | قيد التنفيذ |",
  "",
  "```php",
  "$total = array_sum($prices); // ``` inside? no",
  "```",
  "",
  "تقرير باللغة العربية: تم الانتهاء من **المخزون**.",
  "See [docs](https://opencode.ai).  ",
  "Trailing line",
].join("\n");

function controller() {
  const client = new MockClient();
  const c = new SessionController(
    client,
    new MemoryStore(),
    { onEvents() {}, onTranscriptReset() {}, onStateChanged() {} },
    { info() {}, warn() {}, error() {} },
    () => ({ model: "", agent: "" }),
    {
      debounceMs: 1,
      stopCheckMs: 20,
      modelRetryMs: 1,
    },
  );
  return { c, client };
}
const ev = (type: string, data: Record<string, unknown>) => ({ type, data: { sessionID: "ses_1", ...data } });

async function streamed(text: string, chunk = 7) {
  const { c, client } = controller();
  await c.setDirectory("/r");
  await c.send("report", []);
  c.handleRawEvent(ev("session.execution.started", {}));
  for (let i = 0; i < text.length; i += chunk) {
    c.handleRawEvent(
      ev("session.text.delta", { assistantMessageID: "m", ordinal: 0, delta: text.slice(i, i + chunk) }),
    );
  }
  return { c, client };
}

describe("copy full assistant message", () => {
  it("is not copyable while streaming", async () => {
    const { c } = await streamed(REPORT);
    assert.equal(c.copyText("text:m:0"), null);
  });

  it("copies the exact canonical Markdown once complete (headings, lists, table, fences, Arabic, links)", async () => {
    const { c } = await streamed(REPORT);
    c.handleRawEvent(ev("session.text.ended", { assistantMessageID: "m", ordinal: 0, text: REPORT }));
    c.handleRawEvent(ev("session.execution.succeeded", {}));
    assert.equal(c.copyText("text:m:0"), REPORT);
  });

  it("uses OpenCode's final text, not the streamed reconstruction", async () => {
    const { c } = await streamed("partial wrong");
    c.handleRawEvent(
      ev("session.text.ended", { assistantMessageID: "m", ordinal: 0, text: "Final canonical text" }),
    );
    assert.equal(c.copyText("text:m:0"), "Final canonical text");
  });

  it("allows copying the partial result after an interruption", async () => {
    const { c } = await streamed("Partial analysis:\n- point one");
    c.handleRawEvent(ev("session.execution.interrupted", { reason: "user" }));
    assert.equal(c.copyText("text:m:0"), "Partial analysis:\n- point one");
  });

  it("copies very long reports exactly (≈1.5 MB)", async () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `- line ${i}: ${"العربية English ".repeat(4)}`).join(
      "\n",
    );
    const { c } = await streamed("x", 1);
    c.handleRawEvent(ev("session.text.ended", { assistantMessageID: "m", ordinal: 0, text: big }));
    c.handleRawEvent(ev("session.execution.succeeded", {}));
    const out = c.copyText("text:m:0");
    assert.equal(out?.length, big.length);
    assert.equal(out, big);
  });

  it("copies history messages exactly", async () => {
    const { c, client } = controller();
    await c.setDirectory("/r");
    client.sessions = [
      {
        id: "ses_h",
        title: "H",
        created: 1,
        updated: 1,
        agent: null,
        modelKey: null,
        variant: null,
        outcome: null,
        cost: 0,
      },
    ];
    client.messages = [{ id: "a1", type: "assistant", content: [{ type: "text", text: REPORT }] }];
    await c.openSession("ses_h");
    assert.equal(c.copyText("text:a1:0"), REPORT);
  });

  it("refuses non-assistant items", async () => {
    const { c } = await streamed("x");
    assert.equal(c.copyText("user:msg_1"), null);
    assert.equal(c.copyText("nope"), null);
  });
});
