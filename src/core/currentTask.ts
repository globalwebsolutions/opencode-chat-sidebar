// "Current Task": the latest normal user instruction that started the active
// (or last) agent run. Derived locally from the user's own text; no model calls.

import { splitUserText } from "../shared/userText";

/** Text sent by Budget Guard's Continue once / Increase budget. It continues a task; it is not a new one. */
export const CONTINUE_TEXT = "Continue the previous task from where you stopped.";

export type TaskStatus = "running" | "completed" | "stopped" | "budget-stopped" | "failed";

export interface TaskRecord {
  /** User message id of the prompt that started the task. */
  id: string;
  /** Exact original prompt text as stored by OpenCode. */
  raw: string;
  status: TaskStatus | null;
  /** Latest steering instruction delivered into this task. */
  steer: string | null;
}

const MAX_SUMMARY = 72;

const BOILERPLATE: RegExp[] = [
  /^you are (continuing|working|now|an?|the)\b/i,
  /^(important|note|notes|context|background|repository|repo|branch|path|paths|working directory|cwd|project|current release|current commit|release|commit|version)\s*:?\s*$/i,
  /^(repository|repo|branch|path|working directory|cwd|commit)\s*:/i,
  /^(continue working|continue)\s+(in|on)\b.*\b(repository|repo)\b/i,
  /^(start now|proceed now|begin)\.?$/i,
  /^(hi|hello|hey)[,!.]?$/i,
];

