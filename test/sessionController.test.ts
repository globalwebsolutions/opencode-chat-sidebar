import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { SessionController } from "../src/core/sessionController";
import { OpenCodeHttpError } from "../src/opencode/client";
import type { ContextAttachment, UiEvent } from "../src/shared/model";
import { MemoryStore, MockClient } from "./mockClient";

const DIR = "/work/repo";
const silentLog = { info() {}, warn() {}, error() {} };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function setup(defaults = { model: "", agent: "" }) {
  const client = new MockClient();
  const store = new MemoryStore();
  const emitted: UiEvent[] = [];
  let resets = 0;
  const c = new SessionController(
    client,
    store,
    { onEvents: (e) => emitted.push(...e), onTranscriptReset: () => resets++, onStateChanged() {} },
    silentLog,
    () => defaults,
    { debounceMs: 1, stopCheckMs: 20, modelRetryMs: 1 },
  );
  return { client, store, c, emitted, resets: () => resets };
}

const raw = (type: string, data: Record<string, unknown>) => ({ id: "evt", created: 1, type, data });

describe("session controller: catalog and selection", () => {
  it("loads models/agents for the workspace and prefers the OpenCode default model", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    assert.equal(client.callsTo("listModels")[0].args[0], DIR);
    assert.equal(c.selectedModel, "vast/qwen");
    assert.equal(c.selectedAgent, "build");
  });

  it("prefers a remembered model, then the configured default", async () => {
    const a = setup({ model: "opencode-go/kimi", agent: "plan" });
    await a.c.setDirectory(DIR);
    assert.equal(a.c.selectedModel, "opencode-go/kimi");
    assert.equal(a.c.selectedAgent, "plan");

    const b = setup();
    await b.store.update(`opencodeSidebar.model:${DIR}`, "opencode-go/kimi");
    await b.c.setDirectory(DIR);
    assert.equal(b.c.selectedModel, "opencode-go/kimi");
  });

  it("ignores a remembered model that is no longer available", async () => {
    const { c, store } = setup();
    await store.update(`opencodeSidebar.model:${DIR}`, "gone/model");
    await c.setDirectory(DIR);
    assert.equal(c.selectedModel, "vast/qwen");
  });

  it("retries once when a fresh location reports no models", async () => {
    const { c, client } = setup();
    client.modelResponses = [[], client.models];
    await c.setDirectory(DIR);
    assert.equal(c.models?.length, 2);
    assert.equal(client.callsTo("listModels").length, 2);
  });

  it("marks models unavailable when loading fails", async () => {
    const { c, client } = setup();
    client.listModels = async () => {
      throw new TypeError("fetch failed");
    };
    await c.setDirectory(DIR);
    assert.equal(c.models, null);
  });

  it("switches the model of an existing session through OpenCode and remembers it", async () => {
    const { c, client, store } = setup();
    await c.setDirectory(DIR);
    await c.send("hi", []);
    await c.selectModel("opencode-go/kimi");
    assert.deepEqual(client.callsTo("switchModel")[0].args, [
      "ses_1",
      { providerID: "opencode-go", id: "kimi" },
    ]);
    assert.equal(store.get(`opencodeSidebar.model:${DIR}`), "opencode-go/kimi");
    await c.selectAgent("plan");
    assert.deepEqual(client.callsTo("switchAgent")[0].args, ["ses_1", "plan"]);
    await c.selectModel("not/listed");
    assert.equal(c.selectedModel, "opencode-go/kimi");
  });
});

