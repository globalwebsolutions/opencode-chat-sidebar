import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BUDGETS } from "../src/core/budget";
import { SessionController } from "../src/core/sessionController";
import { OpenCodeHttpError } from "../src/opencode/client";
import type { BudgetLevel, UiEvent } from "../src/shared/model";
import { QUESTION } from "./forms.test";
import { MemoryStore, MockClient } from "./mockClient";

const DIR = "/work/repo";
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const raw = (type: string, data: Record<string, unknown>) => ({ id: "evt", created: 1, type, data });
const tokens = { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };

function setup(budgetLevel: BudgetLevel = "off") {
  const client = new MockClient();
  const store = new MemoryStore();
  const emitted: UiEvent[] = [];
  const logs: string[] = [];
  const log = {
    info: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
  };
  const c = new SessionController(
    client,
    store,
    { onEvents: (e) => emitted.push(...e), onTranscriptReset() {}, onStateChanged() {} },
    log,
    () => ({
      model: "",
      agent: "",
      budgetLevel,
      budget: { presets: DEFAULT_BUDGETS, warnAt: 0.8 },
      contextWarnPercent: 80,
    }),
    { debounceMs: 1, stopCheckMs: 20, modelRetryMs: 1 },
  );
  return { client, store, c, emitted, logs };
}

async function running(budget: BudgetLevel = "off") {
  const env = setup(budget);
  await env.c.setDirectory(DIR);
  await env.c.send("do the task", []);
  env.c.handleRawEvent(raw("session.execution.started", { sessionID: "ses_1" }));
  return env;
}

function step(c: SessionController, n = 1) {
  for (let i = 0; i < n; i++) {
    c.handleRawEvent(raw("session.step.ended", { sessionID: "ses_1", assistantMessageID: `m${i}`, tokens }));
  }
}