/** Removes Markdown decoration so the summary reads as plain text. */
function plain(line: string): string {
  return line
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d{1,3}[.)]\s+)/, "")
    .replace(/`+/g, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function isSeparator(line: string): boolean {
  return /^[=\-_*#~·•.]{3,}$/.test(line.replace(/\s+/g, ""));
}

function isPathOnly(line: string): boolean {
  return (
    /^(~|\.{1,2})?[\\/][^\s]*$/.test(line) ||
    /^[A-Za-z]:\\[^\s]*$/.test(line) ||
    /^[\w.-]+\/[\w./-]+$/.test(line)
  );
}

function truncate(text: string, max = MAX_SUMMARY): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, "") + "…";
}

const INTRO = /^you are (continuing|working|now|an?|the)\b/i;
const MARKER =
  /^(your (task|job|assignment|goal|mission)|task|goal|objective|mission|assignment)\s*:\s*(.*)$/i;
const METADATA_KEY =
  /^(branch|commit|tag|repository|repo|path|version|release|base|head|model|provider|current (base )?(head|commit|branch|release)|current validated release)\s*:\s*\S/i;

/** A line that can stand as a task summary (not decoration, a bare path, a label or metadata). */
function meaningful(line: string, inFence: boolean): string | null {
  if (inFence || isSeparator(line)) return null;
  const p = plain(line);
  if (!p || isPathOnly(p) || BOILERPLATE.some((re) => re.test(p))) return null;
  if (/^[^\p{L}\p{N}]*$/u.test(p)) return null;
  if (p.endsWith(":")) return null; // section label ("Repository:", "Current state:")
  if (METADATA_KEY.test(p)) return null; // "branch: main", "commit: abc1234"
  return p;
}

/**
 * One-line summary of a prompt, derived locally:
 * - the first meaningful line (skipping boilerplate, separators, bare paths,
 *   section labels and metadata lines), trimmed to about 72 characters;
 * - when the prompt opens with an intro ("You are continuing …") and contains an
 *   explicit marker ("Your assignment:", "Task:", "Goal:", "Mission:"), the
 *   marker's text or the line after it;
 * - otherwise the first non-empty line. Never invents text.
 */
export function summarizeTask(raw: string): string {
  const text = splitUserText(raw).text || raw;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (!lines.length) return "";
  let inFence = false;
  let first: string | null = null;
  let marked: string | null = null;
  let afterMarker = false;
  const opensWithIntro = INTRO.test(plain(lines[0]));
  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (opensWithIntro && !marked && !inFence) {
      const m = MARKER.exec(plain(line));
      if (m) {
        const rest = meaningful(m[3] ?? "", false);
        if (rest) marked = rest;
        else afterMarker = true;
        continue;
      }
    }
    const p = meaningful(line, inFence);
    if (!p) continue;
    if (afterMarker && !marked) {
      marked = p;
      afterMarker = false;
    }
    if (!first) first = p;
    if (!opensWithIntro || marked) break;
  }
  const chosen = marked ?? first;
  return truncate(chosen ?? (plain(lines[0]) || lines[0]));
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Rebuilds the current/last task from stored OpenCode messages (oldest first).
 *
 * A user message starts a task when no execution is running (first message, or
 * after an idle marker) or when the previous assistant step finished with
 * `stop` (a queued instruction delivered after the task ended). A user message
 * delivered after a `tool-calls` step was steered into the running task.
 * Budget Guard continuations keep the same task.
 */
export function deriveTaskFromHistory(messages: readonly unknown[], running: boolean): TaskRecord | null {
  let task = null as TaskRecord | null;
  let inExecution = false;
  let lastFinish: string | null = null;
  for (const raw of messages) {
    const m = rec(raw);
    if (!m) continue;
    if (m.type === "user") {
      const text = typeof m.text === "string" ? m.text : "";
      const id = typeof m.id === "string" ? m.id : "";
      const prev: TaskRecord | null = task;
      if (text === CONTINUE_TEXT && prev) {
        task = { ...prev, status: "running" };
      } else if (!inExecution || lastFinish === "stop" || !prev) {
        task = { id, raw: text, status: "running", steer: null };
      } else {
        task = { ...prev, steer: text };
      }
      inExecution = true;
      lastFinish = null;
    } else if (m.type === "assistant") {
      lastFinish = typeof m.finish === "string" ? m.finish : lastFinish;
    } else if (m.type === "idle") {
      inExecution = false;
      lastFinish = null;
      const prev: TaskRecord | null = task;
      if (prev) {
        const outcome = m.outcome;
        task = {
          ...prev,
          status: outcome === "failed" ? "failed" : outcome === "interrupted" ? "stopped" : "completed",
        };
      }
    }
  }
  const last: TaskRecord | null = task;
  if (!last) return null;
  if (running) return { ...last, status: "running" };
  // A task with no idle marker and no running execution has no reliable status.
  if (last.status === "running") return { ...last, status: null };
  return last;
}

// ------------------------------------------------------------ notifications

export type TaskNoticeKind = "completed" | "needs-input" | "failed" | "budget-stopped";

export interface TaskNotice {
  kind: TaskNoticeKind;
  /** Current Task summary (never AI-generated). */
  summary: string;
  sessionTitle: string | null;
  /** Unique key; the same key is never notified twice. */
  key: string;
}

export interface NotificationSettings {
  taskComplete: boolean;
  needsInput: boolean;
  taskFailed: boolean;
  budgetStopped: boolean;
}

export interface NotificationDecision {
  show: boolean;
  severity: "info" | "warning" | "error";
  message: string;
}

/**
 * Decides whether and how to show a notice. Completion is suppressed while the
 * user is watching the chat (view visible and window focused); questions,
 * failures and budget stops are always shown unless disabled in settings.
 */
export function decideNotification(
  n: TaskNotice,
  settings: NotificationSettings,
  ctx: { viewVisible: boolean; windowFocused: boolean },
): NotificationDecision {
  const task = n.summary || "OpenCode task";
  switch (n.kind) {
    case "completed":
      return {
        show: settings.taskComplete && !(ctx.viewVisible && ctx.windowFocused),
        severity: "info",
        message: `✅ OpenCode task completed: ${task}`,
      };
    case "needs-input":
      return {
        show: settings.needsInput,
        severity: "warning",
        message: `❓ OpenCode needs your input: ${task}`,
      };
    case "failed":
      return { show: settings.taskFailed, severity: "error", message: `❌ OpenCode task failed: ${task}` };
    case "budget-stopped":
      return {
        show: settings.budgetStopped,
        severity: "warning",
        message: `⛔ OpenCode task stopped — budget reached: ${task}`,
      };
  }
}
