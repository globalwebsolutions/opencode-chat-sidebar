// OpenCode integration adapter. The UI talks only to the `OpenCodeClient`
// interface; `HttpOpenCodeClient` implements it on top of the OpenCode v2 HTTP
// API (the same surface used by the official `opencode` CLI and clients).

import { parseForm } from "../core/forms";
import type {
  AccountStatus,
  AgentOption,
  FormAnswer,
  FormRequest,
  InboxDelivery,
  ModelOption,
  PendingInboxItem,
  PermissionDecision,
  PermissionRequest,
  SessionSummary,
} from "../shared/model";
import { modelKey, toPermissionRequest } from "./events";
import { SseParser } from "./sse";

export interface Endpoint {
  url: string;
  /** Value of the Authorization header, if the server requires one. Never logged. */
  authorization?: string;
}

export interface ServerInfo {
  version: string;
  pid: number | null;
}

export interface ModelRef {
  providerID: string;
  id: string;
  /** Model variant (e.g. reasoning effort); omitted = model default. */
  variant?: string;
}

export interface FileDiffInfo {
  file: string;
  /** Unified patch; full-file when requested with `full: true`. */
  patch: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
}

export interface EventSubscription {
  dispose(): void;
}

export interface EventHandlers {
  onEvent(raw: unknown): void;
  onOpen(): void;
  onClose(error: string | null): void;
}

export interface OpenCodeClient {
  readonly url: string;
  info(): Promise<ServerInfo>;
  listModels(directory: string): Promise<ModelOption[]>;
  defaultModel(directory: string): Promise<string | null>;
  listAgents(directory: string): Promise<AgentOption[]>;
  /** Connection states from OpenCode's integration list; never labels or credentials. */
  accountStatus(directory: string): Promise<AccountStatus>;
  listSessions(directory: string, limit: number): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionSummary>;
  createSession(input: { directory: string; agent?: string; model?: ModelRef }): Promise<SessionSummary>;
  listMessages(id: string, max: number): Promise<unknown[]>;
  prompt(
    id: string,
    input: { text: string; files: Array<{ uri: string; name: string }>; delivery?: InboxDelivery },
  ): Promise<{ id: string }>;
  switchModel(id: string, model: ModelRef): Promise<void>;
  switchAgent(id: string, agent: string): Promise<void>;
  /** Ids of sessions that are currently executing. */
  activeSessions(): Promise<Set<string>>;
  /** Cancels the running execution. Resolves to whether anything was interrupted. */
  interrupt(id: string): Promise<boolean>;
  listPermissions(id: string): Promise<PermissionRequest[]>;
  replyPermission(id: string, requestId: string, decision: PermissionDecision): Promise<void>;
  /**
   * Agent changes recorded by OpenCode snapshots. With `from`/`to` (user message ids) the
   * range spans several turns; `full` requests full-file patches.
   */
  sessionDiff(id: string, range?: { from?: string; to?: string; full?: boolean }): Promise<FileDiffInfo[]>;
  listForms(id: string): Promise<FormRequest[]>;
  replyForm(id: string, formId: string, answer: FormAnswer): Promise<void>;
  cancelForm(id: string, formId: string): Promise<void>;
  listInbox(id: string): Promise<PendingInboxItem[]>;
  cancelInbox(id: string, inboxId: string): Promise<void>;
  /** Text of the first user message, used for local title fallbacks. */
  firstUserText(id: string): Promise<string | null>;
  subscribe(handlers: EventHandlers): EventSubscription;
}

function modelBody(model: ModelRef): Rec {
  const body: Rec = { providerID: model.providerID, id: model.id };
  if (model.variant) body.variant = model.variant;
  return body;
}

export class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly tag: string | null,
    message: string,
  ) {
    super(message);
    this.name = "OpenCodeHttpError";
  }
}

type FetchLike = typeof fetch;
type Rec = Record<string, unknown>;

const REQUEST_TIMEOUT_MS = 15_000;

const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function toSessionSummary(raw: unknown): SessionSummary {
  const d = rec(raw);
  const time = rec(d.time);
  const outcome = d.outcome;
  return {
    id: str(d.id) ?? "",
    title: str(d.title) ?? "Untitled session",
    created: typeof time.created === "number" ? time.created : 0,
    updated: typeof time.updated === "number" ? time.updated : 0,
    agent: str(d.agent),
    modelKey: modelKey(d.model),
    variant: str(rec(d.model).variant),
    outcome: outcome === "succeeded" || outcome === "failed" || outcome === "interrupted" ? outcome : null,
    cost: typeof d.cost === "number" ? d.cost : null,
  };
}

