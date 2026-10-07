import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BudgetTracker, DEFAULT_BUDGETS, nextLevel } from "../src/core/budget";

const settings = () => ({ presets: DEFAULT_BUDGETS, warnAt: 0.8 });

function tracker(level: "off" | "small" | "medium" | "large" | "custom" = "small") {
  const b = new BudgetTracker(settings);
  b.setLevel(level);
  return b;
}

describe("budget guard", () => {
  it("uses the documented default presets", () => {
    assert.deepEqual(DEFAULT_BUDGETS.small, { maxCost: 0.1, maxSteps: 20 });
    assert.deepEqual(DEFAULT_BUDGETS.medium, { maxCost: 0.3, maxSteps: 50 });
    assert.deepEqual(DEFAULT_BUDGETS.large, { maxCost: 1.0, maxSteps: 120 });
  });

  it("warns once at 80% of the step budget and stops at 100%", () => {
    const b = tracker("small");
    b.startTask(0);
    const signals = Array.from({ length: 20 }, () => b.recordStep().kind);
    assert.equal(signals.indexOf("warning"), 15, "warning at step 16 = 80%");
    assert.equal(signals.filter((s) => s === "warning").length, 1);
    assert.equal(signals[19], "exceeded");
    assert.equal(b.recordStep().kind, "none", "exceeded is reported once");
  });

  it("measures task cost as the delta from the session cost at task start", () => {
    const b = tracker("small");
    b.startTask(5.0); // an old session that already cost $5
    assert.equal(b.recordCost(5.05).kind, "none");
    assert.equal(b.recordCost(5.085).kind, "warning");
    const s = b.recordCost(5.11);
    assert.deepEqual(s, { kind: "exceeded", metric: "cost" });
    assert.ok(Math.abs((b.taskCost() ?? 0) - 0.11) < 1e-9);
  });

  it("does nothing when the budget is off", () => {
    const b = tracker("off");
    b.startTask(0);
    for (let i = 0; i < 500; i++) assert.equal(b.recordStep().kind, "none");
    assert.equal(b.recordCost(100).kind, "none");
  });

  it("falls back to step counting when OpenCode reports no cost", () => {
    const b = tracker("small");
    b.startTask(null);
    let last = "none";
    for (let i = 0; i < 20; i++) last = b.recordStep().kind;
    assert.equal(last, "exceeded");
    assert.equal(b.view().taskCost, null);
  });

  it("does not enforce a metric that is disabled", () => {
    const b = new BudgetTracker(() => ({
      presets: { ...DEFAULT_BUDGETS, small: { maxCost: null, maxSteps: 3 } },
      warnAt: 0.8,
    }));
    b.setLevel("small");
    b.startTask(0);
    assert.equal(b.recordCost(1000).kind, "none", "cost limit disabled");
    b.recordStep();
    b.recordStep();
    assert.equal(b.recordStep().kind, "exceeded");
  });

  it("Continue once grants exactly one more budget for the same task", () => {
    const b = tracker("small");
    b.startTask(0);
    for (let i = 0; i < 20; i++) b.recordStep();
    b.continueOnce();
    b.endTask();
    b.startTask(0.5); // the continuation run must not reset counters
    assert.equal(b.view().taskSteps, 20);
    assert.equal(b.view().allowance, 2);
    let last = "none";
    let n = 0;
    while (last !== "exceeded" && n < 100) {
      last = b.recordStep().kind;
      n++;
    }
    assert.equal(n, 20, "stops again after one more budget");
    assert.equal(b.level, "small", "workspace budget unchanged");
  });

  it("a new task after a completed one starts from zero", () => {
    const b = tracker("small");
    b.startTask(0);
    for (let i = 0; i < 10; i++) b.recordStep();
    b.endTask();
    b.startTask(0.2);
    assert.equal(b.view().taskSteps, 0);
    assert.equal(b.view().allowance, 1);
  });

  it("Increase budget raises the level and keeps counting", () => {
    assert.equal(nextLevel("small"), "medium");
    assert.equal(nextLevel("large"), "large");
    const b = tracker("small");
    b.startTask(0);
    for (let i = 0; i < 20; i++) b.recordStep();
    b.increaseTo("medium");
    b.startTask(0);
    assert.equal(b.view().taskSteps, 20);
    assert.equal(b.view().limits.maxSteps, 50);
  });

  it("ignores steps outside an active task (no runaway from replayed history)", () => {
    const b = tracker("small");
    for (let i = 0; i < 50; i++) assert.equal(b.recordStep().kind, "none");
  });
});
