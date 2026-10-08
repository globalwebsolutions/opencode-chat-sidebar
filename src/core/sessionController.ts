// Session-level behaviour (sessions, model/agent/variant selection, prompting,
// steering/queueing, streaming, permissions, forms, cancellation, budget guard,
// agent changes, usage) on top of the OpenCodeClient adapter. Free of VS Code
// APIs so it can be unit-tested.

import { BudgetTracker, nextLevel, type BudgetSettings } from "./budget";
import { buildPrompt, type PromptPayload } from "./context";
import {
  CONTINUE_TEXT,
  deriveTaskFromHistory,
  summarizeTask,
  type TaskNotice,
  type TaskRecord,
  type TaskStatus,
} from "./currentTask";
import { classifyError, describeForLog } from "./errors";
import { summarizeAnswer, validateAnswer } from "./forms";
import { reconstructSides, type FileSides } from "./patch";
import { displayTitle, isUsableTitle } from "./titles";
import { OpenCodeHttpError, type OpenCodeClient } from "../opencode/client";
import { describeSensitive, EventNormalizer, historyToEvents } from "../opencode/events";
import type {
  AccountStatus,
  AgentOption,
  BudgetLevel,
  BudgetView,
  ContextAttachment,
  FileChange,
  FormAnswer,
  InboxDelivery,
  ModelOption,
  PendingInboxItem,
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
  /** Live task milestones (never emitted for replayed history). */
  onTaskNotice?(notice: TaskNotice): void;
}

/** What the sidebar shows for the Current / Last Task. */
export interface TaskView {
  id: string;
  label: "current" | "last";
  summary: string;
  status: TaskStatus | "waiting" | null;
  steer: string | null;
  next: { summary: string; more: number } | null;
  chars: number;
  lines: number;
}

export interface ControllerDefaults {
  model: string;
  agent: string;
  /** Budget level used when the workspace has no remembered choice. */
  budgetLevel?: BudgetLevel;
  budget?: BudgetSettings;
  /** Warn when the context window is this full (0–100; 0 disables). */
  contextWarnPercent?: number;
  /** Localized UI strings for controller-generated messages. */
  strings?: Partial<ControllerStrings>;
}

export interface ControllerStrings {
  budgetWarning: string;
  budgetStopped: string;
  contextWarning: (percent: number) => string;
}

const EN_STRINGS: ControllerStrings = {
  budgetWarning: "Task budget is nearly exhausted.",
  budgetStopped: "Task budget reached. The agent was stopped.",
  contextWarning: (p) => `The context window is ${p}% full. Consider starting a new session.`,
};

