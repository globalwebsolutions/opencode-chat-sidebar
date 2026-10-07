// Session-level behaviour (sessions, model/agent selection, prompting,
// streaming, permissions, cancellation, changed files, usage) on top of the
// OpenCodeClient adapter. Free of VS Code APIs so it can be unit-tested.

import { buildPrompt } from "./context";
import { OpenCodeHttpError, type OpenCodeClient } from "../opencode/client";
import { describeSensitive, EventNormalizer, historyToEvents } from "../opencode/events";
import type {
  AgentOption,
  ContextAttachment,
  FileChange,
  ModelOption,
  PermissionDecision,
  SessionSummary,
  TokenUsage,
  TranscriptItem,
  UiEvent,
  UsageInfo,
} from "../shared/model";
import { Transcript } from "../shared/transcript";

export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface ControllerLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface ControllerSink {
  onEvents(events: UiEvent[]): void;
  onTranscriptReset(items: TranscriptItem[]): void;
  onStateChanged(): void;
}

export interface ControllerDefaults {
  model: string;
  agent: string;
}

export const HISTORY_LIMIT = 400;
const SESSION_LIST_LIMIT = 30;

export function contextTokens(t: TokenUsage): number {
  return t.input + t.cacheRead + t.cacheWrite + t.output;
}

export function friendlyError(e: unknown, fallback: string): string {
  if (e instanceof OpenCodeHttpError) {
    if (e.status === 401) return "OpenCode rejected the connection credentials.";
    if (e.status === 404) return `${fallback} (not found).`;
    return `${fallback}: ${e.message}`;
  }
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"))
    return `${fallback}: OpenCode did not respond in time.`;
  if (e instanceof TypeError) return `${fallback}: could not reach OpenCode.`;
  return fallback + ".";
}

export class SessionController {
  readonly transcript = new Transcript();
  directory: string | null = null;
  models: ModelOption[] | null = null;
  agents: AgentOption[] | null = null;
  selectedModel: string | null = null;
  selectedAgent: string | null = null;
  sessions: SessionSummary[] = [];
  current: SessionSummary | null = null;
  busy = false;
  stopping = false;
  changes: FileChange[] = [];
  private lastStep: { tokens: TokenUsage; modelKey: string | null } | null = null;
  private sessionCost: number | null = null;
  private readonly normalizer = new EventNormalizer();
  private sessionsTimer: ReturnType<typeof setTimeout> | undefined;
  private changesTimer: ReturnType<typeof setTimeout> | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private loadToken = 0;
  private disposed = false;

