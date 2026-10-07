import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONTINUE_TEXT,
  decideNotification,
  deriveTaskFromHistory,
  summarizeTask,
  type TaskNotice,
} from "../src/core/currentTask";

describe("task summary (local, no model call)", () => {
  it("uses the first meaningful line and strips Markdown", () => {
    assert.equal(
      summarizeTask("## Close the release checklist only.\n\nRepository:\n/Users/x/repo"),
      "Close the release checklist only.",
    );
    assert.equal(summarizeTask("- **Fix** the `cart` total"), "Fix the cart total");
  });

  it("skips boilerplate, separators and bare paths", () => {
    const master = [
      "You are continuing development of the standalone VS Code extension:",
      "",
      "Repository:",
      "/Users/me/Documents/project",
      "",
      "==================================================",
      "Release Closure Verification",
      "==================================================",
      "Details…",
    ].join("\n");
    assert.equal(summarizeTask(master), "Release Closure Verification");
  });

  it("skips section labels and metadata, and prefers an explicit assignment after an intro", () => {
    const master = [
      "You are continuing work on the production-grade inventory SaaS:",
      "",
      "Repository:",
      " /projects/app",
      "Current latest repository state:",
      "Validated release:",
      "- branch: release/1.0-staging",
      "- commit: abc1234",
      "No deployment has happened yet.",
      "Your assignment:",
      "M7 — REPORTING MODULE",
      "Build a complete authenticated browser-based application.",
    ].join("\n");
    assert.equal(summarizeTask(master), "M7 — REPORTING MODULE");
    assert.equal(
      summarizeTask("You are an expert.\nTask: Fix the receipt rounding\nMore"),
      "Fix the receipt rounding",
    );
    assert.equal(
      summarizeTask("You are continuing:\nRepository:\n/x\nNo marker here, just this line."),
      "No marker here, just this line.",
    );
  });

  it("keeps the first line when the prompt leads with the task, even if markers appear later", () => {
    const p = [
      "Close the release checklist only.",
      "Repository:",
      "/p",
      "Branch:",
      "feat/x",
      "Your job now is verification only.",
      "Task: something else",
    ].join("\n");
    assert.equal(summarizeTask(p), "Close the release checklist only.");
    assert.equal(summarizeTask("Deploy to PRODUCTION.\nRepository:\n/p"), "Deploy to PRODUCTION.");
  });

  it("truncates long lines at a word boundary (≈72 chars)", () => {
    const s = summarizeTask(
      "Refactor the inventory projection service so that branch filters are applied before pagination happens everywhere",
    );
    assert.ok(s.length <= 73 && s.endsWith("…"), s);
  });

  it("ignores inline selection snippets and code fences", () => {
    const raw = "Explain this\n\nSelected code from `a.ts` (lines 1-2):\n```ts\nconst a = 1;\n```";
    assert.equal(summarizeTask(raw), "Explain this");
    assert.equal(summarizeTask("```\ncode only\n```\nThen run tests"), "Then run tests");
  });

  it("keeps Arabic text", () => {
    assert.equal(summarizeTask("أغلق المرحلة ب/ج فقط.\nتفاصيل"), "أغلق المرحلة ب/ج فقط.");
  });

  it("falls back to the first non-empty line and never invents text", () => {
    assert.equal(summarizeTask("\n\n/only/a/path\n"), "/only/a/path");
    assert.equal(summarizeTask(""), "");
  });
});

const user = (id: string, text: string) => ({ id, type: "user", text });
const asst = (finish: string) => ({ id: "a", type: "assistant", finish, content: [] });
const idle = (outcome: string) => ({ id: "i", type: "idle", outcome });