/** Agent-attributed changes from OpenCode's session snapshots. */
export type AgentChanges =
  { status: "none" } | { status: "ok"; files: FileChange[] } | { status: "unavailable"; reason: string };

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
  /** Account / provider connection evidence; null = not checked yet or could not be checked. */
  account: AccountStatus | null = null;
  /** True while the model/agent catalog for the current folder is loading. */
  catalogLoading = false;
  /** The catalog for the current folder has been published at least once. */
  catalogLoaded = false;
  selectedModel: string | null = null;
  selectedAgent: string | null = null;
  /** Selected variant for the selected model; null = model default. */
  selectedVariant: string | null = null;
  sessions: SessionSummary[] = [];
  current: SessionSummary | null = null;
  busy = false;
  stopping = false;
  /** Agent changes for the whole session (snapshot attribution). */
  agentChanges: AgentChanges = { status: "none" };
  /** Steering/queued messages OpenCode has accepted but not yet delivered. */
  pending: PendingInboxItem[] = [];
  /** Completed agent steps in this session. */
  steps = 0;
  readonly budget: BudgetTracker;
  private patches = new Map<string, { patch: string; status: FileChange["status"] }>();
  private lastStep: { tokens: TokenUsage; modelKey: string | null } | null = null;
  private sessionCost: number | null = null;
  private contextWarned = false;
  private lastPayload: PromptPayload | null = null;
  private deliveredEarly = new Set<string>();
  private titleCache = new Map<string, string | null>();
  private firstUserText: string | null = null;
  private readonly normalizer = new EventNormalizer();
  private sessionsTimer: ReturnType<typeof setTimeout> | undefined;
  private changesTimer: ReturnType<typeof setTimeout> | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private loadToken = 0;
  private errorSeq = 0;
  private budgetSeq = 0;
  private disposed = false;
  /** Current / last task (see src/core/currentTask.ts). */
  task: TaskRecord | null = null;
  /** True between session.execution.started and its idle marker (from OpenCode events). */
  private execActive = false;
  private execSeq = 0;
  private taskStopReason: "budget" | null = null;
  /** Whether a pending inbox item will start a new task when delivered. */
  private pendingStartsTask = new Map<string, boolean>();
  private notified = new Set<string>();
  /** Folder whose catalog is currently being loaded (guards against duplicate reloads). */
  private loadingDirectory: string | null = null;
  private catalogGeneration = 0;
  /** Bumped by every user selection, so a catalog load that raced with it keeps the choice. */
  private selectionVersion = 0;
  private catalogTimer: ReturnType<typeof setTimeout> | undefined;
  private catalogRefresh: Promise<void> | null = null;
  private catalogRefreshAgain = false;
  /** Controller-generated events (budget/context) raised while applying a batch; flushed after it. */
  private deferred: UiEvent[] = [];

  constructor(
    private readonly client: OpenCodeClient,
    private readonly store: KeyValueStore,
    private readonly sink: ControllerSink,
    private readonly log: ControllerLog,
    private readonly defaults: () => ControllerDefaults,
    private readonly timing: {
      debounceMs: number;
      stopCheckMs: number;
      modelRetryMs: number;
      catalogDebounceMs?: number;
    } = { debounceMs: 400, stopCheckMs: 15_000, modelRetryMs: 1500 },
  ) {
    this.budget = new BudgetTracker(() => {
      const d = this.defaults();
      return (
        d.budget ?? {
          presets: {
            small: { maxCost: 0.1, maxSteps: 20 },
            medium: { maxCost: 0.3, maxSteps: 50 },
            large: { maxCost: 1, maxSteps: 120 },
            custom: { maxCost: 0.5, maxSteps: 80 },
          },
          warnAt: 0.8,
        }
      );
    });
    this.budget.level = this.defaults().budgetLevel ?? "off";
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.sessionsTimer);
    clearTimeout(this.changesTimer);
    clearTimeout(this.stopTimer);
    clearTimeout(this.catalogTimer);
  }

  private strings(): ControllerStrings {
    return { ...EN_STRINGS, ...(this.defaults().strings ?? {}) };
  }

  usage(contextLimitFallback = true): UsageInfo | null {
    const step = this.lastStep;
    const tokens = step ? contextTokens(step.tokens) : null;
    const modelKey = step?.modelKey ?? (contextLimitFallback ? this.selectedModel : null);
    const limit = this.models?.find((m) => m.key === modelKey)?.contextLimit ?? null;
    if (tokens === null && this.sessionCost === null) return null;
    return { contextTokens: tokens, contextLimit: tokens === null ? null : limit, cost: this.sessionCost };
  }

  budgetView(): BudgetView {
    return this.budget.view();
  }

  /** Title shown for the current session (OpenCode's when usable, else a local fallback). */
  currentTitle(): string | null {
    if (!this.current) return null;
    return displayTitle(this.current.title, this.firstUserText ?? this.firstTranscriptUserText());
  }

  private firstTranscriptUserText(): string | null {
    const u = this.transcript.items.find((i) => i.kind === "user");
    return u?.kind === "user" ? u.text : null;
  }

  /** Session list with cleaned-up titles. Bad titles get a fallback fetched lazily. */
  displaySessions(): SessionSummary[] {
    return this.sessions.map((s) => {
      if (isUsableTitle(s.title)) return s;
      if (s.id === this.current?.id) return { ...s, title: this.currentTitle() ?? "Untitled session" };
      if (!this.titleCache.has(s.id)) {
        this.titleCache.set(s.id, null);
        this.client
          .firstUserText(s.id)
          .then((t) => {
            this.titleCache.set(s.id, t);
            this.sink.onStateChanged();
          })
          .catch(() => undefined);
      }
      return { ...s, title: displayTitle(s.title, this.titleCache.get(s.id)) };
    });
  }

  // ---------------------------------------------------------------- catalog

  /** Switches to a workspace directory: loads models, agents and sessions for it. */
  async setDirectory(directory: string | null): Promise<void> {
    // Same folder: nothing to do if its catalog is loaded or still loading.
    if (this.directory === directory && (this.models !== null || this.loadingDirectory === directory)) return;
    this.directory = directory;
    this.loadingDirectory = directory;
    this.clearSession();
    this.sessions = [];
    this.models = null;
    this.agents = null;
    this.account = null;
    this.catalogLoaded = false;
    const remembered = this.store.get<BudgetLevel>(this.key("budget"));
    this.budget.setLevel(remembered ?? this.defaults().budgetLevel ?? "off");
    this.sink.onStateChanged();
    if (!directory) {
      this.loadingDirectory = null;
      return;
    }
    try {
      await Promise.all([this.loadCatalog(), this.refreshSessions()]);
    } finally {
      if (this.loadingDirectory === directory) this.loadingDirectory = null;
    }
    const rememberedSession = this.store.get<string>(this.key("session"));
    if (rememberedSession && this.sessions.some((s) => s.id === rememberedSession))
      await this.openSession(rememberedSession);
  }

  private key(kind: "model" | "agent" | "session" | "budget"): string {
    return `opencodeSidebar.${kind}:${this.directory ?? ""}`;
  }

  private variantKey(modelKey: string): string {
    return `opencodeSidebar.variant:${this.directory ?? ""}:${modelKey}`;
  }

  /**
   * Loads models, agents and account status for the current folder. With `keepSelection`
   * (a refresh), the current model, variant and agent stay selected while they still exist.
   */
  async loadCatalog(options: { keepSelection?: boolean } = {}): Promise<void> {
    const dir = this.directory;
    if (!dir) return;
    const generation = ++this.catalogGeneration;
    const selection = this.selectionVersion;
    this.catalogLoading = true;
    this.sink.onStateChanged();
    try {
      const accountP = this.client.accountStatus(dir).catch((e: unknown) => {
        this.log.error("Checking OpenCode connections failed", e);
        return null;
      });
      let models: ModelOption[] | null;
      try {
        models = await this.client.listModels(dir);
        // A location that OpenCode has not loaded yet briefly reports no models. Refreshes
        // (after the first load) report what OpenCode lists right away.
        const retries = options.keepSelection ? 0 : 2;
        for (let i = 0; i < retries && models.length === 0; i++) {
          await delay(this.timing.modelRetryMs);
          models = await this.client.listModels(dir);
        }
      } catch (e) {
        this.log.error("Loading models failed", e);
        models = null;
      }
      let agents: AgentOption[] | null;
      try {
        agents = await this.client.listAgents(dir);
      } catch (e) {
        this.log.error("Loading agents failed", e);
        agents = null;
      }
      const account = await accountP;
      const picked = await this.pickDefaults(dir, models ?? [], agents ?? []);
      if (dir !== this.directory || generation !== this.catalogGeneration || this.disposed) return;
      // Publish the catalog and the defaults together, so a selection made by the user can
      // never be overwritten by defaults that were still being resolved.
      const keep = options.keepSelection || selection !== this.selectionVersion;
      const prevModel = keep && models?.some((m) => m.key === this.selectedModel) ? this.selectedModel : null;
      const prevAgent = keep && agents?.some((a) => a.id === this.selectedAgent) ? this.selectedAgent : null;
      const prevVariant = this.selectedVariant;
      this.models = models;
      this.agents = agents;
      this.account = account;
      this.catalogLoaded = true;
      this.selectedModel = prevModel ?? picked.model;
      const variants = models?.find((m) => m.key === this.selectedModel)?.variants ?? [];
      this.selectedVariant =
        prevModel && (prevVariant === null || variants.includes(prevVariant))
          ? prevVariant
          : this.rememberedVariant(this.selectedModel);
      this.selectedAgent = prevAgent ?? picked.agent;
    } finally {
      if (generation === this.catalogGeneration) this.catalogLoading = false;
      this.sink.onStateChanged();
    }
  }

  /** Re-checks models, agents and account status without touching the open session. */
  async refreshCatalog(): Promise<void> {
    clearTimeout(this.catalogTimer);
    if (!this.directory) return;
    // Refreshes requested while one is running are coalesced into one more run, so frequent
    // triggers (events, the sign-in poll) can never keep superseding each other.
    if (this.catalogRefresh) {
      this.catalogRefreshAgain = true;
      return this.catalogRefresh;
    }
    this.catalogRefresh = (async () => {
      try {
        do {
          this.catalogRefreshAgain = false;
          await this.loadCatalog({ keepSelection: true });
        } while (this.catalogRefreshAgain && !this.disposed);
      } finally {
        this.catalogRefresh = null;
      }
    })();
    return this.catalogRefresh;
  }

  /** OpenCode reports provider / model / integration changes, e.g. after `opencode auth login`. */
  private scheduleCatalogRefresh(): void {
    clearTimeout(this.catalogTimer);
    this.catalogTimer = setTimeout(() => void this.refreshCatalog(), this.timing.catalogDebounceMs ?? 1000);
  }

  private async pickDefaults(
    dir: string,
    models: ModelOption[],
    agents: AgentOption[],
  ): Promise<{ model: string | null; agent: string | null }> {
    const d = this.defaults();
    const has = (k: string | null | undefined): k is string => !!k && models.some((m) => m.key === k);
    let model: string | null = this.store.get<string>(this.key("model")) ?? null;
    if (!has(model)) model = has(d.model) ? d.model : null;
    if (!model) {
      try {
        const def = await this.client.defaultModel(dir);
        if (has(def)) model = def;
      } catch {
        // fall through
      }
    }
    if (!model && models.length) model = models[0].key;

    const hasAgent = (a: string | null | undefined): a is string => !!a && agents.some((x) => x.id === a);
    let agent: string | null = this.store.get<string>(this.key("agent")) ?? null;
    if (!hasAgent(agent))
      agent = hasAgent(d.agent) ? d.agent : hasAgent("build") ? "build" : (agents[0]?.id ?? null);
    return { model, agent };
  }

  /** Last valid variant remembered for this workspace + model, or null (model default). */
  private rememberedVariant(modelKey: string | null): string | null {
    if (!modelKey) return null;
    const model = this.models?.find((m) => m.key === modelKey);
    const v = this.store.get<string>(this.variantKey(modelKey));
    return v && model?.variants.includes(v) ? v : null;
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
    this.agentChanges = { status: "none" };
    this.patches.clear();
    this.pending = [];
    this.steps = 0;
    this.lastStep = null;
    this.sessionCost = null;
    this.contextWarned = false;
    this.lastPayload = null;
    this.firstUserText = null;
    this.deliveredEarly.clear();
    this.task = null;
    this.execActive = false;
    this.taskStopReason = null;
    this.pendingStartsTask.clear();
    this.budget.reset();
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

  /** Continues an existing OpenCode session: replays history, pending permissions, forms and queue. */
  async openSession(id: string): Promise<boolean> {
    const token = ++this.loadToken;
    try {
      const [summary, messages, permissions, forms, inbox, active] = await Promise.all([
        this.client.getSession(id),
        this.client.listMessages(id, HISTORY_LIMIT),
        this.client.listPermissions(id).catch(() => []),
        this.client.listForms(id).catch(() => []),
        this.client.listInbox(id).catch(() => []),
        this.client.activeSessions().catch(() => new Set<string>()),
      ]);
      if (token !== this.loadToken) return false;
      this.clearSession();
      this.current = summary;
      this.sessionCost = summary.cost;
      this.busy = active.has(id);
      for (const ev of historyToEvents(messages)) this.applyLocal(ev, true);
      // Pending requests are restored silently: reopening never replays notifications.
      for (const request of permissions) {
        this.applyLocal(
          { type: "permission.requested", request, sensitive: describeSensitive(request.resources) },
          true,
        );
      }
      for (const form of forms) this.applyLocal({ type: "form.requested", form }, true);
      this.pending = inbox;
      this.execActive = this.busy;
      this.task = deriveTaskFromHistory(messages, this.busy);
      for (const item of inbox) this.pendingStartsTask.set(item.id, item.delivery === "queue");
      if (this.busy) this.budget.startTask(this.sessionCost);
      if (summary.modelKey && this.models?.some((m) => m.key === summary.modelKey)) {
        this.selectedModel = summary.modelKey;
        const model = this.models.find((m) => m.key === summary.modelKey);
        this.selectedVariant =
          summary.variant && model?.variants.includes(summary.variant) ? summary.variant : null;
      }
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

  private modelRef(): { providerID: string; id: string; variant?: string } | undefined {
    const model = this.models?.find((m) => m.key === this.selectedModel);
    if (!model) return undefined;
    return {
      providerID: model.providerID,
      id: model.id,
      ...(this.selectedVariant ? { variant: this.selectedVariant } : {}),
    };
  }

  async selectModel(key: string): Promise<void> {
    const model = this.models?.find((m) => m.key === key);
    if (!model) return;
    this.selectionVersion++;
    this.selectedModel = key;
    // Restore this model's last valid variant for the workspace.
    this.selectedVariant = this.rememberedVariant(key);
    if (this.directory) await this.store.update(this.key("model"), key);
    this.sink.onStateChanged();
    await this.pushModel("Model unavailable");
  }

  /** Selects a model variant (null = model default). Only variants OpenCode lists are accepted. */
  async selectVariant(variant: string | null): Promise<void> {
    const model = this.models?.find((m) => m.key === this.selectedModel);
    if (!model) return;
    if (variant !== null && !model.variants.includes(variant)) return;
    this.selectionVersion++;
    this.selectedVariant = variant;
    if (this.directory) await this.store.update(this.variantKey(model.key), variant ?? undefined);
    this.sink.onStateChanged();
    await this.pushModel("Could not switch the model variant");
  }

  private async pushModel(failure: string): Promise<void> {
    const ref = this.modelRef();
    if (!this.current || !ref) return;
    try {
      await this.client.switchModel(this.current.id, ref);
    } catch (e) {
      this.log.error("Switching model failed", e);
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, failure) }]);
    }
  }

  async selectAgent(id: string): Promise<void> {
    if (!this.agents?.some((a) => a.id === id)) return;
    this.selectionVersion++;
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

  async selectBudget(level: BudgetLevel): Promise<void> {
    this.budget.setLevel(level);
    if (this.directory) await this.store.update(this.key("budget"), level);
    this.sink.onStateChanged();
    this.checkBudget(this.budget.evaluate());
    this.flushDeferred();
  }

  private flushDeferred(): void {
    const d = this.deferred.splice(0);
    if (d.length) this.emit(d);
  }

  // ---------------------------------------------------------------- prompts

  /**
   * Sends a prompt. While the agent is running, `delivery` decides how OpenCode
   * handles it: "steer" (injected at the next step) or "queue" (after the task).
   * Returns false when nothing was sent (caller may restore the input).
   */
  async send(
    text: string,
    attachments: readonly ContextAttachment[],
    delivery?: InboxDelivery,
  ): Promise<boolean> {
    if (!this.directory) {
      this.emit([{ type: "notice", level: "error", text: "Open a folder to start an OpenCode session." }]);
      return false;
    }
    if (this.busy && (!delivery || !this.current)) return false;
    const payload = buildPrompt(text, attachments);
    if (!payload.text) {
      if (payload.files.length) {
        this.emit([
          { type: "notice", level: "info", text: "Type a message to send with the attached files." },
        ]);
      }
      return false;
    }
    return this.dispatch(payload, this.busy ? delivery : undefined);
  }

  private async dispatch(payload: PromptPayload, delivery?: InboxDelivery): Promise<boolean> {
    const wasBusy = this.busy;
    if (!wasBusy) {
      this.busy = true;
      this.sink.onStateChanged();
    }
    try {
      if (!this.current) {
        const created = await this.client.createSession({
          directory: this.directory!,
          agent: this.selectedAgent ?? undefined,
          model: this.modelRef(),
        });
        this.current = created;
        this.sessionCost = created.cost ?? 0;
        this.loadToken++;
        await this.store.update(this.key("session"), created.id);
        this.log.info(`Created session ${created.id}`);
        this.scheduleSessionsRefresh();
      }
      const res = await this.client.prompt(this.current.id, {
        ...payload,
        ...(delivery ? { delivery } : {}),
      });
      this.lastPayload = payload;
      this.log.info(
        `Prompt sent to ${this.current.id} (${payload.text.length} chars, ${payload.files.length} file attachment(s)${delivery ? `, ${delivery}` : ""})`,
      );
      // The server echoes the message as session.inbox.enqueued/delivered; this covers missed events.
      if (res.id && !this.transcript.has(`user:${res.id}`) && !this.pending.some((p) => p.id === res.id)) {
        const [ev] = historyToEvents([
          { type: "user", id: res.id, text: payload.text, files: payload.files },
        ]);
        if (ev?.type === "user.message") {
          if (this.deliveredEarly.has(res.id) || !wasBusy) {
            this.deliveredEarly.delete(res.id);
            this.trackUserMessage(res.id, payload.text, !wasBusy || delivery === "queue");
            this.emit([{ ...ev, raw: payload.text }]);
          } else
            this.emit([
              {
                type: "inbox.enqueued",
                id: ev.id,
                text: ev.text,
                attachments: ev.attachments,
                delivery: delivery ?? "steer",
              },
            ]);
        }
      }
      return true;
    } catch (e) {
      if (!wasBusy) this.busy = false;
      this.log.error("Sending prompt failed", e);
      this.emit([{ type: "notice", level: "error", text: friendlyError(e, "Session failed") }]);
      this.sink.onStateChanged();
      return false;
    }
  }

  /** Re-sends the last prompt after a failure (explicit user action). */
  async retry(): Promise<boolean> {
    if (this.busy || !this.lastPayload || !this.directory) return false;
    return this.dispatch(this.lastPayload);
  }

  /** Removes a pending steering/queued message before OpenCode delivers it. Returns its text. */
  async cancelPending(id: string): Promise<string | null> {
    const item = this.pending.find((p) => p.id === id);
    if (!this.current || !item) return null;
    try {
      await this.client.cancelInbox(this.current.id, id);
      this.applyInbox({ type: "inbox.cancelled", id });
      this.sink.onStateChanged();
      return item.text;
    } catch (e) {
      this.log.warn(`Cancelling queued message failed: ${e instanceof Error ? e.message : String(e)}`);
      this.emit([
        { type: "notice", level: "info", text: "That message was already delivered to the agent." },
      ]);
      return null;
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
        this.budget.endTask();
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
        this.budget.endTask();
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

  // ------------------------------------------------------------------ forms

  /** Validates and submits an answer to an OpenCode form/question. Returns an error message on failure. */
  async answerForm(formId: string, answer: FormAnswer): Promise<string | null> {
    const item = this.transcript.get(`form:${formId}`);
    if (!this.current || item?.kind !== "form" || item.status !== "pending")
      return "This question is no longer pending.";
    const checked = validateAnswer(item.form, answer);
    if (!checked.ok) return checked.error;
    this.emit([{ type: "form.sending", formId }]);
    try {
      await this.client.replyForm(item.form.sessionID, formId, checked.answer);
      this.log.info(`Form ${formId} answered (${Object.keys(checked.answer).length} field(s))`);
      this.emit([{ type: "form.resolved", formId, status: "answered", answer: checked.answer }]);
      return null;
    } catch (e) {
      if (e instanceof OpenCodeHttpError && e.status === 404) {
        this.emit([
          { type: "form.resolved", formId, status: "expired", answer: null },
          { type: "notice", level: "info", text: "This question expired before it was answered." },
        ]);
        return null;
      }
      this.log.error("Form reply failed", e);
      this.emit([{ type: "form.resolved", formId, status: "pending", answer: null }]);
      return friendlyError(e, "Could not send the answer");
    }
  }

  async cancelForm(formId: string): Promise<void> {
    const item = this.transcript.get(`form:${formId}`);
    if (!this.current || item?.kind !== "form" || item.status !== "pending") return;
    this.emit([{ type: "form.sending", formId }]);
    try {
      await this.client.cancelForm(item.form.sessionID, formId);
      this.emit([{ type: "form.resolved", formId, status: "cancelled", answer: null }]);
    } catch (e) {
      const expired = e instanceof OpenCodeHttpError && e.status === 404;
      if (!expired) this.log.error("Form cancel failed", e);
      this.emit([{ type: "form.resolved", formId, status: expired ? "expired" : "pending", answer: null }]);
    }
  }

  // ----------------------------------------------------------------- budget

  /** "Continue once": one explicit override for the current task; the workspace budget is unchanged. */
  async budgetContinueOnce(budgetItemId: string): Promise<boolean> {
    if (this.busy || !this.current) return false;
    this.budget.continueOnce();
    this.emit([{ type: "budget.resolved", id: budgetItemId, resolution: "continued" }]);
    this.log.info("Budget: continue once (one-time override)");
    return this.dispatch({ text: CONTINUE_TEXT, files: [] });
  }

  /** Raises the workspace budget one level and continues the task. */
  async budgetIncrease(budgetItemId: string): Promise<boolean> {
    if (this.busy || !this.current) return false;
    const level = nextLevel(this.budget.level);
    if (level === this.budget.level) {
      // Already at the largest preset: behaves like one override.
      return this.budgetContinueOnce(budgetItemId);
    }
    this.budget.increaseTo(level);
    if (this.directory) await this.store.update(this.key("budget"), level);
    this.emit([{ type: "budget.resolved", id: budgetItemId, resolution: "increased" }]);
    this.log.info(`Budget increased to ${level}`);
    return this.dispatch({ text: CONTINUE_TEXT, files: [] });
  }

  async budgetNewSession(budgetItemId: string): Promise<void> {
    this.emit([{ type: "budget.resolved", id: budgetItemId, resolution: "new-session" }]);
    await this.newSession();
  }

  private checkBudget(signal: ReturnType<BudgetTracker["evaluate"]>): void {
    if (signal.kind === "warning") {
      this.deferred.push({
        type: "budget",
        id: `budget:${++this.budgetSeq}`,
        state: "warning",
        text: this.strings().budgetWarning,
      });
    } else if (signal.kind === "exceeded") {
      const v = this.budget.view();
      this.log.warn(
        `Budget ${v.level} reached (${signal.metric}): cost=${v.taskCost ?? "n/a"} steps=${v.taskSteps}; interrupting`,
      );
      this.deferred.push({
        type: "budget",
        id: `budget:${++this.budgetSeq}`,
        state: "stopped",
        text: this.strings().budgetStopped,
      });
      this.taskStopReason = "budget";
      this.notify("budget-stopped", `budget:${this.current?.id}:${this.budgetSeq}`);
      if (this.busy && !this.stopping) void this.stop();
    }
  }

  // ----------------------------------------------------------------- events

  /** Entry point for every raw event from the OpenCode event stream. */
  handleRawEvent(raw: unknown): void {
    if (this.disposed) return;
    if (isCatalogEvent(raw)) this.scheduleCatalogRefresh();
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

  /** Inbox bookkeeping; returns the events to forward to the transcript. */
  private applyInbox(ev: Extract<UiEvent, { type: `inbox.${string}` }>): UiEvent[] {
    switch (ev.type) {
      case "inbox.enqueued":
        if (this.transcript.has(`user:${ev.id}`)) return [];
        if (this.deliveredEarly.delete(ev.id)) {
          this.trackUserMessage(
            ev.id,
            ev.raw ?? ev.text,
            ev.delivery === "queue" || !this.task || !this.execActive,
          );
          return [
            { type: "user.message", id: ev.id, text: ev.text, attachments: ev.attachments, raw: ev.raw },
          ];
        }
        if (!this.pending.some((p) => p.id === ev.id)) {
          // Queued items and prompts sent while idle start a task; steering joins the running one.
          this.pendingStartsTask.set(ev.id, ev.delivery === "queue" || !this.execActive);
          this.pending = [
            ...this.pending,
            { id: ev.id, text: ev.text, raw: ev.raw, attachments: ev.attachments, delivery: ev.delivery },
          ];
        }
        return [];
      case "inbox.delivered": {
        const item = this.pending.find((p) => p.id === ev.id);
        this.pending = this.pending.filter((p) => p.id !== ev.id);
        if (!item) {
          this.deliveredEarly.add(ev.id);
          return [];
        }
        const starts = this.pendingStartsTask.get(item.id) ?? (item.delivery === "queue" || !this.task);
        this.pendingStartsTask.delete(item.id);
        this.trackUserMessage(item.id, item.raw ?? item.text, starts);
        return [
          {
            type: "user.message",
            id: item.id,
            text: item.text,
            attachments: item.attachments,
            raw: item.raw,
          },
        ];
      }
      case "inbox.cancelled":
        this.pending = this.pending.filter((p) => p.id !== ev.id);
        this.pendingStartsTask.delete(ev.id);
        return [];
      case "inbox.delivery":
        this.pending = this.pending.map((p) => (p.id === ev.id ? { ...p, delivery: ev.delivery } : p));
        return [];
    }
  }

  private applyLocal(ev: UiEvent, replay = false): UiEvent[] {
    const out: UiEvent[] = [ev];
    switch (ev.type) {
      case "session.busy":
        this.busy = true;
        this.execActive = true;
        this.execSeq++;
        this.budget.startTask(this.sessionCost ?? 0);
        break;
      case "session.idle":
        this.busy = false;
        this.stopping = false;
        this.execActive = false;
        this.budget.endTask();
        clearTimeout(this.stopTimer);
        if (!replay) this.finishTask(ev.outcome);
        break;
      case "permission.requested":
        if (!replay) this.notify("needs-input", `input:${ev.request.id}`);
        break;
      case "form.requested":
        if (!replay) this.notify("needs-input", `input:${ev.form.id}`);
        break;
      case "session.renamed":
        if (this.current) this.current = { ...this.current, title: ev.title };
        break;
      case "user.message":
        if (this.firstUserText === null) this.firstUserText = ev.text;
        break;
      case "usage.step":
        this.lastStep = { tokens: ev.tokens, modelKey: ev.modelKey };
        this.steps++;
        if (!replay) {
          this.checkBudget(this.budget.recordStep());
          this.checkContext();
        }
        break;
      case "usage.session":
        this.sessionCost = ev.cost;
        if (!replay) this.checkBudget(this.budget.recordCost(ev.cost));
        break;
      case "session.error": {
        const model = this.models?.find((m) => m.key === ev.modelKey);
        const raw = ev.error ?? { type: "unknown", message: ev.message, status: null, body: null };
        const friendly = classifyError(raw, {
          modelName: model?.name ?? null,
          providerName: model?.providerName ?? null,
        });
        if (!replay) {
          this.log.error(
            `OpenCode run failed: ${describeForLog(raw, { providerID: model?.providerID ?? ev.modelKey?.split("/")[0] ?? null, modelKey: ev.modelKey })}`,
          );
        }
        const actions = friendly.actions.filter(
          (a) => a !== "retry" || (!replay && this.lastPayload !== null),
        );
        const replaced: UiEvent = {
          type: "error",
          id: `error:${++this.errorSeq}`,
          title: friendly.title,
          detail: friendly.detail,
          actions,
        };
        out[0] = replaced;
        break;
      }
      case "inbox.enqueued":
      case "inbox.delivered":
      case "inbox.cancelled":
      case "inbox.delivery": {
        const forwarded = this.applyInbox(ev);
        for (const f of forwarded)
          if (f.type === "user.message" && this.firstUserText === null) this.firstUserText = f.text;
        out.splice(0, 1, ...forwarded);
        break;
      }
      case "form.resolved":
        if (ev.status === "answered" && ev.answer) {
          const item = this.transcript.get(`form:${ev.formId}`);
          if (item?.kind === "form")
            this.log.info(`Form answered: ${summarizeAnswer(item.form, ev.answer).length} chars`);
        }
        break;
      default:
        break;
    }
    for (const e of out) this.transcript.apply(e);
    return out;
  }

  // ------------------------------------------------------------- current task

  /**
   * Records a delivered user message: a new task, a steer into the running
   * task, or a Budget Guard continuation of the same task.
   */
  private trackUserMessage(id: string, raw: string, startsTask: boolean): void {
    if (raw === CONTINUE_TEXT && this.task) {
      this.task = { ...this.task, status: "running" };
      this.taskStopReason = null;
      return;
    }
    if (startsTask || !this.task) {
      this.task = { id, raw, status: "running", steer: null };
      this.taskStopReason = null;
    } else {
      this.task = { ...this.task, steer: raw };
    }
  }

  private finishTask(outcome: "succeeded" | "failed" | "interrupted"): void {
    if (!this.task) return;
    const status: TaskStatus =
      outcome === "succeeded"
        ? "completed"
        : outcome === "failed"
          ? "failed"
          : this.taskStopReason === "budget"
            ? "budget-stopped"
            : "stopped";
    this.task = { ...this.task, status };
    if (outcome === "succeeded") this.notify("completed", `completed:${this.task.id}:${this.execSeq}`);
    else if (outcome === "failed") this.notify("failed", `failed:${this.task.id}:${this.execSeq}`);
    // A user Stop or a budget stop is never reported as completed.
  }

  private notify(kind: TaskNotice["kind"], key: string): void {
    if (this.notified.has(key) || !this.sink.onTaskNotice) return;
    this.notified.add(key);
    this.sink.onTaskNotice({
      kind,
      key,
      summary: this.task ? summarizeTask(this.task.raw) : "",
      sessionTitle: this.currentTitle(),
    });
  }

  /** View model for the Current / Last Task bar; null for an empty session. */
  taskView(): TaskView | null {
    const t = this.task;
    if (!t) return null;
    const waiting =
      this.busy &&
      this.transcript.items.some(
        (i) =>
          (i.kind === "permission" && i.status === "pending") ||
          (i.kind === "form" && i.status === "pending"),
      );
    const queued = this.pending.filter((p) => p.delivery === "queue");
    return {
      id: t.id,
      label: this.busy ? "current" : "last",
      summary: summarizeTask(t.raw) || "(empty prompt)",
      status: waiting ? "waiting" : this.busy ? "running" : t.status,
      steer: t.steer ? summarizeTask(t.steer) : null,
      next: queued.length
        ? { summary: summarizeTask(queued[0].raw ?? queued[0].text), more: queued.length - 1 }
        : null,
      chars: t.raw.length,
      lines: t.raw.split("\n").length,
    };
  }

  /** Exact original prompt of the current/last task (for Copy Prompt / expanded view). */
  taskPrompt(): { id: string; text: string } | null {
    return this.task ? { id: this.task.id, text: this.task.raw } : null;
  }

  private checkContext(): void {
    const pct = this.defaults().contextWarnPercent ?? 80;
    const u = this.usage();
    if (!pct || this.contextWarned || !u?.contextTokens || !u.contextLimit) return;
    const used = Math.round((u.contextTokens / u.contextLimit) * 100);
    if (used >= pct) {
      this.contextWarned = true;
      this.deferred.push({ type: "notice", level: "info", text: this.strings().contextWarning(used) });
    }
  }

  private emit(events: UiEvent[]): void {
    let stateChanged = false;
    let changesDirty = false;
    const forwarded: UiEvent[] = [];
    for (const ev of events) {
      if (/^(session\.|usage\.|inbox\.|budget)/.test(ev.type)) stateChanged = true;
      if (ev.type === "files.changed" || ev.type === "session.idle") changesDirty = true;
      forwarded.push(...this.applyLocal(ev));
    }
    if (forwarded.length) this.sink.onEvents(forwarded);
    if (stateChanged) this.sink.onStateChanged();
    if (changesDirty) this.scheduleChangesRefresh();
    this.flushDeferred();
  }

  /** Canonical Markdown of an assistant message (for Copy), or null when not copyable yet. */
  copyText(itemId: string): string | null {
    const item = this.transcript.get(itemId);
    if (item?.kind !== "assistant") return null;
    if (item.streaming && this.busy) return null;
    return item.text;
  }

  // ---------------------------------------------------------------- changes

  private scheduleChangesRefresh(): void {
    clearTimeout(this.changesTimer);
    this.changesTimer = setTimeout(() => void this.refreshChanges(), this.timing.debounceMs);
  }

  /** User message ids of the loaded session, oldest first. */
  private userMessageIds(): string[] {
    return this.transcript.items.filter((i) => i.kind === "user").map((i) => i.id.slice("user:".length));
  }

  /** Files the agent reported editing (edit-tool metadata) in this session. */
  private reportedEdits(): Set<string> {
    const out = new Set<string>();
    for (const i of this.transcript.items) {
      if (i.kind === "tool") for (const f of i.detail.files) out.add(f.path);
      if (i.kind === "turn-summary") for (const f of i.files) out.add(f.path);
    }
    return out;
  }

  /**
   * Loads the agent's changes for the whole session from OpenCode's snapshots
   * (first user turn → last user turn, full-file patches). If the attribution is
   * not reliable, reports "unavailable" instead of guessing.
   */
  async refreshChanges(): Promise<void> {
    const id = this.current?.id;
    if (!id) return;
    const users = this.userMessageIds();
    const range = users.length
      ? { from: users[0], to: users.length > 1 ? users[users.length - 1] : undefined, full: true }
      : { full: true };
    try {
      const diff = await this.client.sessionDiff(id, range);
      if (this.current?.id !== id) return;
      this.patches.clear();
      for (const d of diff) this.patches.set(d.file, { patch: d.patch, status: d.status });
      const files = diff.map((d) => ({
        path: d.file,
        additions: d.additions,
        deletions: d.deletions,
        status: d.status,
      }));
      const reported = this.reportedEdits();
      if (files.length === 0 && reported.size > 0) {
        this.agentChanges = {
          status: "unavailable",
          reason: "OpenCode did not record snapshots for the agent's edits.",
        };
      } else {
        this.agentChanges = files.length ? { status: "ok", files } : { status: "none" };
      }
      this.sink.onStateChanged();
    } catch (e) {
      this.log.warn(`Session diff unavailable: ${e instanceof Error ? e.message : String(e)}`);
      if (this.current?.id !== id) return;
      this.agentChanges = {
        status: "unavailable",
        reason: "OpenCode could not provide the session's snapshot diff.",
      };
      this.sink.onStateChanged();
    }
  }

  /** Before/after contents of one agent-changed file, or null when they cannot be reconstructed reliably. */
  agentFileSides(path: string): FileSides | null {
    const p = this.patches.get(path);
    if (!p) return null;
    return reconstructSides(p.patch, p.status);
  }

  /** Back-compat for v0.1 callers: agent-attributed files (empty when unavailable). */
  get changes(): FileChange[] {
    return this.agentChanges.status === "ok" ? this.agentChanges.files : [];
  }
}

/** Events after which models, providers or connections may have changed (e.g. a sign-in). */
const CATALOG_EVENTS = new Set([
  "integration.updated",
  "provider.updated",
  "model.updated",
  "models-dev.refreshed",
]);

export function isCatalogEvent(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const type = (raw as { type?: unknown }).type;
  return typeof type === "string" && CATALOG_EVENTS.has(type);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
