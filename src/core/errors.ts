// Turns OpenCode/provider errors into short, human-readable messages while
// keeping the technical details for the output channel.

import type { ErrorAction, RawError } from "../shared/model";
import { redact } from "./redact";

export interface FriendlyError {
  kind:
    | "funds"
    | "quota"
    | "rate-limit"
    | "auth"
    | "model-not-found"
    | "context-length"
    | "overloaded"
    | "network"
    | "content-filter"
    | "timeout"
    | "unknown";
  title: string;
  detail: string;
  actions: ErrorAction[];
}

export interface ErrorContext {
  /** Model display name, e.g. "MiniMax M3". */
  modelName: string | null;
  /** Provider display name, e.g. "OpenCode Go". */
  providerName: string | null;
}

interface Rule {
  kind: FriendlyError["kind"];
  test: (text: string, status: number | null, type: string) => boolean;
  title: (who: string) => string;
  actions: ErrorAction[];
}

const RULES: Rule[] = [
  {
    kind: "funds",
    test: (t, s) =>
      s === 402 ||
      /insufficient (account )?(funds|balance|credit)|payment required|out of credits|credit balance/i.test(
        t,
      ),
    title: (who) => `${who} reported insufficient funds.`,
    actions: ["changeModel", "retry"],
  },
  {
    kind: "quota",
    test: (t) =>
      /quota (exceeded|exhausted)|usage limit|limit reached for|exceeded your (current )?quota|monthly limit/i.test(
        t,
      ),
    title: (who) => `${who} reported that a usage quota was reached.`,
    actions: ["changeModel", "retry"],
  },
  {
    kind: "rate-limit",
    test: (t, s) => s === 429 || /rate.?limit|too many requests/i.test(t),
    title: (who) => `${who} is rate-limiting requests.`,
    actions: ["retry", "changeModel"],
  },
  {
    kind: "auth",
    test: (t, s) =>
      s === 401 ||
      s === 403 ||
      /invalid (api )?key|unauthori[sz]ed|authentication|forbidden|not authenticated/i.test(t),
    title: (who) =>
      `${who} rejected the credentials. Check the provider sign-in in OpenCode (\`opencode auth\`).`,
    actions: ["changeModel", "retry"],
  },
  {
    kind: "context-length",
    test: (t) =>
      /context (length|window)|maximum context|too many tokens|prompt is too long|token limit/i.test(t),
    title: () =>
      "The conversation is too long for this model's context window. Start a new session or pick a model with a larger context.",
    actions: ["changeModel"],
  },
  {
    kind: "model-not-found",
    test: (t, s) =>
      (s === 404 && /model/i.test(t)) ||
      /model .*(not found|does not exist|unavailable|not supported)|unknown model/i.test(t),
    title: (who) => `${who} does not offer this model right now.`,
    actions: ["changeModel"],
  },
  {
    kind: "overloaded",
    test: (t, s) =>
      s === 503 ||
      s === 529 ||
      s === 502 ||
      /overloaded|service unavailable|bad gateway|temporarily unavailable/i.test(t),
    title: (who) => `${who} is temporarily unavailable or overloaded.`,
    actions: ["retry", "changeModel"],
  },
  {
    kind: "network",
    test: (t, _s, type) =>
      /transport/.test(type) ||
      /connectionrefused|econnrefused|enotfound|unable to connect|network error|fetch failed|socket hang up/i.test(
        t,
      ),
    title: (who) => `Could not reach ${who}.`,
    actions: ["retry", "changeModel"],
  },
  {
    kind: "timeout",
    test: (t) => /timed? ?out|timeout/i.test(t),
    title: (who) => `${who} did not respond in time.`,
    actions: ["retry"],
  },
  {
    kind: "content-filter",
    test: (t) => /content.?filter|safety system|flagged/i.test(t),
    title: (who) => `${who} declined the request (content filter).`,
    actions: ["retry", "changeModel"],
  },
];

/** Short, safe excerpt of a provider message (redacted, single line, bounded). */
export function safeMessage(text: string, max = 300): string {
  const one = redact(text).replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export function classifyError(err: RawError, ctx: ErrorContext): FriendlyError {
  const text = `${err.message} ${err.body ?? ""}`;
  const who = ctx.modelName
    ? `${ctx.modelName}${ctx.providerName ? ` (${ctx.providerName})` : ""}`
    : (ctx.providerName ?? "The model provider");
  for (const rule of RULES) {
    if (rule.test(text, err.status, err.type)) {
      return {
        kind: rule.kind,
        title: rule.title(who),
        detail: safeMessage(err.message),
        actions: rule.actions,
      };
    }
  }
  return {
    kind: "unknown",
    title: `The request failed${ctx.modelName ? ` (${ctx.modelName})` : ""}.`,
    detail: safeMessage(err.message),
    actions: ["retry", "changeModel"],
  };
}

/** One log line with everything useful for diagnosis and nothing secret. */
export function describeForLog(
  err: RawError,
  ctx: { providerID: string | null; modelKey: string | null },
): string {
  const parts = [
    `type=${err.type}`,
    `status=${err.status ?? "n/a"}`,
    `provider=${ctx.providerID ?? "unknown"}`,
    `model=${ctx.modelKey ?? "unknown"}`,
    `message="${safeMessage(err.message, 500)}"`,
  ];
  if (err.body) parts.push(`body="${safeMessage(err.body, 500)}"`);
  return parts.join(" ");
}
