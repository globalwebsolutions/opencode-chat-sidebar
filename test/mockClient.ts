import type {
  EventHandlers,
  EventSubscription,
  FileDiffInfo,
  OpenCodeClient,
  ServerInfo,
} from "../src/opencode/client";
import { OpenCodeHttpError } from "../src/opencode/client";
import type {
  AgentOption,
  FormAnswer,
  FormRequest,
  InboxDelivery,
  ModelOption,
  PendingInboxItem,
  PermissionDecision,
  PermissionRequest,
  SessionSummary,
} from "../src/shared/model";

export interface Call {
  method: string;
  args: unknown[];
}

/** In-memory OpenCodeClient used to test the controller without a server. */
export class MockClient implements OpenCodeClient {
  readonly url = "http://127.0.0.1:1";
  calls: Call[] = [];
  models: ModelOption[] = [
    {
      key: "opencode-go/kimi",
      providerID: "opencode-go",
      id: "kimi",
      name: "Kimi",
      providerName: "OpenCode Go",
      contextLimit: 262144,
      variants: [],
    },
    {
      key: "vast/qwen",
      providerID: "vast",
      id: "qwen",
      name: "Qwen",
      providerName: "Vast",
      contextLimit: 131072,
      variants: ["low", "high"],
    },
  ];
  modelResponses: ModelOption[][] | null = null;
  agents: AgentOption[] = [
    { id: "build", name: "Build" },
    { id: "plan", name: "Plan" },
  ];
  serverDefault: string | null = "vast/qwen";
  sessions: SessionSummary[] = [];
  messages: unknown[] = [];
  permissions: PermissionRequest[] = [];
  active = new Set<string>();
  interruptResult = true;
  replyError: Error | null = null;
  diff: FileDiffInfo[] = [];
  private counter = 0;

  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
  }
  callsTo(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  async info(): Promise<ServerInfo> {
    return { version: "2.0.24", pid: 1 };
  }
  async listModels(directory: string) {
    this.record("listModels", directory);
    if (this.modelResponses?.length) return this.modelResponses.shift()!;
    return this.models;
  }
  async defaultModel() {
    return this.serverDefault;
  }
  async listAgents() {
    return this.agents;
  }
  async listSessions(directory: string, limit: number) {
    this.record("listSessions", directory, limit);
    return this.sessions;
  }
  async getSession(id: string): Promise<SessionSummary> {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new OpenCodeHttpError(404, "NotFound", "Session not found");
    return s;
  }
  async createSession(input: {
    directory: string;
    agent?: string;
    model?: { providerID: string; id: string; variant?: string };
  }) {
    this.record("createSession", input);
    const s: SessionSummary = {
      id: `ses_${++this.counter}`,
      title: "New session",
      created: 1,
      updated: 1,
      agent: input.agent ?? null,
      modelKey: input.model ? `${input.model.providerID}/${input.model.id}` : null,
      outcome: null,
      variant: input.model?.variant ?? null,
      cost: 0,
    };
    this.sessions.unshift(s);
    return s;
  }
  async listMessages(id: string) {
    this.record("listMessages", id);
    return this.messages;
  }
  async prompt(
    id: string,
    input: { text: string; files: Array<{ uri: string; name: string }>; delivery?: InboxDelivery },
  ) {
    this.record("prompt", id, input);
    return { id: `msg_${++this.counter}` };
  }
  async switchModel(id: string, model: { providerID: string; id: string; variant?: string }) {
    this.record("switchModel", id, model);
  }
  async switchAgent(id: string, agent: string) {
    this.record("switchAgent", id, agent);
  }
  async activeSessions() {
    return new Set(this.active);
  }
  async interrupt(id: string) {
    this.record("interrupt", id);
    return this.interruptResult;
  }
  async listPermissions() {
    return this.permissions;
  }
  async replyPermission(id: string, requestId: string, decision: PermissionDecision) {
    this.record("replyPermission", id, requestId, decision);
    if (this.replyError) throw this.replyError;
  }
  async sessionDiff(id: string, range?: { from?: string; to?: string; full?: boolean }) {
    this.record("sessionDiff", id, range);
    if (this.diffError) throw this.diffError;
    return this.diff;
  }
  forms: FormRequest[] = [];
  inbox: PendingInboxItem[] = [];
  formReplyError: Error | null = null;
  inboxCancelError: Error | null = null;
  diffError: Error | null = null;
  firstTexts = new Map<string, string>();

  async listForms(id: string) {
    this.record("listForms", id);
    return this.forms;
  }
  async replyForm(id: string, formId: string, answer: FormAnswer) {
    this.record("replyForm", id, formId, answer);
    if (this.formReplyError) throw this.formReplyError;
  }
  async cancelForm(id: string, formId: string) {
    this.record("cancelForm", id, formId);
  }
  async listInbox(id: string) {
    this.record("listInbox", id);
    return this.inbox;
  }
  async cancelInbox(id: string, inboxId: string) {
    this.record("cancelInbox", id, inboxId);
    if (this.inboxCancelError) throw this.inboxCancelError;
  }
  async firstUserText(id: string) {
    this.record("firstUserText", id);
    return this.firstTexts.get(id) ?? null;
  }

  subscribe(_handlers: EventHandlers): EventSubscription {
    return { dispose() {} };
  }
}

export class MemoryStore {
  data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  async update(key: string, value: unknown) {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, value);
  }
}
