import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BUDGETS } from "../src/core/budget";
import { CONTINUE_TEXT, type TaskNotice } from "../src/core/currentTask";
import { SessionController } from "../src/core/sessionController";
import type { BudgetLevel } from "../src/shared/model";
import { QUESTION } from "./forms.test";
import { MemoryStore, MockClient } from "./mockClient";

const DIR = "/work/repo";
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const ev = (type: string, data: Record<string, unknown>) => ({ type, data: { sessionID: "ses_1", ...data } });
const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };

function setup(budget: BudgetLevel = "off") {
  const client = new MockClient();
  const notices: TaskNotice[] = [];
  const c = new SessionController(
    client,
    new MemoryStore(),
    { onEvents() {}, onTranscriptReset() {}, onStateChanged() {}, onTaskNotice: (n) => notices.push(n) },
    { info() {}, warn() {}, error() {} },
    () => ({
      model: "",
      agent: "",
      budgetLevel: budget,
      budget: { presets: { ...DEFAULT_BUDGETS, small: { maxCost: null, maxSteps: 3 } }, warnAt: 0.8 },
    }),
    { debounceMs: 1, stopCheckMs: 20, modelRetryMs: 1 },
  );
  return { c, client, notices };
}

/** Simulates OpenCode's event order for a prompt: enqueued → execution.started → delivered. */
async function run(c: SessionController, text: string) {
  await c.send(text, []);
  const id = `msg_${text.length}_${Math.random().toString(36).slice(2, 6)}`;
  c.handleRawEvent(
    ev("session.inbox.enqueued", {
      inboxID: id,
      item: { type: "user", payload: { text }, delivery: "steer" },
    }),
  );
  c.handleRawEvent(ev("session.execution.started", {}));
  c.handleRawEvent(ev("session.inbox.delivered", { inboxID: id }));
  return id;
}
const finish = (c: SessionController, outcome: "succeeded" | "failed" | "interrupted") =>
  c.handleRawEvent(
    ev(`session.execution.${outcome}`, outcome === "failed" ? { error: { type: "x", message: "boom" } } : {}),
  );