describe("budget guard in the controller", () => {
  it("warns at 80% and interrupts the real run at the hard limit", async () => {
    const { c, client, emitted } = await running("small");
    step(c, 16);
    assert.equal(emitted.filter((e) => e.type === "budget" && e.state === "warning").length, 1);
    assert.equal(client.callsTo("interrupt").length, 0, "warning does not interrupt");
    step(c, 4);
    await tick();
    assert.equal(client.callsTo("interrupt").length, 1, "hard limit calls OpenCode interrupt");
    const stopped = emitted.find((e) => e.type === "budget" && e.state === "stopped");
    assert.ok(
      stopped && stopped.type === "budget" && stopped.text === "Task budget reached. The agent was stopped.",
    );
  });

  it("stops on cost when OpenCode reports it", async () => {
    const { c, client } = await running("small");
    c.handleRawEvent(raw("session.usage.updated", { sessionID: "ses_1", cost: 0.12, tokens }));
    await tick();
    assert.equal(client.callsTo("interrupt").length, 1);
  });

  it("never interrupts when the budget is off", async () => {
    const { c, client } = await running("off");
    step(c, 300);
    c.handleRawEvent(raw("session.usage.updated", { sessionID: "ses_1", cost: 50, tokens }));
    await tick();
    assert.equal(client.callsTo("interrupt").length, 0);
  });

  it("Continue once resumes with one explicit override and keeps the workspace budget", async () => {
    const { c, client, emitted, store } = await running("small");
    step(c, 20);
    await tick();
    c.handleRawEvent(raw("session.execution.interrupted", { sessionID: "ses_1", reason: "user" }));
    const card = emitted.find((e) => e.type === "budget" && e.state === "stopped");
    assert.ok(card && card.type === "budget");
    assert.equal(await c.budgetContinueOnce(card.id), true);
    assert.equal(client.callsTo("prompt").length, 2, "continuation prompt sent");
    assert.equal(c.budget.level, "small");
    assert.equal(store.get(`opencodeSidebar.budget:${DIR}`), undefined, "workspace budget not changed");
    c.handleRawEvent(raw("session.execution.started", { sessionID: "ses_1" }));
    assert.equal(c.budgetView().taskSteps, 20, "same task keeps counting");
    step(c, 19);
    await tick();
    assert.equal(client.callsTo("interrupt").length, 1);
    step(c, 1);
    await tick();
    assert.equal(client.callsTo("interrupt").length, 2, "stops again after one more budget");
    const resolved = c.transcript.get(card.id);
    assert.ok(resolved?.kind === "budget" && resolved.resolved === "continued");
  });

  it("Increase budget raises and remembers the workspace level, then continues", async () => {
    const { c, client, store, emitted } = await running("small");
    step(c, 20);
    await tick();
    c.handleRawEvent(raw("session.execution.interrupted", { sessionID: "ses_1", reason: "user" }));
    const card = emitted.find((e) => e.type === "budget" && e.state === "stopped");
    assert.ok(card?.type === "budget");
    await c.budgetIncrease(card.id);
    assert.equal(c.budget.level, "medium");
    assert.equal(store.get(`opencodeSidebar.budget:${DIR}`), "medium");
    assert.equal(client.callsTo("prompt").length, 2);
  });

  it("does not count replayed history against a new task", async () => {
    const { c, client } = setup("small");
    await c.setDirectory(DIR);
    client.sessions = [
      {
        id: "ses_old",
        title: "Old",
        created: 1,
        updated: 2,
        agent: "build",
        modelKey: null,
        variant: null,
        outcome: null,
        cost: 9,
      },
    ];
    client.messages = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      type: "assistant",
      content: [],
      tokens,
      model: { providerID: "vast", id: "qwen" },
    }));
    await c.openSession("ses_old");
    assert.equal(c.steps, 60);
    assert.equal(client.callsTo("interrupt").length, 0);
    assert.equal(c.budgetView().taskSteps, 0);
  });

  it("persists the budget selection per workspace", async () => {
    const { c, store } = setup("medium");
    await c.setDirectory(DIR);
    assert.equal(c.budget.level, "medium");
    await c.selectBudget("large");
    assert.equal(store.get(`opencodeSidebar.budget:${DIR}`), "large");
  });

  it("warns once when the context window passes the threshold (never stops)", async () => {
    const { c, client, emitted } = await running("off");
    c.handleRawEvent(
      raw("session.step.started", {
        sessionID: "ses_1",
        assistantMessageID: "x",
        model: { providerID: "vast", id: "qwen" },
      }),
    );
    c.handleRawEvent(
      raw("session.step.ended", {
        sessionID: "ses_1",
        assistantMessageID: "x",
        tokens: { input: 110_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    step(c, 1);
    assert.equal(
      emitted.filter((e) => e.type === "notice" && /context window is \d+% full/.test(e.text)).length,
      1,
    );
    assert.equal(client.callsTo("interrupt").length, 0);
  });
});

describe("forms / questions", () => {
  it("renders a live question, validates and submits the answer to OpenCode", async () => {
    const { c, client } = await running();
    c.handleRawEvent({ id: "evt", created: 1, type: "form.created", data: { form: QUESTION } });
    const QID = QUESTION.id;
    // QUESTION.sessionID differs from ses_1; forms are routed by their own session id.
    assert.equal(c.transcript.get(`form:${QID}`), undefined, "other session's form is ignored");
    c.handleRawEvent({
      id: "evt",
      created: 1,
      type: "form.created",
      data: { form: { ...QUESTION, sessionID: "ses_1" } },
    });
    const item = c.transcript.get(`form:${QID}`);
    assert.ok(item?.kind === "form" && item.status === "pending");
    assert.equal(await c.answerForm(QID, { q0: 42 as unknown as string }), "“Preferred color” must be text.");
    assert.equal(await c.answerForm(QID, { q0: "Blue" }), null);
    assert.deepEqual(client.callsTo("replyForm")[0].args, ["ses_1", QID, { q0: "Blue" }]);
    const done = c.transcript.get(`form:${QID}`);
    assert.ok(done?.kind === "form" && done.status === "answered");
  });

  it("restores pending forms when a session is reopened", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    client.sessions = [
      {
        id: "ses_q",
        title: "Q",
        created: 1,
        updated: 2,
        agent: "build",
        modelKey: null,
        variant: null,
        outcome: null,
        cost: 0,
      },
    ];
    client.forms = [
      {
        id: "frm_9",
        sessionID: "ses_q",
        title: "Questions",
        fields: [{ key: "q0", type: "boolean" }],
        toolId: null,
      },
    ];
    client.active.add("ses_q");
    await c.openSession("ses_q");
    const item = c.transcript.get("form:frm_9");
    assert.ok(item?.kind === "form" && item.status === "pending");
  });

  it("shows an expired state when OpenCode no longer has the form", async () => {
    const { c, client } = await running();
    c.handleRawEvent({
      id: "evt",
      created: 1,
      type: "form.created",
      data: { form: { ...QUESTION, sessionID: "ses_1" } },
    });
    client.formReplyError = new OpenCodeHttpError(404, "FormNotFound", "gone");
    await c.answerForm(QUESTION.id, { q0: "Red" });
    const item = c.transcript.get(`form:${QUESTION.id}`);
    assert.ok(item?.kind === "form" && item.status === "expired");
  });

  it("cancels a form and reflects OpenCode's replied/cancelled events", async () => {
    const { c, client } = await running();
    c.handleRawEvent({
      id: "evt",
      created: 1,
      type: "form.created",
      data: { form: { ...QUESTION, sessionID: "ses_1" } },
    });
    await c.cancelForm(QUESTION.id);
    assert.equal(client.callsTo("cancelForm").length, 1);
    const item = c.transcript.get(`form:${QUESTION.id}`);
    assert.ok(item?.kind === "form" && item.status === "cancelled");
  });

  it("marks a pending form expired when the run ends", async () => {
    const { c } = await running();
    c.handleRawEvent({
      id: "evt",
      created: 1,
      type: "form.created",
      data: { form: { ...QUESTION, sessionID: "ses_1" } },
    });
    c.handleRawEvent(raw("session.execution.interrupted", { sessionID: "ses_1", reason: "user" }));
    const item = c.transcript.get(`form:${QUESTION.id}`);
    assert.ok(item?.kind === "form" && item.status === "expired");
  });
});

describe("steering and queued messages", () => {
  it("sends follow-ups while running with the chosen OpenCode delivery", async () => {
    const { c, client } = await running();
    assert.equal(await c.send("Don't touch Finance yet; finish Inventory first.", [], "steer"), true);
    assert.equal(await c.send("Run only the targeted test after this.", [], "queue"), true);
    const prompts = client.callsTo("prompt").map((x) => x.args[1] as { delivery?: string });
    assert.deepEqual(
      prompts.map((p) => p.delivery),
      [undefined, "steer", "queue"],
    );
    assert.equal(await c.send("no delivery while busy", []), false, "busy without delivery is refused");
  });

  it("shows pending messages until OpenCode delivers them, then adds them to the transcript", async () => {
    const { c } = await running();
    c.handleRawEvent(
      raw("session.inbox.enqueued", {
        sessionID: "ses_1",
        inboxID: "msg_q",
        item: { type: "user", payload: { text: "Queued text" }, delivery: "queue" },
      }),
    );
    assert.deepEqual(c.pending, [
      { id: "msg_q", text: "Queued text", raw: "Queued text", attachments: [], delivery: "queue" },
    ]);
    assert.equal(c.transcript.has("user:msg_q"), false);
    c.handleRawEvent(raw("session.inbox.delivered", { sessionID: "ses_1", inboxID: "msg_q" }));
    assert.equal(c.pending.length, 0);
    assert.ok(c.transcript.has("user:msg_q"));
  });

  it("Edit/Remove cancel the pending message in OpenCode and return its text", async () => {
    const { c, client } = await running();
    c.handleRawEvent(
      raw("session.inbox.enqueued", {
        sessionID: "ses_1",
        inboxID: "msg_q",
        item: { type: "user", payload: { text: "fix it" }, delivery: "queue" },
      }),
    );
    assert.equal(await c.cancelPending("msg_q"), "fix it");
    assert.deepEqual(client.callsTo("cancelInbox")[0].args, ["ses_1", "msg_q"]);
    assert.equal(c.pending.length, 0);
  });

  it("reports when a message was already delivered", async () => {
    const { c, client, emitted } = await running();
    c.handleRawEvent(
      raw("session.inbox.enqueued", {
        sessionID: "ses_1",
        inboxID: "msg_q",
        item: { type: "user", payload: { text: "x" }, delivery: "steer" },
      }),
    );
    client.inboxCancelError = new OpenCodeHttpError(404, null, "gone");
    assert.equal(await c.cancelPending("msg_q"), null);
    assert.ok(emitted.some((e) => e.type === "notice" && /already delivered/.test(e.text)));
  });

  it("restores the pending queue when a session is reopened", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    client.sessions = [
      {
        id: "ses_x",
        title: "X",
        created: 1,
        updated: 2,
        agent: "build",
        modelKey: null,
        variant: null,
        outcome: null,
        cost: 0,
      },
    ];
    client.inbox = [{ id: "msg_1", text: "later", attachments: [], delivery: "queue" }];
    await c.openSession("ses_x");
    assert.equal(c.pending.length, 1);
  });
});