describe("session controller: sessions and prompts", () => {
  let env: ReturnType<typeof setup>;
  beforeEach(async () => {
    env = setup();
    await env.c.setDirectory(DIR);
  });

  it("creates the OpenCode session lazily on first send with the selected model, agent and workspace", async () => {
    const { c, client } = env;
    await c.selectModel("opencode-go/kimi");
    const sel: ContextAttachment = {
      kind: "selection",
      id: "s",
      relPath: "a.php",
      absPath: `${DIR}/a.php`,
      startLine: 2,
      endLine: 3,
      text: "x\ny",
      languageId: "php",
    };
    const file: ContextAttachment = { kind: "file", id: "f", relPath: "b.php", absPath: `${DIR}/b.php` };
    assert.equal(await c.send("Explain", [sel, file]), true);
    assert.deepEqual(client.callsTo("createSession")[0].args[0], {
      directory: DIR,
      agent: "build",
      model: { providerID: "opencode-go", id: "kimi" },
    });
    const [sid, payload] = client.callsTo("prompt")[0].args as [string, { text: string; files: unknown[] }];
    assert.equal(sid, "ses_1");
    assert.match(payload.text, /^Explain\n\nSelected code from `a\.php` \(lines 2-3\)/);
    assert.deepEqual(payload.files, [{ uri: `file://${DIR}/b.php`, name: "b.php" }]);
    assert.equal(c.busy, true);
    // Continuing reuses the session.
    c.handleRawEvent(raw("session.execution.succeeded", { sessionID: "ses_1" }));
    await c.send("again", []);
    assert.equal(client.callsTo("createSession").length, 1);
    assert.equal(client.callsTo("prompt")[1].args[0], "ses_1");
  });

  it("does not send empty prompts or while busy", async () => {
    const { c, client } = env;
    assert.equal(await c.send("   ", []), false);
    assert.equal(await c.send("", [{ kind: "file", id: "f", relPath: "b", absPath: `${DIR}/b` }]), false);
    await c.send("one", []);
    assert.equal(await c.send("two", []), false);
    assert.equal(client.callsTo("prompt").length, 1);
  });

  it("surfaces send failures as an error notice and clears busy", async () => {
    const { c, client, emitted } = env;
    client.prompt = async () => {
      throw new OpenCodeHttpError(500, null, "boom");
    };
    assert.equal(await c.send("hi", []), false);
    assert.equal(c.busy, false);
    assert.ok(
      emitted.some((e) => e.type === "notice" && e.level === "error" && e.text.includes("Session failed")),
    );
  });

  it("streams events for the current session only", async () => {
    const { c, emitted } = env;
    await c.send("hi", []);
    c.handleRawEvent(
      raw("session.text.delta", { sessionID: "ses_other", assistantMessageID: "m", ordinal: 0, delta: "NO" }),
    );
    c.handleRawEvent(
      raw("session.text.delta", { sessionID: "ses_1", assistantMessageID: "m", ordinal: 0, delta: "Hi" }),
    );
    c.handleRawEvent(
      raw("session.text.delta", { sessionID: "ses_1", assistantMessageID: "m", ordinal: 0, delta: " there" }),
    );
    assert.equal(emitted.filter((e) => e.type === "assistant.delta").length, 2);
    const item = c.transcript.get("text:m:0");
    assert.ok(item?.kind === "assistant" && item.text === "Hi there");
  });

  it("continues an existing session: history, pending permissions, running state, model and agent", async () => {
    const { c, client } = env;
    client.sessions = [
      {
        id: "ses_old",
        title: "Old",
        created: 1,
        updated: 2,
        agent: "plan",
        modelKey: "opencode-go/kimi",
        outcome: null,
        variant: null,
        cost: 0.5,
      },
    ];
    client.messages = [{ id: "u1", type: "user", text: "q", time: { created: 1 } }];
    client.permissions = [
      {
        id: "per_9",
        sessionID: "ses_old",
        action: "read",
        resources: [".env"],
        canAlways: true,
        message: null,
        toolId: null,
      },
    ];
    client.active.add("ses_old");
    assert.equal(await c.openSession("ses_old"), true);
    assert.equal(c.current?.id, "ses_old");
    assert.equal(c.busy, true);
    assert.equal(c.selectedModel, "opencode-go/kimi");
    assert.equal(c.selectedAgent, "plan");
    assert.ok(c.transcript.get("user:u1"));
    const perm = c.transcript.get("perm:per_9");
    assert.ok(perm?.kind === "permission" && perm.status === "pending" && perm.sensitive.length === 1);
    assert.equal(c.usage()?.cost, 0.5);
  });

  it("reports a missing session instead of throwing", async () => {
    const { c, emitted } = env;
    assert.equal(await c.openSession("ses_missing"), false);
    assert.ok(emitted.some((e) => e.type === "notice" && e.level === "error"));
  });

  it("refreshes the session list when sessions in this workspace change", async () => {
    const { c, client } = env;
    const before = client.callsTo("listSessions").length;
    c.handleRawEvent({
      type: "session.created",
      data: { sessionID: "x" },
      location: { directory: "/elsewhere" },
    });
    await tick();
    assert.equal(client.callsTo("listSessions").length, before);
    c.handleRawEvent({ type: "session.created", data: { sessionID: "x" }, location: { directory: DIR } });
    await tick();
    assert.equal(client.callsTo("listSessions").length, before + 1);
  });

  it("new session clears the conversation without creating anything on the server", async () => {
    const { c, client } = env;
    await c.send("hi", []);
    await c.newSession();
    assert.equal(c.current, null);
    assert.equal(c.transcript.items.length, 0);
    assert.equal(client.callsTo("createSession").length, 1);
  });

  it("computes context usage from the last step and the model's context limit", async () => {
    const { c } = env;
    await c.send("hi", []);
    c.handleRawEvent(
      raw("session.step.started", {
        sessionID: "ses_1",
        assistantMessageID: "m",
        model: { providerID: "opencode-go", id: "kimi" },
      }),
    );
    c.handleRawEvent(
      raw("session.step.ended", {
        sessionID: "ses_1",
        assistantMessageID: "m",
        tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 40000, write: 800 } },
      }),
    );
    c.handleRawEvent(
      raw("session.usage.updated", {
        sessionID: "ses_1",
        cost: 0.25,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    assert.deepEqual(c.usage(), { contextTokens: 42000, contextLimit: 262144, cost: 0.25 });
  });

  it("loads changed files from the session diff after edits", async () => {
    const { c, client } = env;
    client.diff = [{ file: "a.txt", patch: "", additions: 1, deletions: 0, status: "modified" }];
    await c.send("edit", []);
    c.handleRawEvent(
      raw("session.step.ended", {
        sessionID: "ses_1",
        assistantMessageID: "m",
        files: ["a.txt"],
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
    await tick(20);
    assert.deepEqual(c.changes, [{ path: "a.txt", additions: 1, deletions: 0, status: "modified" }]);
  });
});

describe("session controller: permissions", () => {
  async function withPermission(canAlways = true) {
    const env = setup();
    await env.c.setDirectory(DIR);
    await env.c.send("read env", []);
    env.c.handleRawEvent(
      raw("permission.asked", {
        id: "per_1",
        sessionID: "ses_1",
        action: "read",
        resources: [".env.staging.example"],
        ...(canAlways ? { save: ["*"] } : {}),
      }),
    );
    return env;
  }

  it("renders the request and answers 'once' through OpenCode", async () => {
    const { c, client } = await withPermission();
    const item = c.transcript.get("perm:per_1");
    assert.ok(item?.kind === "permission" && item.status === "pending" && item.sensitive.length === 0);
    await c.respondPermission("per_1", "once");
    assert.deepEqual(client.callsTo("replyPermission")[0].args, ["ses_1", "per_1", "once"]);
    assert.equal((c.transcript.get("perm:per_1") as { status: string }).status, "once");
  });

  it("maps Deny to OpenCode's 'reject' decision", async () => {
    const { c, client } = await withPermission();
    await c.respondPermission("per_1", "reject");
    assert.equal(client.callsTo("replyPermission")[0].args[2], "reject");
  });

  it("never sends 'always' when OpenCode did not offer it", async () => {
    const { c, client } = await withPermission(false);
    await c.respondPermission("per_1", "always");
    assert.equal(client.callsTo("replyPermission").length, 0);
  });

  it("never auto-approves: nothing is sent until the user responds", async () => {
    const { client } = await withPermission();
    await tick();
    assert.equal(client.callsTo("replyPermission").length, 0);
  });

  it("shows an expired state when OpenCode no longer knows the request", async () => {
    const { c, client, emitted } = await withPermission();
    client.replyError = new OpenCodeHttpError(404, "PermissionNotFoundError", "not found");
    await c.respondPermission("per_1", "once");
    assert.equal((c.transcript.get("perm:per_1") as { status: string }).status, "expired");
    assert.ok(emitted.some((e) => e.type === "notice" && e.text === "Permission request expired."));
  });

  it("re-opens the card when the reply fails for another reason", async () => {
    const { c, client } = await withPermission();
    client.replyError = new TypeError("fetch failed");
    await c.respondPermission("per_1", "once");
    assert.equal((c.transcript.get("perm:per_1") as { status: string }).status, "pending");
  });

  it("ignores answers to requests that are not pending", async () => {
    const { c, client } = await withPermission();
    await c.respondPermission("per_1", "once");
    await c.respondPermission("per_1", "reject");
    await c.respondPermission("per_unknown", "once");
    assert.equal(client.callsTo("replyPermission").length, 1);
  });
});

describe("session controller: cancellation", () => {
  it("calls OpenCode's interrupt and stays busy until the execution reports interrupted", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    await c.send("long task", []);
    await c.stop();
    assert.deepEqual(client.callsTo("interrupt")[0].args, ["ses_1"]);
    assert.equal(c.busy, true);
    assert.equal(c.stopping, true);
    c.handleRawEvent(raw("session.execution.interrupted", { sessionID: "ses_1", reason: "user" }));
    assert.equal(c.busy, false);
    assert.equal(c.stopping, false);
    assert.ok(c.transcript.items.some((i) => i.kind === "notice" && i.text === "Stopped."));
  });

  it("clears busy immediately when OpenCode reports nothing was running", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    await c.send("x", []);
    client.interruptResult = false;
    await c.stop();
    assert.equal(c.busy, false);
  });

  it("verifies with OpenCode if the interrupted event never arrives", async () => {
    const { c } = setup();
    await c.setDirectory(DIR);
    await c.send("x", []);
    await c.stop();
    await tick(40);
    assert.equal(c.busy, false, "session no longer active on the server");
  });

  it("does nothing when idle", async () => {
    const { c, client } = setup();
    await c.setDirectory(DIR);
    await c.stop();
    assert.equal(client.callsTo("interrupt").length, 0);
  });

  it("reports interrupt failures", async () => {
    const { c, client, emitted } = setup();
    await c.setDirectory(DIR);
    await c.send("x", []);
    client.interrupt = async () => {
      throw new TypeError("fetch failed");
    };
    await c.stop();
    assert.equal(c.stopping, false);
    assert.ok(emitted.some((e) => e.type === "notice" && e.text.includes("Could not stop")));
  });
});
