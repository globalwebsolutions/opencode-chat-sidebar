import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpOpenCodeClient } from "../src/opencode/client";
import { EventNormalizer } from "../src/opencode/events";
import { parseWebviewMessage } from "../src/shared/protocol";
import { QUESTION } from "./forms.test";

describe("v0.2 webview messages", () => {
  it("accepts the new intents", () => {
    for (const m of [
      { type: "send", text: "x", delivery: "queue" },
      { type: "copyMessage", itemId: "text:m:0", requestId: "c1" },
      { type: "copy", text: "code", requestId: "c2" },
      { type: "selectVariant", variant: "" },
      { type: "selectVariant", variant: "high" },
      { type: "selectBudget", level: "small" },
      { type: "budgetAction", itemId: "budget:1", action: "continue" },
      { type: "answerForm", formId: "frm_1", answer: { q0: "Blue", n: 3, ok: true, tags: ["a"] } },
      { type: "cancelForm", formId: "frm_1" },
      { type: "editPending", id: "msg_1" },
      { type: "removePending", id: "msg_1" },
      { type: "openAgentDiff", path: "a.txt" },
      { type: "openAgentDiffAll" },
      { type: "openWorkspaceDiffAll" },
      { type: "retryLast" },
      { type: "focusModelPicker" },
      { type: "dismissHint" },
    ]) {
      assert.ok(parseWebviewMessage(m), JSON.stringify(m));
    }
  });

  it("rejects malformed v0.2 intents", () => {
    for (const m of [
      { type: "send", text: "x", delivery: "now" },
      { type: "selectBudget", level: "huge" },
      { type: "budgetAction", itemId: "b", action: "ignore" },
      { type: "answerForm", formId: "f", answer: { q: { nested: 1 } } },
      { type: "answerForm", formId: "f", answer: ["x"] },
      { type: "answerForm", formId: "f", answer: JSON.parse('{"__proto__": "x"}') },
      { type: "answerForm", formId: "f", answer: { n: Infinity } },
      { type: "copyMessage", itemId: "x" },
      { type: "copy", text: "x" },
      { type: "copy", text: "x".repeat(5_000_001), requestId: "c" },
    ]) {
      assert.equal(parseWebviewMessage(m), undefined, JSON.stringify(m).slice(0, 80));
    }
  });
});

describe("v0.2 event normalization", () => {
  it("maps inbox delivery events", () => {
    const n = new EventNormalizer();
    const e = n.normalize({
      type: "session.inbox.enqueued",
      data: {
        sessionID: "s",
        inboxID: "msg_1",
        item: { type: "user", payload: { text: "Queued: x" }, delivery: "queue" },
      },
    });
    assert.deepEqual(e?.events, [
      { type: "inbox.enqueued", id: "msg_1", text: "Queued: x", attachments: [], delivery: "queue" },
    ]);
    assert.deepEqual(
      n.normalize({ type: "session.inbox.delivered", data: { sessionID: "s", inboxID: "msg_1" } })?.events,
      [{ type: "inbox.delivered", id: "msg_1" }],
    );
    assert.deepEqual(
      n.normalize({ type: "session.inbox.cancelled", data: { sessionID: "s", inboxID: "msg_1" } })?.events,
      [{ type: "inbox.cancelled", id: "msg_1" }],
    );
  });

  it("maps form events and routes them by the form's session", () => {
    const n = new EventNormalizer();
    const created = n.normalize({ type: "form.created", data: { form: QUESTION } });
    assert.equal(created?.sessionID, QUESTION.sessionID);
    assert.equal(created?.events[0].type, "form.requested");
    assert.deepEqual(
      n.normalize({ type: "form.replied", data: { id: QUESTION.id, sessionID: "s", answer: { q0: "Blue" } } })
        ?.events,
      [{ type: "form.resolved", formId: QUESTION.id, status: "answered", answer: { q0: "Blue" } }],
    );
    assert.deepEqual(
      n.normalize({ type: "form.cancelled", data: { id: QUESTION.id, sessionID: "s" } })?.events,
      [{ type: "form.resolved", formId: QUESTION.id, status: "cancelled", answer: null }],
    );
  });

  it("names the model in execution failures", () => {
    const n = new EventNormalizer();
    n.normalize({
      type: "session.step.started",
      data: {
        sessionID: "s",
        assistantMessageID: "m",
        model: { providerID: "opencode-go", id: "minimax-m3" },
      },
    });
    const f = n.normalize({
      type: "session.execution.failed",
      data: {
        sessionID: "s",
        error: {
          type: "provider.api",
          message: "Insufficient account funds",
          status: 402,
          response: { body: "{}" },
        },
      },
    });
    assert.deepEqual(f?.events[0], {
      type: "session.error",
      message: "Insufficient account funds",
      error: { type: "provider.api", message: "Insufficient account funds", status: 402, body: "{}" },
      modelKey: "opencode-go/minimax-m3",
    });
  });
});