describe("model variants", () => {
  it("selects only variants OpenCode lists and remembers them per workspace + model", async () => {
    const { c, client, store } = setup();
    await c.setDirectory(DIR);
    await c.selectModel("vast/qwen");
    await c.selectVariant("ultra");
    assert.equal(c.selectedVariant, null, "unknown variant rejected");
    await c.selectVariant("high");
    assert.equal(store.get(`opencodeSidebar.variant:${DIR}:vast/qwen`), "high");
    await c.selectModel("opencode-go/kimi");
    assert.equal(c.selectedVariant, null, "model without variants");
    await c.selectModel("vast/qwen");
    assert.equal(c.selectedVariant, "high", "restored for that model");
    await c.send("hi", []);
    assert.deepEqual((client.callsTo("createSession")[0].args[0] as { model: unknown }).model, {
      providerID: "vast",
      id: "qwen",
      variant: "high",
    });
    await c.selectVariant(null);
    assert.deepEqual(client.callsTo("switchModel").at(-1)?.args[1], { providerID: "vast", id: "qwen" });
  });
});

describe("agent-only changes", () => {
  it("requests the whole session range with full-file patches", async () => {
    const { c, client } = await running();
    c.handleRawEvent(
      raw("session.inbox.enqueued", {
        sessionID: "ses_1",
        inboxID: "msg_later",
        item: { type: "user", payload: { text: "second" }, delivery: "steer" },
      }),
    );
    c.handleRawEvent(raw("session.inbox.delivered", { sessionID: "ses_1", inboxID: "msg_later" }));
    client.diff = [
      { file: "a.txt", patch: "@@ -1,1 +1,2 @@\n a\n+b\n", additions: 1, deletions: 0, status: "modified" },
    ];
    await c.refreshChanges();
    const range = client.callsTo("sessionDiff").at(-1)?.args[1] as {
      from: string;
      to: string;
      full: boolean;
    };
    assert.equal(range.full, true);
    assert.equal(range.to, "msg_later");
    assert.ok(range.from && range.from !== "msg_later");
    assert.deepEqual(c.agentChanges, {
      status: "ok",
      files: [{ path: "a.txt", additions: 1, deletions: 0, status: "modified" }],
    });
    assert.deepEqual(c.agentFileSides("a.txt"), { before: "a\n", after: "a\nb\n" });
  });

  it("reports unavailable instead of guessing when OpenCode has no snapshot diff", async () => {
    const { c, client } = await running();
    client.diffError = new OpenCodeHttpError(400, null, "Ranges that span a location change are rejected");
    await c.refreshChanges();
    assert.equal(c.agentChanges.status, "unavailable");
    assert.deepEqual(c.changes, []);
  });

  it("reports unavailable when the agent reported edits but snapshots are empty", async () => {
    const { c, client } = await running();
    c.handleRawEvent(
      raw("session.tool.input.started", {
        sessionID: "ses_1",
        assistantMessageID: "m",
        id: "e1",
        name: "edit",
      }),
    );
    c.handleRawEvent(
      raw("session.tool.success", {
        sessionID: "ses_1",
        assistantMessageID: "m",
        id: "e1",
        content: [{ type: "text", text: "ok" }],
        metadata: { files: [{ file: "a.txt", additions: 1, deletions: 0, status: "modified" }] },
      }),
    );
    client.diff = [];
    await c.refreshChanges();
    assert.equal(c.agentChanges.status, "unavailable");
  });

  it("returns no sides for an unknown or non-reconstructable file", async () => {
    const { c, client } = await running();
    client.diff = [
      {
        file: "img.png",
        patch: "Binary files a/img.png and b/img.png differ\n",
        additions: 0,
        deletions: 0,
        status: "modified",
      },
    ];
    await c.refreshChanges();
    assert.equal(c.agentFileSides("img.png"), null);
    assert.equal(c.agentFileSides("other.txt"), null);
  });
});

