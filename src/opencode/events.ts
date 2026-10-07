// Maps OpenCode v2 event envelopes and stored messages onto the internal UiEvent
// model. Raw transport objects never leave this module.

import { findSensitive } from "../core/sensitive";
import { parseForm } from "../core/forms";
import type { FormAnswer, PermissionRequest, RawError, TokenUsage, UiEvent } from "../shared/model";
import { splitUserText } from "../shared/userText";

type Rec = Record<string, unknown>;

export interface NormalizedEnvelope {
  /** Session the events belong to; null for global events. */
  sessionID: string | null;
  events: UiEvent[];
  /** True when the set of sessions changed (created/deleted/renamed). */
  sessionsChanged: boolean;
  /** Directory the event was scoped to, when OpenCode provided one. */
  directory: string | null;
}

const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function toTokenUsage(v: unknown): TokenUsage | null {
  const t = rec(v);
  if (!t) return null;
  const cache = rec(t.cache);
  return {
    input: n(t.input),
    output: n(t.output),
    reasoning: n(t.reasoning),
    cacheRead: n(cache?.read),
    cacheWrite: n(cache?.write),
  };
}

export function modelKey(v: unknown): string | null {
  const m = rec(v);
  const provider = s(m?.providerID);
  const id = s(m?.id);
  return provider && id ? `${provider}/${id}` : null;
}

/** Concatenates text content blocks of a tool result. */
export function toolOutput(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const c of content) {
    const r = rec(c);
    if (r?.type === "text" && typeof r.text === "string") texts.push(r.text);
    else if (r?.type === "file") texts.push(`[file ${s(r.name) ?? s(r.uri) ?? ""}]`);
  }
  return texts.length ? texts.join("\n") : null;
}

function errorMessage(v: unknown, fallback: string): string {
  const e = rec(v);
  return s(e?.message) ?? fallback;
}

export function toRawError(v: unknown): RawError | null {
  const e = rec(v);
  if (!e) return null;
  return {
    type: s(e.type) ?? "unknown",
    message: s(e.message) ?? "",
    status: typeof e.status === "number" ? e.status : null,
    body: s(rec(e.response)?.body),
  };
}

function answerOf(v: unknown): FormAnswer | null {
  const r = rec(v);
  if (!r) return null;
  const out: FormAnswer = {};
  for (const [k, x] of Object.entries(r)) {
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") out[k] = x;
    else if (Array.isArray(x)) out[k] = x.filter((y): y is string => typeof y === "string");
  }
  return out;
}

export function toPermissionRequest(v: unknown): PermissionRequest | null {
  const d = rec(v);
  const id = s(d?.id);
  const sessionID = s(d?.sessionID);
  if (!d || !id || !sessionID) return null;
  const resources = Array.isArray(d.resources)
    ? d.resources.filter((r): r is string => typeof r === "string")
    : [];
  const save = Array.isArray(d.save) ? d.save : [];
  const source = rec(d.source);
  return {
    id,
    sessionID,
    action: s(d.action) ?? "unknown",
    resources,
    canAlways: save.length > 0,
    message: s(d.message),
    toolId: s(source?.id),
  };
}

function userMessageEvent(id: string, text: string, files: unknown): UiEvent {
  const split = splitUserText(text);
  const names: string[] = [];
  if (Array.isArray(files)) {
    for (const f of files) {
      const r = rec(f);
      const src = rec(r?.source);
      const name = s(r?.name) ?? s(r?.uri) ?? s(src?.uri);
      if (name) names.push(name.split(/[\\/]/).pop() ?? name);
    }
  }
  return { type: "user.message", id, text: split.text, attachments: [...names, ...split.snippets] };
}

/**
 * Stateful normalizer: remembers which shell belongs to which tool call (so a
 * command row can show its working directory) and which model produced a step.
 */
export class EventNormalizer {
  private shells = new Map<string, { cwd: string | null; command: string | null }>();
  private shellTool = new Map<string, { sessionID: string; toolId: string }>();
  private stepModel = new Map<string, string>();
  /** Last model used per session, so execution failures can name the model. */
  private sessionModel = new Map<string, string>();