describe("task from stored history", () => {
  it("first prompt is the task; a later prompt after idle replaces it", () => {
    assert.equal(
      deriveTaskFromHistory([user("u1", "One"), asst("stop"), idle("succeeded")], false)?.raw,
      "One",
    );
    const t = deriveTaskFromHistory(
      [
        user("u1", "One"),
        asst("stop"),
        idle("succeeded"),
        user("u2", "Two"),
        asst("stop"),
        idle("interrupted"),
      ],
      false,
    );
    assert.deepEqual(t, { id: "u2", raw: "Two", status: "stopped", steer: null });
  });

  it("a message delivered mid-step is a steer; one delivered after a finished step is a new (queued) task", () => {
    const steer = deriveTaskFromHistory(
      [
        user("u1", "Task"),
        asst("tool-calls"),
        user("u2", "Don't touch Finance"),
        asst("stop"),
        idle("succeeded"),
      ],
      false,
    );
    assert.equal(steer?.id, "u1");
    assert.equal(steer?.steer, "Don't touch Finance");
    const queued = deriveTaskFromHistory(
      [user("u1", "Task"), asst("stop"), user("u2", "Queued next"), asst("stop"), idle("succeeded")],
      false,
    );
    assert.equal(queued?.id, "u2");
  });

  it("Budget Guard continuations keep the same task", () => {
    const t = deriveTaskFromHistory(
      [
        user("u1", "Big task"),
        asst("tool-calls"),
        idle("interrupted"),
        user("u2", CONTINUE_TEXT),
        asst("stop"),
        idle("succeeded"),
      ],
      false,
    );
    assert.equal(t?.id, "u1");
    assert.equal(t?.status, "completed");
  });

  it("reports running, failed, and no status when it cannot be derived", () => {
    assert.equal(deriveTaskFromHistory([user("u1", "x"), asst("tool-calls")], true)?.status, "running");
    assert.equal(deriveTaskFromHistory([user("u1", "x"), idle("failed")], false)?.status, "failed");
    assert.equal(deriveTaskFromHistory([user("u1", "x"), asst("tool-calls")], false)?.status, null);
    assert.equal(deriveTaskFromHistory([], false), null);
  });
});

const notice = (kind: TaskNotice["kind"]): TaskNotice => ({
  kind,
  summary: "Release Closure Verification",
  sessionTitle: "M16",
  key: kind,
});
const allOn = { taskComplete: true, needsInput: true, taskFailed: true, budgetStopped: true };

describe("notification decisions", () => {
  it("uses the Current Task summary in the message", () => {
    assert.equal(
      decideNotification(notice("completed"), allOn, { viewVisible: false, windowFocused: true }).message,
      "✅ OpenCode task completed: Release Closure Verification",
    );
  });

  it("suppresses completion only while the user is watching the chat", () => {
    assert.equal(
      decideNotification(notice("completed"), allOn, { viewVisible: true, windowFocused: true }).show,
      false,
    );
    assert.equal(
      decideNotification(notice("completed"), allOn, { viewVisible: true, windowFocused: false }).show,
      true,
    );
    assert.equal(
      decideNotification(notice("completed"), allOn, { viewVisible: false, windowFocused: true }).show,
      true,
    );
  });

  it("always shows needs-input (prominent), failure and budget stop", () => {
    for (const k of ["needs-input", "failed", "budget-stopped"] as const) {
      assert.equal(
        decideNotification(notice(k), allOn, { viewVisible: true, windowFocused: true }).show,
        true,
        k,
      );
    }
    assert.equal(
      decideNotification(notice("needs-input"), allOn, { viewVisible: true, windowFocused: true }).severity,
      "warning",
    );
    assert.equal(
      decideNotification(notice("failed"), allOn, { viewVisible: false, windowFocused: false }).severity,
      "error",
    );
  });

  it("each type can be disabled in settings", () => {
    const ctx = { viewVisible: false, windowFocused: false };
    assert.equal(decideNotification(notice("completed"), { ...allOn, taskComplete: false }, ctx).show, false);
    assert.equal(decideNotification(notice("needs-input"), { ...allOn, needsInput: false }, ctx).show, false);
    assert.equal(decideNotification(notice("failed"), { ...allOn, taskFailed: false }, ctx).show, false);
    assert.equal(
      decideNotification(notice("budget-stopped"), { ...allOn, budgetStopped: false }, ctx).show,
      false,
    );
  });
});