describe("errors and titles", () => {
  it("turns upstream failures into a friendly card with actions and logs the details", async () => {
    const { c, emitted, logs } = await running();
    c.handleRawEvent(
      raw("session.step.started", {
        sessionID: "ses_1",
        assistantMessageID: "m",
        model: { providerID: "opencode-go", id: "kimi" },
      }),
    );
    c.handleRawEvent(
      raw("session.execution.failed", {
        sessionID: "ses_1",
        error: {
          type: "provider.api",
          message: "Upstream request failed: Insufficient account funds",
          status: 402,
        },
      }),
    );
    const card = emitted.find((e) => e.type === "error");
    assert.ok(card?.type === "error");
    assert.equal(card.title, "Kimi (OpenCode Go) reported insufficient funds.");
    assert.deepEqual(card.actions, ["changeModel", "retry"]);
    assert.ok(
      logs.some(
        (l) => /status=402/.test(l) && /provider=opencode-go/.test(l) && /model=opencode-go\/kimi/.test(l),
      ),
    );
    assert.equal(c.busy, false);
  });

  it("Retry re-sends the last prompt", async () => {
    const { c, client } = await running();
    c.handleRawEvent(
      raw("session.execution.failed", {
        sessionID: "ses_1",
        error: { type: "provider.api", message: "Overloaded", status: 529 },
      }),
    );
    assert.equal(await c.retry(), true);
    const prompts = client.callsTo("prompt");
    assert.deepEqual(prompts[1].args[1], prompts[0].args[1]);
  });

  it("replaces broken generated titles with a local fallback", async () => {
    const { c } = await running();
    c.handleRawEvent(
      raw("session.inbox.enqueued", {
        sessionID: "ses_1",
        inboxID: "u9",
        item: { type: "user", payload: { text: "x" }, delivery: "steer" },
      }),
    );
    c.handleRawEvent(
      raw("session.renamed", { sessionID: "ses_1", title: "We need title only. Massive request title..." }),
    );
    assert.equal(c.currentTitle(), "do the task");
    c.handleRawEvent(raw("session.renamed", { sessionID: "ses_1", title: "Implement inventory sync" }));
    assert.equal(c.currentTitle(), "Implement inventory sync");
  });

  it("fetches a fallback title for listed sessions with broken titles (no extra model call)", async () => {
    const { c, client } = setup();
    client.sessions = [
      {
        id: "ses_b",
        title: "We need title only",
        created: 1,
        updated: 1,
        agent: null,
        modelKey: null,
        variant: null,
        outcome: null,
        cost: 0,
      },
    ];
    client.firstTexts.set("ses_b", "Refactor the billing module");
    await c.setDirectory(DIR);
    c.displaySessions();
    await tick();
    assert.equal(c.displaySessions()[0].title, "Refactor the billing module");
  });
});