  normalize(raw: unknown): NormalizedEnvelope | null {
    const env = rec(raw);
    const type = s(env?.type);
    if (!env || !type) return null;
    const data = rec(env.data) ?? {};
    const directory = s(rec(env.location)?.directory);
    const sessionID = s(data.sessionID) ?? s(rec(data.form)?.sessionID);
    const out = (events: UiEvent[], sessionsChanged = false): NormalizedEnvelope => ({
      sessionID,
      events,
      sessionsChanged,
      directory,
    });
    const partId = () => `${s(data.assistantMessageID) ?? "?"}:${n(data.ordinal)}`;
    const toolId = s(data.id) ?? "?";

    switch (type) {
      case "session.created":
      case "session.deleted":
        return out([], true);
      case "session.renamed":
        return out([{ type: "session.renamed", title: s(data.title) ?? "" }], true);
      case "session.inbox.enqueued": {
        const item = rec(data.item);
        const payload = rec(item?.payload);
        if (item?.type !== "user" || !payload) return out([]);
        const msg = userMessageEvent(s(data.inboxID) ?? "?", s(payload.text) ?? "", payload.files);
        if (msg.type !== "user.message") return out([]);
        const delivery = item.delivery === "queue" ? "queue" : "steer";
        return out([
          { type: "inbox.enqueued", id: msg.id, text: msg.text, attachments: msg.attachments, delivery },
        ]);
      }
      case "session.inbox.delivered":
        return out([{ type: "inbox.delivered", id: s(data.inboxID) ?? "?" }]);
      case "session.inbox.cancelled":
        return out([{ type: "inbox.cancelled", id: s(data.inboxID) ?? "?" }]);
      case "session.inbox.delivery.changed":
        return out([
          {
            type: "inbox.delivery",
            id: s(data.inboxID) ?? "?",
            delivery: data.delivery === "queue" ? "queue" : "steer",
          },
        ]);
      case "form.created": {
        const form = parseForm(data.form);
        return form ? out([{ type: "form.requested", form }]) : null;
      }
      case "form.replied": {
        const id = s(data.id);
        return id
          ? out([{ type: "form.resolved", formId: id, status: "answered", answer: answerOf(data.answer) }])
          : null;
      }
      case "form.cancelled": {
        const id = s(data.id);
        return id ? out([{ type: "form.resolved", formId: id, status: "cancelled", answer: null }]) : null;
      }
      case "session.execution.started":
        return out([{ type: "session.busy" }]);
      case "session.execution.succeeded":
        return out([{ type: "session.idle", outcome: "succeeded" }], true);
      case "session.execution.interrupted":
        return out([{ type: "session.idle", outcome: "interrupted" }], true);
      case "session.execution.failed":
        return out(
          [
            {
              type: "session.error",
              message: errorMessage(data.error, "The session failed."),
              error: toRawError(data.error),
              modelKey: sessionID ? (this.sessionModel.get(sessionID) ?? null) : null,
            },
            { type: "session.idle", outcome: "failed" },
          ],
          true,
        );
      case "session.text.delta":
        return out([{ type: "assistant.delta", partId: partId(), delta: s(data.delta) ?? "" }]);
      case "session.text.ended":
        return out([{ type: "assistant.completed", partId: partId(), text: s(data.text) ?? "" }]);
      case "session.reasoning.delta":
        return out([{ type: "reasoning.delta", partId: partId(), delta: s(data.delta) ?? "" }]);
      case "session.reasoning.ended":
        return out([{ type: "reasoning.completed", partId: partId(), text: s(data.text) ?? "" }]);
      case "session.tool.input.started":
        return out([{ type: "tool.started", toolId, name: s(data.name) ?? "tool" }]);
      case "session.tool.called":
        return out([{ type: "tool.input", toolId, name: null, input: rec(data.input) ?? {} }]);
      case "session.tool.progress": {
        const shellID = s(rec(data.metadata)?.shellID);
        if (!shellID || !sessionID) return out([]);
        this.shellTool.set(shellID, { sessionID, toolId });
        const info = this.shells.get(shellID);
        return out(info ? [{ type: "tool.shell", toolId, cwd: info.cwd, command: info.command }] : []);
      }
      case "shell.created": {
        const info = rec(data.info);
        const shellID = s(info?.id);
        if (!info || !shellID) return null;
        const entry = { cwd: s(info.cwd), command: s(info.command) };
        this.shells.set(shellID, entry);
        const link = this.shellTool.get(shellID);
        if (!link) return null;
        return {
          sessionID: link.sessionID,
          events: [{ type: "tool.shell", toolId: link.toolId, cwd: entry.cwd, command: entry.command }],
          sessionsChanged: false,
          directory,
        };
      }
      case "shell.deleted": {
        const id = s(data.id);
        if (id) {
          this.shells.delete(id);
          this.shellTool.delete(id);
        }
        return null;
      }
      case "session.tool.success":
        return out([
          { type: "tool.completed", toolId, output: toolOutput(data.content), metadata: rec(data.metadata) },
        ]);
      case "session.tool.failed":
        return out([
          {
            type: "tool.failed",
            toolId,
            error: errorMessage(data.error, "Tool failed"),
            output: toolOutput(data.content),
            metadata: rec(data.metadata),
          },
        ]);
      case "permission.asked": {
        const request = toPermissionRequest(data);
        if (!request) return null;
        return out([
          { type: "permission.requested", request, sensitive: describeSensitive(request.resources) },
        ]);
      }
      case "permission.replied": {
        const requestId = s(data.requestID);
        const reply = data.reply;
        if (!requestId || (reply !== "once" && reply !== "always" && reply !== "reject")) return null;
        return out([{ type: "permission.resolved", requestId, decision: reply }]);
      }
      case "session.step.started": {
        const id = s(data.assistantMessageID);
        const key = modelKey(data.model);
        if (id && key) this.stepModel.set(id, key);
        if (sessionID && key) this.sessionModel.set(sessionID, key);
        return out([]);
      }
      case "session.step.ended":
      case "session.step.failed": {
        const events: UiEvent[] = [];
        const files = Array.isArray(data.files)
          ? data.files.filter((f): f is string => typeof f === "string")
          : [];
        if (files.length) events.push({ type: "files.changed", files });
        const tokens = toTokenUsage(data.tokens);
        const msgId = s(data.assistantMessageID);
        if (tokens)
          events.push({
            type: "usage.step",
            tokens,
            modelKey: msgId ? (this.stepModel.get(msgId) ?? null) : null,
          });
        if (msgId) this.stepModel.delete(msgId);
        return out(events);
      }
      case "session.usage.updated": {
        const tokens = toTokenUsage(data.tokens);
        return out(tokens ? [{ type: "usage.session", cost: n(data.cost), tokens }] : []);
      }
      case "session.retry.scheduled":
        return out([
          {
            type: "session.retry",
            attempt: n(data.attempt),
            message: errorMessage(data.error, "Provider error"),
          },
        ]);
      case "session.compaction.started":
        return out([{ type: "notice", level: "info", text: "Compacting conversation context…" }]);
      case "session.compaction.failed":
        return out([
          {
            type: "notice",
            level: "error",
            text: `Context compaction failed: ${errorMessage(data.error, "unknown error")}`,
          },
        ]);
      default:
        return out([]);
    }
  }
}

