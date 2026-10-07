import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventNormalizer, historyToEvents } from "../src/opencode/events";

const S = "ses_test";
const M = "msg_a";
const ev = (type: string, data: Record<string, unknown>, location?: string) => ({
  id: "evt_x",
  created: 1,
  type,
  data,
  ...(location ? { location: { directory: location } } : {}),
});

describe("event normalization", () => {
  it("maps streaming text, reasoning and completion", () => {
    const n = new EventNormalizer();
    assert.deepEqual(
      n.normalize(ev("session.text.delta", { sessionID: S, assistantMessageID: M, ordinal: 0, delta: "Hel" }))
        ?.events,
      [{ type: "assistant.delta", partId: "msg_a:0", delta: "Hel" }],
    );
    assert.deepEqual(
      n.normalize(
        ev("session.text.ended", { sessionID: S, assistantMessageID: M, ordinal: 0, text: "Hello" }),
      )?.events,
      [{ type: "assistant.completed", partId: "msg_a:0", text: "Hello" }],
    );
    assert.equal(
      n.normalize(
        ev("session.reasoning.delta", { sessionID: S, assistantMessageID: M, ordinal: 0, delta: "hm" }),
      )?.events[0].type,
      "reasoning.delta",
    );
  });

  it("maps tool lifecycle events and keeps the session id", () => {
    const n = new EventNormalizer();
    const started = n.normalize(
      ev("session.tool.input.started", { sessionID: S, assistantMessageID: M, id: "shell_1", name: "shell" }),
    );
    assert.equal(started?.sessionID, S);
    assert.deepEqual(started?.events, [{ type: "tool.started", toolId: "shell_1", name: "shell" }]);
    assert.deepEqual(
      n.normalize(
        ev("session.tool.called", {
          sessionID: S,
          assistantMessageID: M,
          id: "shell_1",
          input: { command: "git status" },
          executed: false,
        }),
      )?.events,
      [{ type: "tool.input", toolId: "shell_1", name: null, input: { command: "git status" } }],
    );
    const done = n.normalize(
      ev("session.tool.success", {
        sessionID: S,
        assistantMessageID: M,
        id: "shell_1",
        content: [{ type: "text", text: "On branch main\n" }],
        metadata: { status: "completed", exit: 0, truncated: false },
        executed: false,
      }),
    );
    assert.deepEqual(done?.events, [
      {
        type: "tool.completed",
        toolId: "shell_1",
        output: "On branch main\n",
        metadata: { status: "completed", exit: 0, truncated: false },
      },
    ]);
    const failed = n.normalize(
      ev("session.tool.failed", {
        sessionID: S,
        assistantMessageID: M,
        id: "shell_2",
        error: { type: "aborted", message: "Tool execution interrupted" },
        executed: false,
      }),
    );
    assert.deepEqual(failed?.events, [
      {
        type: "tool.failed",
        toolId: "shell_2",
        error: "Tool execution interrupted",
        output: null,
        metadata: null,
      },
    ]);
  });

  it("links shell processes to tool calls to show the working directory", () => {
    const n = new EventNormalizer();
    n.normalize(
      ev("session.tool.progress", {
        sessionID: S,
        assistantMessageID: M,
        id: "shell_1",
        metadata: { shellID: "sh_1" },
      }),
    );
    const linked = n.normalize(
      ev(
        "shell.created",
        { info: { id: "sh_1", status: "running", command: "git status", cwd: "/repo" } },
        "/repo",
      ),
    );
    assert.equal(linked?.sessionID, S);
    assert.deepEqual(linked?.events, [
      { type: "tool.shell", toolId: "shell_1", cwd: "/repo", command: "git status" },
    ]);
    // Also works when the shell is announced before the progress event.
    const n2 = new EventNormalizer();
    assert.equal(n2.normalize(ev("shell.created", { info: { id: "sh_2", command: "ls", cwd: "/w" } })), null);
    assert.deepEqual(
      n2.normalize(
        ev("session.tool.progress", {
          sessionID: S,
          assistantMessageID: M,
          id: "t2",
          metadata: { shellID: "sh_2" },
        }),
      )?.events,
      [{ type: "tool.shell", toolId: "t2", cwd: "/w", command: "ls" }],
    );
  });

  it("maps permission requests, including sensitive-path warnings and 'always' availability", () => {
    const n = new EventNormalizer();
    const r = n.normalize(
      ev("permission.asked", {
        id: "per_1",
        sessionID: S,
        action: "read",
        resources: [".env"],
        save: ["*"],
        source: { type: "tool", messageID: M, id: "read_0" },
      }),
    );
    assert.equal(r?.sessionID, S);
    const e = r?.events[0];
    assert.equal(e?.type, "permission.requested");
    if (e?.type === "permission.requested") {
      assert.deepEqual(e.request, {
        id: "per_1",
        sessionID: S,
        action: "read",
        resources: [".env"],
        canAlways: true,
        message: null,
        toolId: "read_0",
      });
      assert.equal(e.sensitive.length, 1);
    }
    const noSave = n.normalize(
      ev("permission.asked", { id: "per_2", sessionID: S, action: "bash", resources: ["rm -rf build"] }),
    );
    const e2 = noSave?.events[0];
    assert.ok(
      e2?.type === "permission.requested" && e2.request.canAlways === false && e2.sensitive.length === 0,
    );
    assert.deepEqual(
      n.normalize(ev("permission.replied", { sessionID: S, requestID: "per_1", reply: "once" }))?.events,
      [{ type: "permission.resolved", requestId: "per_1", decision: "once" }],
    );
    assert.equal(
      n.normalize(ev("permission.replied", { sessionID: S, requestID: "per_1", reply: "bogus" })),
      null,
    );
  });

  it("maps execution outcomes, failures and changed files", () => {
    const n = new EventNormalizer();
    assert.deepEqual(n.normalize(ev("session.execution.started", { sessionID: S }))?.events, [
      { type: "session.busy" },
    ]);
    assert.deepEqual(
      n.normalize(ev("session.execution.interrupted", { sessionID: S, reason: "user" }))?.events,
      [{ type: "session.idle", outcome: "interrupted" }],
    );
    assert.deepEqual(
      n.normalize(
        ev("session.execution.failed", {
          sessionID: S,
          error: { type: "provider.transport", message: "ConnectionRefused" },
        }),
      )?.events,
      [
        {
          type: "session.error",
          message: "ConnectionRefused",
          error: { type: "provider.transport", message: "ConnectionRefused", status: null, body: null },
          modelKey: null,
        },
        { type: "session.idle", outcome: "failed" },
      ],
    );
    n.normalize(
      ev("session.step.started", {
        sessionID: S,
        assistantMessageID: M,
        agent: "build",
        model: { providerID: "p", id: "m" },
      }),
    );
    const ended = n.normalize(
      ev("session.step.ended", {
        sessionID: S,
        assistantMessageID: M,
        finish: "stop",
        cost: 0.01,
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 100, write: 0 } },
        files: ["a.txt"],
      }),
    );
    assert.deepEqual(ended?.events, [
      { type: "files.changed", files: ["a.txt"] },
      {
        type: "usage.step",
        tokens: { input: 10, output: 2, reasoning: 1, cacheRead: 100, cacheWrite: 0 },
        modelKey: "p/m",
      },
    ]);
  });

  it("flags session list changes with their directory", () => {
    const n = new EventNormalizer();
    const created = n.normalize(ev("session.created", { sessionID: S, slug: "x" }, "/repo"));
    assert.equal(created?.sessionsChanged, true);
    assert.equal(created?.directory, "/repo");
    assert.equal(
      n.normalize(ev("session.renamed", { sessionID: S, title: "T" }))?.events[0].type,
      "session.renamed",
    );
  });

  it("ignores unknown and malformed events without throwing", () => {
    const n = new EventNormalizer();
    assert.deepEqual(n.normalize(ev("models-dev.refreshed", {}))?.events, []);
    assert.equal(n.normalize(null), null);
    assert.equal(n.normalize({ nope: 1 }), null);
  });
});