describe("catalog loading race", () => {
  it("publishes models only together with their defaults, so a user selection is never overwritten", async () => {
    const { c, client } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    client.defaultModel = async () => {
      await gate;
      return "vast/qwen";
    };
    const loading = c.setDirectory(DIR);
    await tick(10);
    assert.equal(c.models, null, "models are not visible while defaults are still resolving");
    await c.selectModel("opencode-go/kimi"); // ignored: not selectable yet
    release();
    await loading;
    assert.equal(c.selectedModel, "vast/qwen");
    await c.selectModel("opencode-go/kimi");
    await tick(10);
    assert.equal(c.selectedModel, "opencode-go/kimi", "selection after load sticks");
  });
});

describe("workspace change events during load (0.2.1 fix)", () => {
  it("a repeated setDirectory for the same folder neither reloads nor resets the user's selection", async () => {
    const { c, client } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    client.defaultModel = async () => {
      await gate;
      return "vast/qwen";
    };
    const first = c.setDirectory(DIR);
    await tick(5);
    const again = c.setDirectory(DIR); // e.g. a Git status refresh while the catalog is loading
    release();
    await Promise.all([first, again]);
    assert.equal(client.callsTo("listModels").length, 1, "catalog loaded once");
    await c.selectModel("opencode-go/kimi");
    await c.setDirectory(DIR); // later Git refreshes
    await tick(10);
    assert.equal(c.selectedModel, "opencode-go/kimi");
    assert.equal(client.callsTo("listModels").length, 1);
  });

  it("still reloads when the folder really changes", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    await c.setDirectory("/work/other");
    assert.deepEqual(
      client.callsTo("listModels").map((x) => x.args[0]),
      [DIR, "/work/other"],
    );
  });
});