/** OpenCode's integration id for the OpenCode Console account (`opencode auth login opencode`). */
export const OPENCODE_INTEGRATION = "opencode";

/**
 * Reduces `GET /api/integration` to connection states. Only `id`, `connections[].type` and
 * `connections[].status.status` are read; labels, metadata and methods are ignored.
 */
export function parseAccountStatus(list: unknown): AccountStatus {
  let opencode: AccountStatus["opencode"] = "none";
  let otherProviders = false;
  if (!Array.isArray(list)) throw new Error("Unexpected integration list");
  for (const raw of list) {
    const i = rec(raw);
    const connections = Array.isArray(i.connections) ? i.connections : [];
    const states = connections
      .map((c) => rec(c))
      .filter((c) => c.type === "credential" || c.type === "env")
      .map((c) => (rec(c.status).status === "needs_auth" ? "needs-auth" : "ok"));
    if (states.length === 0) continue;
    if (i.id === OPENCODE_INTEGRATION) opencode = states.includes("ok") ? "connected" : "needs-auth";
    else if (states.includes("ok")) otherProviders = true;
  }
  return { opencode, otherProviders };
}

/** Projects a model record onto the fields the UI needs (drops headers/body/settings, which may hold secrets). */
export function toModelOption(raw: unknown, providerNames: Map<string, string>): ModelOption | null {
  const d = rec(raw);
  const providerID = str(d.providerID);
  const id = str(d.id);
  if (!providerID || !id || d.enabled === false) return null;
  const limit = rec(d.limit);
  return {
    key: `${providerID}/${id}`,
    providerID,
    id,
    name: str(d.name) ?? id,
    variants: Array.isArray(d.variants)
      ? d.variants.map((v) => str(rec(v).id)).filter((v): v is string => !!v && v !== "default")
      : [],
    providerName: providerNames.get(providerID) ?? providerID,
    contextLimit: typeof limit.context === "number" && limit.context > 0 ? limit.context : null,
  };
}

