import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeTool } from "../src/shared/tools";
import { MAX_TOOL_OUTPUT, Transcript } from "../src/shared/transcript";

describe("transcript reducer", () => {
  it("accumulates streaming deltas and finalizes on completion", () => {
    const t = new Transcript();
    t.apply({ type: "assistant.delta", partId: "m:0", delta: "Hel" });
    t.apply({ type: "assistant.delta", partId: "m:0", delta: "lo" });
    assert.deepEqual(t.get("text:m:0"), {
      kind: "assistant",
      id: "text:m:0",
      text: "Hello",
      streaming: true,
    });
    t.apply({ type: "assistant.completed", partId: "m:0", text: "Hello!" });
    assert.deepEqual(t.get("text:m:0"), {
      kind: "assistant",
      id: "text:m:0",
      text: "Hello!",
      streaming: false,
    });
  });

  it("tracks shell tool state: waiting → running → passed/failed", () => {
    const t = new Transcript();
    t.apply({ type: "tool.started", toolId: "s1", name: "shell" });
    let item = t.get("tool:s1");
    assert.ok(item?.kind === "tool" && item.status === "pending");
    t.apply({ type: "tool.input", toolId: "s1", name: null, input: { command: "npm test" } });
    t.apply({ type: "tool.shell", toolId: "s1", cwd: "/repo", command: "npm test" });
    item = t.get("tool:s1");
    assert.ok(
      item?.kind === "tool" &&
        item.status === "running" &&
        item.detail.cwd === "/repo" &&
        item.title === "npm test",
    );
    t.apply({ type: "tool.completed", toolId: "s1", output: "1 failing", metadata: { exit: 1 } });
    item = t.get("tool:s1");
    assert.ok(item?.kind === "tool" && item.status === "failed" && item.detail.exitCode === 1);
  });

  it("caps large tool output", () => {
    const t = new Transcript();
    t.apply({ type: "tool.started", toolId: "r", name: "read" });
    t.apply({
      type: "tool.completed",
      toolId: "r",
      output: "x".repeat(MAX_TOOL_OUTPUT + 10),
      metadata: null,
    });
    const item = t.get("tool:r");
    assert.ok(
      item?.kind === "tool" && item.detail.output?.length === MAX_TOOL_OUTPUT && item.detail.outputTruncated,
    );
  });

  it("summarizes edited files at the end of a turn", () => {
    const t = new Transcript();
    t.apply({ type: "user.message", id: "u1", text: "edit", attachments: [] });
    t.apply({ type: "tool.started", toolId: "e1", name: "edit" });
    t.apply({
      type: "tool.completed",
      toolId: "e1",
      output: "ok",
      metadata: { files: [{ file: "a.ts", additions: 3, deletions: 1, status: "modified", patch: "…" }] },
    });
    t.apply({ type: "tool.started", toolId: "e2", name: "write" });
    t.apply({
      type: "tool.completed",
      toolId: "e2",
      output: "ok",
      metadata: {
        files: [
          { file: "a.ts", additions: 2, deletions: 0, status: "modified" },
          { file: "b.ts", additions: 5, deletions: 0, status: "added" },
        ],
      },
    });
    const changed = t.apply({ type: "session.idle", outcome: "succeeded" });
    const summary = t.items.find((i) => i.kind === "turn-summary");
    assert.ok(summary && changed.includes(summary.id));
    assert.deepEqual(summary?.kind === "turn-summary" && summary.files, [
      { path: "a.ts", additions: 5, deletions: 1, status: "modified" },
      { path: "b.ts", additions: 5, deletions: 0, status: "added" },
    ]);
  });

  it("expires pending permissions and marks running tools when the session goes idle", () => {
    const t = new Transcript();
    t.apply({ type: "tool.started", toolId: "s", name: "shell" });
    t.apply({ type: "tool.input", toolId: "s", name: null, input: { command: "sleep 60" } });
    t.apply({
      type: "permission.requested",
      request: {
        id: "p",
        sessionID: "x",
        action: "read",
        resources: ["a"],
        canAlways: false,
        message: null,
        toolId: null,
      },
      sensitive: [],
    });
    t.apply({ type: "session.idle", outcome: "interrupted" });
    const tool = t.get("tool:s");
    const perm = t.get("perm:p");
    assert.ok(tool?.kind === "tool" && tool.status === "failed" && tool.detail.error === "Interrupted");
    assert.ok(perm?.kind === "permission" && perm.status === "expired");
    assert.ok(t.items.some((i) => i.kind === "notice" && i.text === "Stopped."));
  });

  it("does not reopen a resolved permission, but reopens one that failed to send", () => {
    const t = new Transcript();
    const request = {
      id: "p",
      sessionID: "x",
      action: "read",
      resources: ["a"],
      canAlways: true,
      message: null,
      toolId: null,
    };
    t.apply({ type: "permission.requested", request, sensitive: [] });
    t.apply({ type: "permission.sending", requestId: "p" });
    t.apply({ type: "permission.requested", request, sensitive: [] });
    assert.equal((t.get("perm:p") as { status: string }).status, "pending");
    t.apply({ type: "permission.resolved", requestId: "p", decision: "always" });
    assert.deepEqual(t.apply({ type: "permission.requested", request, sensitive: [] }), []);
    assert.equal((t.get("perm:p") as { status: string }).status, "always");
  });

  it("does not duplicate a user message echoed twice", () => {
    const t = new Transcript();
    t.apply({ type: "user.message", id: "u", text: "x", attachments: [] });
    assert.deepEqual(t.apply({ type: "user.message", id: "u", text: "x", attachments: [] }), []);
    assert.equal(t.items.length, 1);
  });
});

describe("tool descriptions", () => {
  it("builds compact titles without dumping edit payloads", () => {
    assert.equal(describeTool("read", { path: "app/Http/Checkout.php" }).title, "Read Checkout.php");
    assert.equal(describeTool("grep", { pattern: "TODO" }).title, "Searched TODO");
    const edit = describeTool("edit", { path: "a.ts", oldString: "secret old", newString: "new" });
    assert.equal(edit.title, "Edited a.ts");
    assert.ok(!edit.facts.some(([k]) => k === "oldString" || k === "newString"));
    const sh = describeTool("shell", { command: "git status\ngit diff" });
    assert.equal(sh.category, "shell");
    assert.equal(sh.command, "git status\ngit diff");
    assert.equal(sh.title, "git status …");
  });
});