describe("Current Task", () => {
  it("1. the first task appears with status Running", async () => {
    const { c } = setup();
    await c.setDirectory(DIR);
    await run(c, "Close the release checklist only.\n\nRepository:\n/Users/me/repo");
    const v = c.taskView();
    assert.equal(v?.label, "current");
    assert.equal(v?.summary, "Close the release checklist only.");
    assert.equal(v?.status, "running");
  });

  it("2. a new task replaces the previous one; 3. a finished task becomes Last Task", async () => {
    const { c } = setup();
    await c.setDirectory(DIR);
    await run(c, "First task");
    finish(c, "succeeded");
    assert.deepEqual(
      [c.taskView()?.label, c.taskView()?.status, c.taskView()?.summary],
      ["last", "completed", "First task"],
    );
    await run(c, "Second task");
    assert.deepEqual([c.taskView()?.label, c.taskView()?.summary], ["current", "Second task"]);
  });

  it("4. Stop keeps the task, marked Stopped", async () => {
    const { c } = setup();
    await c.setDirectory(DIR);
    await run(c, "Long task");
    await c.stop();
    finish(c, "interrupted");
    assert.deepEqual(
      [c.taskView()?.label, c.taskView()?.status, c.taskView()?.summary],
      ["last", "stopped", "Long task"],
    );
  });

  it("5. a Budget Guard stop keeps the task (Stopped — budget reached); 6. Continue once keeps the same task", async () => {
    const { c, client } = setup("small");
    await c.setDirectory(DIR);
    const id = await run(c, "Refactor everything");
    for (let i = 0; i < 3; i++)
      c.handleRawEvent(ev("session.step.ended", { assistantMessageID: `m${i}`, tokens }));
    await tick();
    assert.equal(client.callsTo("interrupt").length, 1);
    finish(c, "interrupted");
    assert.equal(c.taskView()?.status, "budget-stopped");
    assert.equal(c.taskView()?.id, id);
    const card = c.transcript.items.find((i) => i.kind === "budget" && i.state === "stopped");
    await c.budgetContinueOnce(card!.id);
    c.handleRawEvent(
      ev("session.inbox.enqueued", {
        inboxID: "cont",
        item: { type: "user", payload: { text: CONTINUE_TEXT }, delivery: "steer" },
      }),
    );
    c.handleRawEvent(ev("session.execution.started", {}));
    c.handleRawEvent(ev("session.inbox.delivered", { inboxID: "cont" }));
    assert.equal(c.taskView()?.id, id, "same task, no new entry");
    assert.equal(c.taskView()?.status, "running");
  });

  it("7. a steer does not replace the task and is shown as Latest steer", async () => {
    const { c } = setup();
    await c.setDirectory(DIR);
    const id = await run(c, "Finish Inventory");
    await c.send("Do not touch Finance yet.", [], "steer");
    c.handleRawEvent(
      ev("session.inbox.enqueued", {
        inboxID: "s1",
        item: { type: "user", payload: { text: "Do not touch Finance yet." }, delivery: "steer" },
      }),
    );
    c.handleRawEvent(ev("session.inbox.delivered", { inboxID: "s1" }));
    assert.equal(c.taskView()?.id, id);
    assert.equal(c.taskView()?.steer, "Do not touch Finance yet.");
  });

  it("8. queued messages appear as Next with a count; 9. removing one updates Next; delivery starts it as the task", async () => {
    const { c } = setup();
    await c.setDirectory(DIR);
    await run(c, "Task A");
    for (const [id, text] of [
      ["q1", "Run the targeted PostgreSQL tests"],
      ["q2", "Then lint"],
      ["q3", "Then commit"],
    ]) {
      c.handleRawEvent(
        ev("session.inbox.enqueued", {
          inboxID: id,
          item: { type: "user", payload: { text }, delivery: "queue" },
        }),
      );
    }
    assert.deepEqual(c.taskView()?.next, { summary: "Run the targeted PostgreSQL tests", more: 2 });
    await c.cancelPending("q2");
    assert.deepEqual(c.taskView()?.next, { summary: "Run the targeted PostgreSQL tests", more: 1 });
    c.handleRawEvent(ev("session.inbox.delivered", { inboxID: "q1" }));
    assert.equal(c.taskView()?.summary, "Run the targeted PostgreSQL tests");
    assert.deepEqual(c.taskView()?.next, { summary: "Then commit", more: 0 });
  });

  it("10. reopening a session restores the task from stored messages", async () => {
    const { c, client, notices } = setup();
    await c.setDirectory(DIR);
    client.sessions = [
      {
        id: "ses_old",
        title: "We need title only. Massive request",
        created: 1,
        updated: 1,
        agent: null,
        modelKey: null,
        variant: null,
        outcome: null,
        cost: 0,
      },
    ];
    client.messages = [
      { id: "u1", type: "user", text: "Old task" },
      { id: "a1", type: "assistant", finish: "stop", content: [] },
      { id: "i1", type: "idle", outcome: "succeeded" },
      { id: "u2", type: "user", text: "Release Closure Verification\n\nDetails" },
      { id: "a2", type: "assistant", finish: "tool-calls", content: [] },
      { id: "u3", type: "user", text: "Steered note" },
      { id: "a3", type: "assistant", finish: "stop", content: [] },
      { id: "i2", type: "idle", outcome: "interrupted" },
    ];
    client.forms = [
      {
        id: "frm_x",
        sessionID: "ses_old",
        title: "Q",
        fields: [{ key: "q", type: "boolean" }],
        toolId: null,
      },
    ];
    await c.openSession("ses_old");
    const v = c.taskView();
    assert.deepEqual(
      [v?.id, v?.label, v?.summary, v?.status, v?.steer],
      ["u2", "last", "Release Closure Verification", "stopped", "Steered note"],
    );
    assert.equal(notices.length, 0, "reopen never replays notifications");
  });

  it("11/12. keeps the exact full prompt (Markdown, code, Arabic) for expand and Copy Prompt", async () => {
    const { c } = setup();
    await c.setDirectory(DIR);
    const big = [
      "# Master prompt",
      "",
      "- item 1",
      "- item 2",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "نص عربي",
      ...Array.from({ length: 3000 }, (_, i) => `line ${i}`),
    ].join("\n");
    await run(c, big);
    assert.equal(c.taskPrompt()?.text, big);
    assert.equal(c.taskView()?.summary, "Master prompt");
    assert.equal(c.taskView()?.lines, big.split("\n").length);
    assert.equal(c.taskView()?.chars, big.length);
  });

  it("12b. Copy Prompt includes inline selection snippets exactly as sent", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    await c.send("Explain only this", [
      {
        kind: "selection",
        id: "s",
        relPath: "a.ts",
        absPath: `${DIR}/a.ts`,
        startLine: 1,
        endLine: 2,
        text: "a\nb",
        languageId: "ts",
      },
    ]);
    const sent = (client.callsTo("prompt")[0].args[1] as { text: string }).text;
    assert.equal(c.taskPrompt()?.text, sent);
    assert.equal(c.taskView()?.summary, "Explain only this");
  });

  it("13. Arabic prompts", async () => {
    const { c } = setup();
    await c.setDirectory(DIR);
    await run(c, "أغلق المرحلة ب/ج فقط.\nالتفاصيل");
    assert.equal(c.taskView()?.summary, "أغلق المرحلة ب/ج فقط.");
  });

  it("14. an empty or new session shows no task", async () => {
    const { c } = setup();
    await c.setDirectory(DIR);
    assert.equal(c.taskView(), null);
    await run(c, "Something");
    await c.newSession();
    assert.equal(c.taskView(), null);
  });

  it("15. a broken or missing session title does not affect the task", async () => {
    const { c } = setup();
    await c.setDirectory(DIR);
    await run(c, "Implement the receipt formatter");
    c.handleRawEvent(ev("session.renamed", { title: "We need title only. Massive request title..." }));
    assert.equal(c.taskView()?.summary, "Implement the receipt formatter");
    assert.notEqual(
      c.currentTitle(),
      c.taskView()?.summary === undefined ? null : "We need title only. Massive request title...",
    );
  });

  it("shows Waiting for you while a question or permission is pending", async () => {
    const { c } = setup();
    await c.setDirectory(DIR);
    await run(c, "Ask me");
    c.handleRawEvent({ type: "form.created", data: { form: { ...QUESTION, sessionID: "ses_1" } } });
    assert.equal(c.taskView()?.status, "waiting");
  });
});