  constructor(
    private readonly client: OpenCodeClient,
    private readonly store: KeyValueStore,
    private readonly sink: ControllerSink,
    private readonly log: ControllerLog,
    private readonly defaults: () => ControllerDefaults,
    private readonly timing = { debounceMs: 400, stopCheckMs: 15_000, modelRetryMs: 1500 },
  ) {}

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.sessionsTimer);
    clearTimeout(this.changesTimer);
    clearTimeout(this.stopTimer);
  }

  usage(contextLimitFallback = true): UsageInfo | null {
    const step = this.lastStep;
    const tokens = step ? contextTokens(step.tokens) : null;
    const modelKey = step?.modelKey ?? (contextLimitFallback ? this.selectedModel : null);
    const limit = this.models?.find((m) => m.key === modelKey)?.contextLimit ?? null;
    if (tokens === null && this.sessionCost === null) return null;
    return { contextTokens: tokens, contextLimit: tokens === null ? null : limit, cost: this.sessionCost };
  }

  // ---------------------------------------------------------------- catalog

  /** Switches to a workspace directory: loads models, agents and sessions for it. */
  async setDirectory(directory: string | null): Promise<void> {
    if (this.directory === directory && this.models !== null) return;
    this.directory = directory;
    this.clearSession();
    this.sessions = [];
    this.models = null;
    this.agents = null;
    this.sink.onStateChanged();
    if (!directory) return;
    await Promise.all([this.loadCatalog(), this.refreshSessions()]);
    const remembered = this.store.get<string>(this.key("session"));
    if (remembered && this.sessions.some((s) => s.id === remembered)) await this.openSession(remembered);
  }

  private key(kind: "model" | "agent" | "session"): string {
    return `opencodeSidebar.${kind}:${this.directory ?? ""}`;
  }

  async loadCatalog(): Promise<void> {
    const dir = this.directory;
    if (!dir) return;
    try {
      let models = await this.client.listModels(dir);
      if (models.length === 0) {
        // A location that OpenCode has not loaded yet can briefly report no models.
        await delay(this.timing.modelRetryMs);
        models = await this.client.listModels(dir);
      }
      if (dir !== this.directory) return;
      this.models = models;
    } catch (e) {
      this.log.error("Loading models failed", e);
      this.models = null;
    }
    try {
      const agents = await this.client.listAgents(dir);
      if (dir !== this.directory) return;
      this.agents = agents;
    } catch (e) {
      this.log.error("Loading agents failed", e);
      this.agents = null;
    }
    await this.pickDefaults();
    this.sink.onStateChanged();
  }

  private async pickDefaults(): Promise<void> {
    const d = this.defaults();
    const models = this.models ?? [];
    const has = (k: string | null | undefined): k is string => !!k && models.some((m) => m.key === k);
    let model: string | null = this.store.get<string>(this.key("model")) ?? null;
    if (!has(model)) model = has(d.model) ? d.model : null;
    if (!model && this.directory) {
      try {
        const def = await this.client.defaultModel(this.directory);
        if (has(def)) model = def;
      } catch {
        // fall through
      }
    }
    if (!model && models.length) model = models[0].key;
    this.selectedModel = model;

    const agents = this.agents ?? [];
    const hasAgent = (a: string | null | undefined): a is string => !!a && agents.some((x) => x.id === a);
    let agent: string | null = this.store.get<string>(this.key("agent")) ?? null;
    if (!hasAgent(agent))
      agent = hasAgent(d.agent) ? d.agent : hasAgent("build") ? "build" : (agents[0]?.id ?? null);
    this.selectedAgent = agent;
  }

  async refreshSessions(): Promise<void> {
    const dir = this.directory;
    if (!dir) return;
    try {
      const sessions = await this.client.listSessions(dir, SESSION_LIST_LIMIT);
      if (dir !== this.directory) return;
      this.sessions = sessions;
      if (this.current) {
        const fresh = sessions.find((s) => s.id === this.current?.id);
        if (fresh) this.current = { ...fresh, cost: fresh.cost ?? this.current.cost };
      }
      this.sink.onStateChanged();
    } catch (e) {
      this.log.error("Listing sessions failed", e);
    }
  }

  private scheduleSessionsRefresh(): void {
    clearTimeout(this.sessionsTimer);
    this.sessionsTimer = setTimeout(() => void this.refreshSessions(), this.timing.debounceMs);
  }

  // --------------------------------------------------------------- sessions

  private clearSession(): void {
    this.current = null;
    this.busy = false;
    this.stopping = false;
    this.changes = [];
    this.lastStep = null;
    this.sessionCost = null;
    clearTimeout(this.stopTimer);
    this.transcript.reset();
    this.sink.onTranscriptReset([]);
  }

  /** Starts a fresh conversation. The OpenCode session is created lazily on first send. */
  async newSession(): Promise<void> {
    this.loadToken++;
    this.clearSession();
    if (this.directory) await this.store.update(this.key("session"), undefined);
    this.sink.onStateChanged();
  }

  /** Continues an existing OpenCode session: replays history, pending permissions and state. */
  async openSession(id: string): Promise<boolean> {
    const token = ++this.loadToken;
    try {
      const [summary, messages, permissions, active] = await Promise.all([
        this.client.getSession(id),
        this.client.listMessages(id, HISTORY_LIMIT),
        this.client.listPermissions(id).catch(() => []),
        this.client.activeSessions().catch(() => new Set<string>()),
      ]);
      if (token !== this.loadToken) return false;
      this.clearSession();
      this.current = summary;
      this.sessionCost = summary.cost;
      this.busy = active.has(id);
      for (const ev of historyToEvents(messages)) this.applyLocal(ev);
      for (const request of permissions) {
        this.applyLocal({
          type: "permission.requested",
          request,
          sensitive: describeSensitive(request.resources),
        });
      }
      if (summary.modelKey && this.models?.some((m) => m.key === summary.modelKey))
        this.selectedModel = summary.modelKey;
      if (summary.agent && this.agents?.some((a) => a.id === summary.agent))
        this.selectedAgent = summary.agent;
      if (this.directory) await this.store.update(this.key("session"), id);
      this.sink.onTranscriptReset(this.transcript.items);
      this.sink.onStateChanged();
      void this.refreshChanges();
      return true;
    } catch (e) {
      this.log.error(`Opening session ${id} failed`, e);
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Could not open the session") }]);
      return false;
    }
  }

  async selectModel(key: string): Promise<void> {
    const model = this.models?.find((m) => m.key === key);
    if (!model) return;
    this.selectedModel = key;
    if (this.directory) await this.store.update(this.key("model"), key);
    this.sink.onStateChanged();
    if (this.current) {
      try {
        await this.client.switchModel(this.current.id, { providerID: model.providerID, id: model.id });
      } catch (e) {
        this.log.error("Switching model failed", e);
        this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Model unavailable") }]);
      }
    }
  }

  async selectAgent(id: string): Promise<void> {
    if (!this.agents?.some((a) => a.id === id)) return;
    this.selectedAgent = id;
    if (this.directory) await this.store.update(this.key("agent"), id);
    this.sink.onStateChanged();
    if (this.current) {
      try {
        await this.client.switchAgent(this.current.id, id);
      } catch (e) {
        this.log.error("Switching agent failed", e);
        this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Could not switch agent") }]);
      }
    }
  }

  // ---------------------------------------------------------------- prompts

  /** Sends a prompt. Returns false when nothing was sent (caller may restore the input). */
  async send(text: string, attachments: readonly ContextAttachment[]): Promise<boolean> {
    if (!this.directory) {
      this.emit([{ type: "notice", level: "error", text: "Open a folder to start an OpenCode session." }]);
      return false;
    }
    if (this.busy) return false;
    const payload = buildPrompt(text, attachments);
    if (!payload.text) {
      if (payload.files.length) {
        this.emit([
          { type: "notice", level: "info", text: "Type a message to send with the attached files." },
        ]);
      }
      return false;
    }

    this.busy = true;
    this.sink.onStateChanged();
    try {
      if (!this.current) {
        const model = this.models?.find((m) => m.key === this.selectedModel);
        const created = await this.client.createSession({
          directory: this.directory,
          agent: this.selectedAgent ?? undefined,
          model: model ? { providerID: model.providerID, id: model.id } : undefined,
        });
        this.current = created;
        this.loadToken++;
        await this.store.update(this.key("session"), created.id);
        this.log.info(`Created session ${created.id}`);
        this.scheduleSessionsRefresh();
      }
      const res = await this.client.prompt(this.current.id, payload);
      this.log.info(
        `Prompt sent to ${this.current.id} (${payload.text.length} chars, ${payload.files.length} file attachment(s))`,
      );
      // The server echoes the message as session.inbox.enqueued; this covers a missed event.
      if (res.id && !this.transcript.has(`user:${res.id}`)) {
        const ev = historyToEvents([{ type: "user", id: res.id, text: payload.text, files: payload.files }]);
        this.emit(ev);
      }
      return true;
    } catch (e) {
      this.busy = false;
      this.log.error("Sending prompt failed", e);
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Session failed") }]);
      this.sink.onStateChanged();
      return false;
    }
  }

  /** Cancels the active execution through OpenCode's interrupt API. */
  async stop(): Promise<void> {
    if (!this.current || !this.busy) return;
    const id = this.current.id;
    this.stopping = true;
    this.sink.onStateChanged();
    try {
      const interrupted = await this.client.interrupt(id);
      this.log.info(`Interrupt ${id}: ${interrupted ? "accepted" : "nothing running"}`);
      if (!interrupted) {
        this.busy = false;
        this.stopping = false;
        this.sink.onStateChanged();
        return;
      }
      clearTimeout(this.stopTimer);
      this.stopTimer = setTimeout(() => void this.verifyStopped(id), this.timing.stopCheckMs);
    } catch (e) {
      this.stopping = false;
      this.log.error("Interrupt failed", e);
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Could not stop the session") }]);
      this.sink.onStateChanged();
    }
  }

  private async verifyStopped(id: string): Promise<void> {
    if (this.current?.id !== id || !this.stopping) return;
    try {
      const active = await this.client.activeSessions();
      if (!active.has(id)) {
        this.busy = false;
        this.stopping = false;
        this.sink.onStateChanged();
      }
    } catch {
      // keep current state; the event stream will settle it
    }
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    const item = this.transcript.get(`perm:${requestId}`);
    if (!this.current || item?.kind !== "permission" || item.status !== "pending") return;
    if (decision === "always" && !item.request.canAlways) return;
    this.emit([{ type: "permission.sending", requestId }]);
    try {
      await this.client.replyPermission(this.current.id, requestId, decision);
      this.log.info(`Permission ${requestId} (${item.request.action}) answered: ${decision}`);
      this.emit([{ type: "permission.resolved", requestId, decision }]);
    } catch (e) {
      if (e instanceof OpenCodeHttpError && e.status === 404) {
        this.emit([
          { type: "permission.resolved", requestId, decision: "expired" },
          { type: "notice", level: "info", text: "Permission request expired." },
        ]);
      } else {
        this.log.error("Permission reply failed", e);
        // Re-open the card so the user can try again.
        this.emit([
          { type: "permission.requested", request: item.request, sensitive: item.sensitive },
          {
            type: "notice",
            level: "error",
            text: friendlyError(e, "Could not answer the permission request"),
          },
        ]);
      }
    }
  }

  // ----------------------------------------------------------------- events

  /** Entry point for every raw event from the OpenCode event stream. */
  handleRawEvent(raw: unknown): void {
    if (this.disposed) return;
    const env = this.normalizer.normalize(raw);
    if (!env) return;
    if (env.sessionsChanged && (env.directory === null || env.directory === this.directory))
      this.scheduleSessionsRefresh();
    if (!this.current || env.sessionID !== this.current.id || env.events.length === 0) return;
    this.emit(env.events);
  }

  /** Called when the event stream reconnects; resynchronizes the open session. */
  async resync(): Promise<void> {
    if (this.current) await this.openSession(this.current.id);
    else await this.refreshSessions();
  }

  private applyLocal(ev: UiEvent): void {
    switch (ev.type) {
      case "session.busy":
        this.busy = true;
        break;
      case "session.idle":
        this.busy = false;
        this.stopping = false;
        clearTimeout(this.stopTimer);
        break;
      case "session.renamed":
        if (this.current) this.current = { ...this.current, title: ev.title };
        break;
      case "usage.step":
        this.lastStep = { tokens: ev.tokens, modelKey: ev.modelKey };
        break;
      case "usage.session":
        this.sessionCost = ev.cost;
        break;
      default:
        break;
    }
    this.transcript.apply(ev);
  }

  private emit(events: UiEvent[]): void {
    let stateChanged = false;
    let changesDirty = false;
    for (const ev of events) {
      if (/^(session\.|usage\.)/.test(ev.type)) stateChanged = true;
      if (ev.type === "files.changed" || ev.type === "session.idle") changesDirty = true;
      this.applyLocal(ev);
    }
    this.sink.onEvents(events);
    if (stateChanged) this.sink.onStateChanged();
    if (changesDirty) this.scheduleChangesRefresh();
  }

  // ---------------------------------------------------------------- changes

  private scheduleChangesRefresh(): void {
    clearTimeout(this.changesTimer);
    this.changesTimer = setTimeout(() => void this.refreshChanges(), this.timing.debounceMs);
  }

  async refreshChanges(): Promise<void> {
    const id = this.current?.id;
    if (!id) return;
    try {
      const diff = await this.client.sessionDiff(id);
      if (this.current?.id !== id) return;
      this.changes = diff.map((d) => ({
        path: d.file,
        additions: d.additions,
        deletions: d.deletions,
        status: d.status,
      }));
      this.sink.onStateChanged();
    } catch (e) {
      this.log.warn(`Session diff unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