export function describeSensitive(resources: readonly string[]): string[] {
  return findSensitive(resources).map((m) => `${m.value} — ${m.reason}`);
}

/**
 * Replays stored session messages (oldest first) as UiEvents so history and
 * live streaming share one rendering path.
 */
export function historyToEvents(messages: readonly unknown[]): UiEvent[] {
  const events: UiEvent[] = [];
  for (const raw of messages) {
    const m = rec(raw);
    if (!m) continue;
    const id = s(m.id) ?? "?";
    switch (m.type) {
      case "user":
        events.push(userMessageEvent(id, s(m.text) ?? "", m.files));
        break;
      case "assistant": {
        const counters = { text: 0, reasoning: 0 };
        const content = Array.isArray(m.content) ? m.content : [];
        for (const partRaw of content) {
          const part = rec(partRaw);
          if (!part) continue;
          if (part.type === "text") {
            events.push({
              type: "assistant.completed",
              partId: `${id}:${counters.text++}`,
              text: s(part.text) ?? "",
            });
          } else if (part.type === "reasoning") {
            events.push({
              type: "reasoning.completed",
              partId: `${id}:${counters.reasoning++}`,
              text: s(part.text) ?? "",
            });
          } else if (part.type === "tool") {
            const toolId = s(part.id) ?? "?";
            const state = rec(part.state) ?? {};
            events.push({ type: "tool.started", toolId, name: s(part.name) ?? "tool" });
            events.push({ type: "tool.input", toolId, name: s(part.name), input: rec(state.input) ?? {} });
            if (state.status === "completed") {
              events.push({
                type: "tool.completed",
                toolId,
                output: toolOutput(state.content),
                metadata: rec(state.metadata),
              });
            } else if (state.status === "error") {
              events.push({
                type: "tool.failed",
                toolId,
                error: errorMessage(state.error, "Tool failed"),
                output: toolOutput(state.content),
                metadata: rec(state.metadata),
              });
            }
          }
        }
        const tokens = toTokenUsage(m.tokens);
        if (tokens) events.push({ type: "usage.step", tokens, modelKey: modelKey(m.model) });
        if (rec(m.error) && m.finish === "error") {
          events.push({
            type: "session.error",
            message: errorMessage(m.error, "The step failed."),
            error: toRawError(m.error),
            modelKey: modelKey(m.model),
          });
        }
        break;
      }
      case "shell": {
        const toolId = `shell-msg:${id}`;
        events.push({ type: "tool.started", toolId, name: "shell" });
        events.push({ type: "tool.input", toolId, name: "shell", input: { command: s(m.command) ?? "" } });
        const output = s(rec(m.output)?.output);
        events.push({
          type: "tool.completed",
          toolId,
          output,
          metadata: typeof m.exit === "number" ? { exit: m.exit } : null,
        });
        break;
      }
      case "compaction":
        events.push({ type: "notice", level: "info", text: "Conversation context was compacted." });
        break;
      case "idle": {
        const outcome = m.outcome === "failed" || m.outcome === "interrupted" ? m.outcome : "succeeded";
        events.push({ type: "session.idle", outcome });
        break;
      }
      default:
        break;
    }
  }
  return events;
}