describe("task notifications", () => {
  it("notifies a successful completion once, with the task summary", async () => {
    const { c, notices } = setup();
    await c.setDirectory(DIR);
    await run(c, "Release Closure Verification");
    finish(c, "succeeded");
    finish(c, "succeeded"); // duplicate idle marker
    assert.deepEqual(
      notices.map((n) => [n.kind, n.summary]),
      [["completed", "Release Closure Verification"]],
    );
  });

  it("notifies needs-input for questions and permissions (once per request)", async () => {
    const { c, notices } = setup();
    await c.setDirectory(DIR);
    await run(c, "Do it");
    c.handleRawEvent({ type: "form.created", data: { form: { ...QUESTION, sessionID: "ses_1" } } });
    c.handleRawEvent({ type: "form.created", data: { form: { ...QUESTION, sessionID: "ses_1" } } });
    c.handleRawEvent(ev("permission.asked", { id: "per_1", action: "read", resources: [".env"] }));
    assert.deepEqual(
      notices.map((n) => n.kind),
      ["needs-input", "needs-input"],
    );
  });

  it("notifies failures", async () => {
    const { c, notices } = setup();
    await c.setDirectory(DIR);
    await run(c, "Do it");
    finish(c, "failed");
    assert.deepEqual(
      notices.map((n) => n.kind),
      ["failed"],
    );
  });

  it("notifies a Budget Guard stop, never a completion for it, and Continue once creates no fake completion", async () => {
    const { c, notices } = setup("small");
    await c.setDirectory(DIR);
    await run(c, "Big refactor");
    for (let i = 0; i < 3; i++)
      c.handleRawEvent(ev("session.step.ended", { assistantMessageID: `m${i}`, tokens }));
    await tick();
    finish(c, "interrupted");
    assert.deepEqual(
      notices.map((n) => n.kind),
      ["budget-stopped"],
    );
    const card = c.transcript.items.find((i) => i.kind === "budget" && i.state === "stopped");
    await c.budgetContinueOnce(card!.id);
    assert.deepEqual(
      notices.map((n) => n.kind),
      ["budget-stopped"],
      "continuing is not a completion",
    );
    c.handleRawEvent(ev("session.execution.started", {}));
    finish(c, "succeeded");
    assert.deepEqual(
      notices.map((n) => [n.kind, n.summary]),
      [
        ["budget-stopped", "Big refactor"],
        ["completed", "Big refactor"],
      ],
    );
  });

  it("a user Stop is not reported as completed", async () => {
    const { c, notices } = setup();
    await c.setDirectory(DIR);
    await run(c, "Stop me");
    await c.stop();
    finish(c, "interrupted");
    assert.equal(notices.length, 0);
  });
});