describe("history replay", () => {
  it("replays stored messages in order", () => {
    const events = historyToEvents([
      {
        id: "msg_u",
        type: "user",
        text: "Read .env",
        time: { created: 1 },
        files: [{ name: "a.txt", source: { type: "uri", uri: "file:///r/a.txt" } }],
      },
      {
        id: "msg_a",
        type: "assistant",
        agent: "build",
        model: { providerID: "p", id: "m" },
        time: { created: 2 },
        content: [
          { type: "reasoning", text: "think" },
          {
            type: "tool",
            id: "read_0",
            name: "read",
            state: {
              status: "completed",
              input: { path: ".env" },
              content: [{ type: "text", text: "1: X=1" }],
              metadata: { truncated: false },
            },
          },
          {
            type: "tool",
            id: "edit_1",
            name: "edit",
            state: { status: "error", input: { path: "a" }, error: { type: "x", message: "no match" } },
          },
          { type: "text", text: "Done" },
        ],
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      { id: "msg_i", type: "idle", outcome: "succeeded", time: { created: 3 } },
    ]);
    assert.deepEqual(
      events.map((e) => e.type),
      [
        "user.message",
        "reasoning.completed",
        "tool.started",
        "tool.input",
        "tool.completed",
        "tool.started",
        "tool.input",
        "tool.failed",
        "assistant.completed",
        "usage.step",
        "session.idle",
      ],
    );
    assert.deepEqual(events[0], {
      type: "user.message",
      id: "msg_u",
      text: "Read .env",
      attachments: ["a.txt"],
    });
  });
});