describe("v0.2 client requests", () => {
  function mock() {
    const captured: Array<{ url: string; method: string; body: unknown }> = [];
    const fn = (async (input: string | URL, init?: RequestInit) => {
      captured.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/form")) return new Response(JSON.stringify({ data: [QUESTION] }), { status: 200 });
      if (path.endsWith("/inbox"))
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "msg_1",
                type: "user",
                payload: { text: "later", files: [{ name: "a.ts" }] },
                delivery: "queue",
              },
            ],
          }),
          { status: 200 },
        );
      if (path.endsWith("/diff"))
        return new Response(
          JSON.stringify({
            data: [{ file: "a", patch: "p", additions: 1, deletions: 0, status: "modified" }],
          }),
          { status: 200 },
        );
      if (path.endsWith("/message"))
        return new Response(JSON.stringify({ data: [{ id: "u", type: "user", text: "First prompt" }] }), {
          status: 200,
        });
      if (path.endsWith("/prompt"))
        return new Response(JSON.stringify({ data: { id: "msg_9" } }), { status: 200 });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    return { captured, client: new HttpOpenCodeClient({ url: "http://127.0.0.1:9" }, fn) };
  }

  it("uses the documented form, inbox, diff and prompt shapes", async () => {
    const { captured, client } = mock();
    assert.equal((await client.listForms("ses_1"))[0].id, QUESTION.id);
    await client.replyForm("ses_1", "frm_1", { q0: "Blue" });
    assert.deepEqual(captured.at(-1), {
      url: "http://127.0.0.1:9/api/session/ses_1/form/frm_1/reply",
      method: "POST",
      body: { answer: { q0: "Blue" } },
    });
    await client.cancelForm("ses_1", "frm_1");
    assert.equal(captured.at(-1)?.method, "DELETE");
    assert.deepEqual(await client.listInbox("ses_1"), [
      { id: "msg_1", text: "later", attachments: ["a.ts"], delivery: "queue" },
    ]);
    await client.cancelInbox("ses_1", "msg_1");
    assert.deepEqual(captured.at(-1), {
      url: "http://127.0.0.1:9/api/session/ses_1/inbox/msg_1",
      method: "DELETE",
      body: undefined,
    });
    await client.prompt("ses_1", { text: "x", files: [], delivery: "steer" });
    assert.deepEqual(captured.at(-1)?.body, { text: "x", delivery: "steer" });
    await client.switchModel("ses_1", { providerID: "p", id: "m", variant: "high" });
    assert.deepEqual(captured.at(-1)?.body, { model: { providerID: "p", id: "m", variant: "high" } });
    const d = await client.sessionDiff("ses_1", { from: "msg_a", to: "msg_b", full: true });
    assert.equal(d[0].patch, "p");
    const q = new URL(captured.at(-1)!.url).searchParams;
    assert.equal(q.get("from"), "msg_a");
    assert.equal(q.get("to"), "msg_b");
    assert.equal(q.get("context"), null, "full-file patches omit context");
    assert.equal(await client.firstUserText("ses_1"), "First prompt");
  });
});
