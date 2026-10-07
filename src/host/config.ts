import * as vscode from "vscode";
import { DEFAULT_BUDGETS, type BudgetSettings } from "../core/budget";
import type { BudgetLevel, BudgetLimits } from "../shared/model";

export interface SidebarConfig {
  executablePath: string;
  serverUrl: string;
  allowRemoteServer: boolean;
  defaultModel: string;
  defaultAgent: string;
  autoStart: boolean;
  showUsage: boolean;
  budgetDefault: BudgetLevel;
  budget: BudgetSettings;
  contextWarnPercent: number;
}

export const CONFIG_SECTION = "opencodeSidebar";

const LEVELS: BudgetLevel[] = ["off", "small", "medium", "large", "custom"];

function limits(raw: unknown, fallback: BudgetLimits): BudgetLimits {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pos = (v: unknown, f: number | null) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : v === 0 ? null : f;
  return { maxCost: pos(r.maxCost, fallback.maxCost), maxSteps: pos(r.maxSteps, fallback.maxSteps) };
}

/** Task notification toggles (`opencodeSidebar.notifications.*`, all on by default). */
export function readNotificationSettings(): {
  taskComplete: boolean;
  needsInput: boolean;
  taskFailed: boolean;
  budgetStopped: boolean;
} {
  const c = vscode.workspace.getConfiguration("opencodeSidebar.notifications");
  return {
    taskComplete: c.get<boolean>("taskComplete", true),
    needsInput: c.get<boolean>("needsInput", true),
    taskFailed: c.get<boolean>("taskFailed", true),
    budgetStopped: c.get<boolean>("budgetStopped", true),
  };
}

export function readConfig(): SidebarConfig {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const level = c.get<string>("budget.default", "medium");
  const warn = c.get<number>("budget.warnPercent", 80);
  const ctx = c.get<number>("budget.contextWarnPercent", 80);
  return {
    executablePath: c.get<string>("executablePath", ""),
    serverUrl: c.get<string>("serverUrl", ""),
    allowRemoteServer: c.get<boolean>("allowRemoteServer", false),
    defaultModel: c.get<string>("defaultModel", ""),
    defaultAgent: c.get<string>("defaultAgent", ""),
    autoStart: c.get<boolean>("autoStart", false),
    showUsage: c.get<boolean>("showUsage", true),
    budgetDefault: (LEVELS as string[]).includes(level) ? (level as BudgetLevel) : "medium",
    budget: {
      presets: {
        small: limits(c.get("budget.small"), DEFAULT_BUDGETS.small),
        medium: limits(c.get("budget.medium"), DEFAULT_BUDGETS.medium),
        large: limits(c.get("budget.large"), DEFAULT_BUDGETS.large),
        custom: limits(c.get("budget.custom"), DEFAULT_BUDGETS.custom),
      },
      warnAt: Math.min(0.99, Math.max(0.1, (Number.isFinite(warn) ? warn : 80) / 100)),
    },
    contextWarnPercent: Number.isFinite(ctx) ? Math.min(100, Math.max(0, ctx)) : 80,
  };
}