export class HttpOpenCodeClient implements OpenCodeClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly endpoint: Endpoint,
    fetchImpl?: FetchLike,
    private readonly reconnectDelays: number[] = [500, 1000, 2000, 5000, 10000],
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  get url(): string {
    return this.endpoint.url;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json" };
    if (json) h["content-type"] = "application/json";
    if (this.endpoint.authorization) h.authorization = this.endpoint.authorization;
    return h;
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const u = new URL(path, this.endpoint.url);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  }

  private async request(
    method: string,
    path: string,
    options: { query?: Record<string, string | undefined>; body?: unknown; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const res = await this.fetchImpl(this.buildUrl(path, options.query), {
      method,
      headers: this.headers(options.body !== undefined),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    if (res.status === 204) return undefined;
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const body = rec(json);
      throw new OpenCodeHttpError(
        res.status,
        str(body._tag),
        str(body.message) ?? `OpenCode request failed (${method} ${path}: HTTP ${res.status})`,
      );
    }
    return json;
  }

  private loc(directory: string): Record<string, string> {
    return { "location[directory]": directory };
  }

  async info(): Promise<ServerInfo> {
    const d = rec(await this.request("GET", "/api/info", { timeoutMs: 5000 }));
    return { version: str(d.version) ?? "unknown", pid: typeof d.pid === "number" ? d.pid : null };
  }

  async listModels(directory: string): Promise<ModelOption[]> {
    const [models, providers] = await Promise.all([
      this.request("GET", "/api/model", { query: this.loc(directory) }),
      this.request("GET", "/api/provider", { query: this.loc(directory) }).catch(() => undefined),
    ]);
    const names = new Map<string, string>();
    const plist = rec(providers).data;
    if (Array.isArray(plist)) {
      for (const p of plist) {
        const id = str(rec(p).id);
        const name = str(rec(p).name);
        if (id && name) names.set(id, name);
      }
    }
    const list = rec(models).data;
    if (!Array.isArray(list)) return [];
    const out: ModelOption[] = [];
    for (const m of list) {
      const opt = toModelOption(m, names);
      if (opt) out.push(opt);
    }
    out.sort((a, b) => a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name));
    return out;
  }

  async defaultModel(directory: string): Promise<string | null> {
    const d = rec(await this.request("GET", "/api/model/default", { query: this.loc(directory) }));
    return modelKey(d.data);
  }

  async listAgents(directory: string): Promise<AgentOption[]> {
    const d = rec(await this.request("GET", "/api/agent", { query: this.loc(directory) }));
    const list = Array.isArray(d.data) ? d.data : [];
    const out: AgentOption[] = [];
    for (const a of list) {
      const r = rec(a);
      const id = str(r.id);
      // Only primary agents can drive a session; subagents and hidden agents are internal.
      if (!id || r.hidden === true || r.mode === "subagent") continue;
      out.push({ id, name: str(r.name) ?? id });
    }
    return out;
  }

  async accountStatus(directory: string): Promise<AccountStatus> {
    const d = rec(await this.request("GET", "/api/integration", { query: this.loc(directory) }));
    return parseAccountStatus(d.data);
  }

  async listSessions(directory: string, limit: number): Promise<SessionSummary[]> {
    const d = rec(
      await this.request("GET", "/api/session", {
        query: { directory, parentID: "null", limit: String(limit), order: "desc" },
      }),
    );
    const list = Array.isArray(d.data) ? d.data : [];
    return list.map(toSessionSummary).filter((x) => x.id);
  }

  async getSession(id: string): Promise<SessionSummary> {
    const d = rec(await this.request("GET", `/api/session/${encodeURIComponent(id)}`));
    return toSessionSummary(d.data);
  }

  async createSession(input: {
    directory: string;
    agent?: string;
    model?: ModelRef;
  }): Promise<SessionSummary> {
    const body: Rec = { location: { directory: input.directory } };
    if (input.agent) body.agent = input.agent;
    if (input.model) body.model = modelBody(input.model);
    const d = rec(await this.request("POST", "/api/session", { body }));
    return toSessionSummary(d.data);
  }

  async listMessages(id: string, max: number): Promise<unknown[]> {
    // Newest-first pages, then reversed, so very long sessions only load their tail.
    // OpenCode rejects `order` together with `cursor`; the cursor carries the order.
    const out: unknown[] = [];
    let cursor: string | undefined;
    while (out.length < max) {
      const limit = Math.min(100, max - out.length);
      const query: Record<string, string | undefined> = cursor
        ? { cursor, limit: String(limit) }
        : { order: "desc", limit: String(limit) };
      const d = rec(await this.request("GET", `/api/session/${encodeURIComponent(id)}/message`, { query }));
      const page = Array.isArray(d.data) ? d.data : [];
      out.push(...page);
      const next = str(rec(d.cursor).next);
      if (!next || page.length === 0) break;
      cursor = next;
    }
    return out.reverse();
  }

  async prompt(
    id: string,
    input: { text: string; files: Array<{ uri: string; name: string }>; delivery?: InboxDelivery },
  ): Promise<{ id: string }> {
    const body: Rec = { text: input.text };
    if (input.files.length) body.files = input.files;
    if (input.delivery) body.delivery = input.delivery;
    const d = rec(await this.request("POST", `/api/session/${encodeURIComponent(id)}/prompt`, { body }));
    return { id: str(rec(d.data).id) ?? "" };
  }

  async switchModel(id: string, model: ModelRef): Promise<void> {
    await this.request("POST", `/api/session/${encodeURIComponent(id)}/model`, {
      body: { model: modelBody(model) },
    });
  }

  async switchAgent(id: string, agent: string): Promise<void> {
    await this.request("POST", `/api/session/${encodeURIComponent(id)}/agent`, { body: { agent } });
  }

  async activeSessions(): Promise<Set<string>> {
    const d = rec(await this.request("GET", "/api/session/active"));
    return new Set(Object.keys(rec(d.data)));
  }

  async interrupt(id: string): Promise<boolean> {
    const d = rec(await this.request("POST", `/api/session/${encodeURIComponent(id)}/interrupt`));
    return d.interrupted === true;
  }

  async listPermissions(id: string): Promise<PermissionRequest[]> {
    const d = rec(await this.request("GET", `/api/session/${encodeURIComponent(id)}/permission`));
    const list = Array.isArray(d.data) ? d.data : [];
    return list.map(toPermissionRequest).filter((p): p is PermissionRequest => p !== null);
  }

  async replyPermission(id: string, requestId: string, decision: PermissionDecision): Promise<void> {
    await this.request(
      "POST",
      `/api/session/${encodeURIComponent(id)}/permission/${encodeURIComponent(requestId)}/reply`,
      { body: { decision } },
    );
  }

  async sessionDiff(
    id: string,
    range: { from?: string; to?: string; full?: boolean } = {},
  ): Promise<FileDiffInfo[]> {
    const query: Record<string, string | undefined> = { from: range.from, to: range.to };
    // Omitting `context` yields full-file patches; a small context keeps payloads light otherwise.
    if (!range.full) query.context = "3";
    const d = rec(
      await this.request("GET", `/api/session/${encodeURIComponent(id)}/diff`, { query, timeoutMs: 30_000 }),
    );
    const list = Array.isArray(d.data) ? d.data : [];
    const out: FileDiffInfo[] = [];
    for (const f of list) {
      const r = rec(f);
      const file = str(r.file);
      if (!file) continue;
      out.push({
        file,
        patch: str(r.patch) ?? "",
        additions: typeof r.additions === "number" ? r.additions : 0,
        deletions: typeof r.deletions === "number" ? r.deletions : 0,
        status: r.status === "added" || r.status === "deleted" ? r.status : "modified",
      });
    }
    return out;
  }

  async listForms(id: string): Promise<FormRequest[]> {
    const d = rec(await this.request("GET", `/api/session/${encodeURIComponent(id)}/form`));
    const list = Array.isArray(d.data) ? d.data : [];
    return list.map(parseForm).filter((f): f is FormRequest => f !== null);
  }

  async replyForm(id: string, formId: string, answer: FormAnswer): Promise<void> {
    await this.request(
      "POST",
      `/api/session/${encodeURIComponent(id)}/form/${encodeURIComponent(formId)}/reply`,
      {
        body: { answer },
      },
    );
  }

  async cancelForm(id: string, formId: string): Promise<void> {
    await this.request("DELETE", `/api/session/${encodeURIComponent(id)}/form/${encodeURIComponent(formId)}`);
  }

  async listInbox(id: string): Promise<PendingInboxItem[]> {
    const d = rec(await this.request("GET", `/api/session/${encodeURIComponent(id)}/inbox`));
    const list = Array.isArray(d.data) ? d.data : [];
    const out: PendingInboxItem[] = [];
    for (const raw of list) {
      const r = rec(raw);
      const payload = rec(r.payload);
      const inboxId = str(r.id);
      if (r.type !== "user" || !inboxId) continue;
      const files = Array.isArray(payload.files) ? payload.files : [];
      out.push({
        id: inboxId,
        text: str(payload.text) ?? "",
        raw: str(payload.text) ?? "",
        attachments: files.map((f) => str(rec(f).name) ?? "file"),
        delivery: r.delivery === "queue" ? "queue" : "steer",
      });
    }
    return out;
  }

  async cancelInbox(id: string, inboxId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/api/session/${encodeURIComponent(id)}/inbox/${encodeURIComponent(inboxId)}`,
    );
  }

  async firstUserText(id: string): Promise<string | null> {
    // A fresh request without a cursor may use `order`.
    const d = rec(
      await this.request("GET", `/api/session/${encodeURIComponent(id)}/message`, {
        query: { order: "asc", limit: "10", type: "user" },
      }),
    );
    const list = Array.isArray(d.data) ? d.data : [];
    for (const m of list) if (rec(m).type === "user") return str(rec(m).text);
    return null;
  }

  /** Opens the global event stream and reconnects with backoff until disposed. */
  subscribe(handlers: EventHandlers): EventSubscription {
    let disposed = false;
    let controller: AbortController | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = async (): Promise<void> => {
      if (disposed) return;
      controller = new AbortController();
      let error: string;
      try {
        const res = await this.fetchImpl(this.buildUrl("/api/event"), {
          headers: { ...this.headers(false), accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || !res.body)
          throw new OpenCodeHttpError(res.status, null, `Event stream failed: HTTP ${res.status}`);
        attempt = 0;
        handlers.onOpen();
        const parser = new SseParser();
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
            try {
              handlers.onEvent(JSON.parse(msg.data));
            } catch {
              // Ignore malformed frames; never surface raw payloads.
            }
          }
        }
        error = "Event stream closed";
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      if (disposed) return;
      handlers.onClose(error);
      const delay = this.reconnectDelays[Math.min(attempt, this.reconnectDelays.length - 1)];
      attempt++;
      timer = setTimeout(() => void connect(), delay);
    };
    void connect();
    return {
      dispose: () => {
        disposed = true;
        if (timer) clearTimeout(timer);
        controller?.abort();
      },
    };
  }
}
