// Local task budget guard. It only measures what OpenCode actually reports
// (session cost from usage events, completed agent steps) and never invents
// provider quotas. A "task" is one OpenCode execution: from the prompt that
// starts the agent until it goes idle.

import type { BudgetLevel, BudgetLimits, BudgetView } from "../shared/model";

export interface BudgetSettings {
  presets: Record<Exclude<BudgetLevel, "off">, BudgetLimits>;
  /** Fraction of the limit at which to warn, e.g. 0.8. */
  warnAt: number;
}

export const DEFAULT_BUDGETS: BudgetSettings["presets"] = {
  small: { maxCost: 0.1, maxSteps: 20 },
  medium: { maxCost: 0.3, maxSteps: 50 },
  large: { maxCost: 1.0, maxSteps: 120 },
  custom: { maxCost: 0.5, maxSteps: 80 },
};

export const BUDGET_LEVELS: BudgetLevel[] = ["off", "small", "medium", "large", "custom"];

export type BudgetSignal =
  { kind: "none" } | { kind: "warning" } | { kind: "exceeded"; metric: "cost" | "steps" };

export function nextLevel(level: BudgetLevel): BudgetLevel {
  if (level === "small") return "medium";
  if (level === "medium") return "large";
  return level;
}

export class BudgetTracker {
  level: BudgetLevel = "off";
  private costBase: number | null = null;
  private cost: number | null = null;
  private steps = 0;
  private allowance = 1;
  private carry = false;
  private warned = false;
  private exceeded = false;
  active = false;

  constructor(private settings: () => BudgetSettings) {}

  limits(): BudgetLimits {
    if (this.level === "off") return { maxCost: null, maxSteps: null };
    return this.settings().presets[this.level];
  }

  setLevel(level: BudgetLevel): void {
    this.level = level;
    // Re-evaluate against the new limits from scratch; an already-stopped task stays stopped.
    this.warned = false;
  }

  /** Called when an execution starts. `sessionCost` is the session's cost so far, if known. */
  startTask(sessionCost: number | null): void {
    this.active = true;
    if (this.carry) {
      // "Continue once" / "Increase budget": keep counting the same task.
      this.carry = false;
      this.exceeded = false;
      return;
    }
    this.costBase = sessionCost;
    this.cost = sessionCost;
    this.steps = 0;
    this.allowance = 1;
    this.warned = false;
    this.exceeded = false;
  }

  endTask(): void {
    this.active = false;
  }

  /** Forgets everything (new or switched session). */
  reset(): void {
    this.active = false;
    this.costBase = null;
    this.cost = null;
    this.steps = 0;
    this.allowance = 1;
    this.carry = false;
    this.warned = false;
    this.exceeded = false;
  }

  recordStep(): BudgetSignal {
    if (!this.active) return { kind: "none" };
    this.steps++;
    return this.evaluate();
  }

  /** Session cost reported by OpenCode (cumulative, USD). */
  recordCost(sessionCost: number): BudgetSignal {
    if (this.costBase === null) this.costBase = this.cost ?? 0;
    this.cost = sessionCost;
    return this.active ? this.evaluate() : { kind: "none" };
  }

  taskCost(): number | null {
    if (this.cost === null || this.costBase === null) return null;
    return Math.max(0, this.cost - this.costBase);
  }

  /** Grants one more budget-sized allowance for the current task (explicit user override). */
  continueOnce(): void {
    this.allowance += 1;
    this.carry = true;
    this.exceeded = false;
    this.warned = false;
  }

  /** The user raised the budget level; the current task continues under the new limits. */
  increaseTo(level: BudgetLevel): void {
    this.level = level;
    this.carry = true;
    this.exceeded = false;
    this.warned = false;
  }

  private fraction(): { value: number; metric: "cost" | "steps" } | null {
    const l = this.limits();
    let best: { value: number; metric: "cost" | "steps" } | null = null;
    const cost = this.taskCost();
    if (l.maxCost !== null && l.maxCost > 0 && cost !== null) {
      best = { value: cost / (l.maxCost * this.allowance), metric: "cost" };
    }
    if (l.maxSteps !== null && l.maxSteps > 0) {
      const v = this.steps / (l.maxSteps * this.allowance);
      if (!best || v > best.value) best = { value: v, metric: "steps" };
    }
    return best;
  }

  evaluate(): BudgetSignal {
    if (this.level === "off" || this.exceeded) return { kind: "none" };
    const f = this.fraction();
    if (!f) return { kind: "none" };
    if (f.value >= 1) {
      this.exceeded = true;
      return { kind: "exceeded", metric: f.metric };
    }
    if (f.value >= this.settings().warnAt && !this.warned) {
      this.warned = true;
      return { kind: "warning" };
    }
    return { kind: "none" };
  }

  isExceeded(): boolean {
    return this.exceeded;
  }

  view(): BudgetView {
    const f = this.level === "off" ? null : this.fraction();
    return {
      level: this.level,
      limits: this.limits(),
      taskCost: this.taskCost(),
      taskSteps: this.steps,
      active: this.active,
      state: this.exceeded ? "exceeded" : f && f.value >= this.settings().warnAt ? "warning" : "ok",
      allowance: this.allowance,
    };
  }
}
