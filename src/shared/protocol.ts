// Message schema between the extension host and the sidebar webview.
// Webview -> host messages are untrusted input and are validated strictly by
// `parseWebviewMessage` before the host acts on them.

import type {
  AgentOption,
  BudgetLevel,
  BudgetLimits,
  BudgetView,
  ConnectionStatus,
  FileChange,
  FormAnswer,
  InboxDelivery,
  ModelOption,
  OnboardingView,
  PendingInboxItem,
  PermissionDecision,
  SessionSummary,
  TranscriptItem,
  UiEvent,
  UsageInfo,
  WorkspaceInfo,
} from "./model";

export interface AttachmentChip {
  id: string;
  label: string;
  detail: string;
}

export interface ViewState {
  connection: ConnectionStatus;
  workspace: WorkspaceInfo;
  /** null = could not be loaded (shown as unavailable). */
  models: ModelOption[] | null;
  agents: AgentOption[] | null;
  selectedModel: string | null;
  selectedAgent: string | null;
  sessions: SessionSummary[];
  currentSession: { id: string; title: string } | null;
  busy: boolean;
  stopping: boolean;
  attachments: AttachmentChip[];
  /** Changes attributed to the agent by OpenCode's session snapshots. */
  agentChanges:
    { status: "none" } | { status: "ok"; files: FileChange[] } | { status: "unavailable"; reason: string };
  /** Uncommitted workspace changes (Git, HEAD ↔ working tree); null when Git is unavailable. */
  workspaceChanges: { count: number } | null;
  /** null when usage display is disabled or no figures are available. */
  usage: UsageInfo | null;
  /** Completed agent steps in the current session. */
  steps: number;
  selectedVariant: string | null;
  budget: BudgetView;
  budgetPresets: Record<Exclude<BudgetLevel, "off">, BudgetLimits>;
  pending: PendingInboxItem[];
  locale: "en" | "ar";
  /** One-time tip about moving the view to the Secondary Side Bar. */
  showPlacementHint: boolean;
  /** Current / Last Task bar; null for an empty session. The full prompt is fetched on demand. */
  task: {
    id: string;
    label: "current" | "last";
    summary: string;
    status: "running" | "waiting" | "completed" | "stopped" | "budget-stopped" | "failed" | null;
    steer: string | null;
    next: { summary: string; more: number } | null;
    chars: number;
    lines: number;
  } | null;
  /** First-run / connection guidance; `stage: "ready"` hides it. */
  onboarding: OnboardingView;
}

/** Official OpenCode pages the webview may ask the host to open (keys, never URLs). */
export type OfficialLink = "install" | "account" | "providers" | "go" | "setupGuide";
const OFFICIAL_LINKS: OfficialLink[] = ["install", "account", "providers", "go", "setupGuide"];

export type HostMessage =
  | { type: "state"; state: ViewState }
  | { type: "transcript"; items: TranscriptItem[] }
  | { type: "events"; events: UiEvent[] }
  | { type: "focusInput" }
  | { type: "copyResult"; requestId: string; ok: boolean }
  | { type: "restoreInput"; text: string }
  | { type: "formError"; formId: string; error: string }
  | { type: "focusModel" }
  | { type: "taskPrompt"; id: string; text: string };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string; delivery?: InboxDelivery }
  | { type: "stop" }
  | { type: "newSession" }
  | { type: "selectSession"; id: string }
  | { type: "refreshSessions" }
  | { type: "selectModel"; key: string }
  | { type: "selectAgent"; id: string }
  | { type: "selectRoot"; path: string }
  | { type: "addCurrentFile" }
  | { type: "addSelection" }
  | { type: "pickFile" }
  | { type: "removeAttachment"; id: string }
  | { type: "respondPermission"; requestId: string; decision: PermissionDecision }
  | { type: "openFile"; path: string }
  | { type: "openDiff"; path: string }
  | { type: "openAllDiffs" }
  | { type: "copy"; text: string; requestId: string }
  | { type: "copyMessage"; itemId: string; requestId: string }
  | { type: "selectVariant"; variant: string }
  | { type: "selectBudget"; level: BudgetLevel }
  | { type: "budgetAction"; itemId: string; action: "continue" | "increase" | "newSession" }
  | { type: "answerForm"; formId: string; answer: FormAnswer }
  | { type: "cancelForm"; formId: string }
  | { type: "editPending"; id: string }
  | { type: "removePending"; id: string }
  | { type: "openAgentDiff"; path: string }
  | { type: "openAgentDiffAll" }
  | { type: "openWorkspaceDiffAll" }
  | { type: "retryLast" }
  | { type: "focusModelPicker" }
  | { type: "dismissHint" }
  | { type: "getTaskPrompt" }
  | { type: "copyTaskPrompt"; requestId: string }
  | { type: "openLink"; href: string }
  | { type: "startOpenCode" }
  | { type: "retry" }
  | { type: "configurePath" }
  | { type: "showLogs" }
  | { type: "signIn" }
  | { type: "connectProvider" }
  | { type: "refreshConnection" }
  | { type: "openFolder" }
  | { type: "openOfficial"; link: OfficialLink }
  | { type: "dismissSignInHint" };

const MAX_TEXT = 200_000;
/** Code blocks copied from very long reports can be large; still bounded. */
const MAX_COPY = 5_000_000;
const BUDGET_LEVELS = ["off", "small", "medium", "large", "custom"];

/** Validates a form answer: plain values only, bounded sizes. Field-level rules are checked by the host. */
function isAnswer(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 100) return false;
  return entries.every(([k, x]) => {
    if (k.length === 0 || k.length > 200 || k === "__proto__" || k === "constructor" || k === "prototype")
      return false;
    if (typeof x === "string") return x.length <= 20_000;
    if (typeof x === "number") return Number.isFinite(x);
    if (typeof x === "boolean") return true;
    return Array.isArray(x) && x.length <= 200 && x.every((y) => typeof y === "string" && y.length <= 2000);
  });
}
const MAX_ID = 512;

type Validator = (msg: Record<string, unknown>) => boolean;

const isStr = (v: unknown, max = MAX_ID): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;

const VALIDATORS: Record<WebviewMessage["type"], Validator> = {
  ready: () => true,
  send: (m) =>
    typeof m.text === "string" &&
    m.text.length <= MAX_TEXT &&
    (m.delivery === undefined || m.delivery === "steer" || m.delivery === "queue"),
  stop: () => true,
  newSession: () => true,
  selectSession: (m) => isStr(m.id),
  refreshSessions: () => true,
  selectModel: (m) => isStr(m.key),
  selectAgent: (m) => isStr(m.id),
  selectRoot: (m) => isStr(m.path, 4096),
  addCurrentFile: () => true,
  addSelection: () => true,
  pickFile: () => true,
  removeAttachment: (m) => isStr(m.id),
  respondPermission: (m) =>
    isStr(m.requestId) && (m.decision === "once" || m.decision === "always" || m.decision === "reject"),
  openFile: (m) => isStr(m.path, 4096),
  openDiff: (m) => isStr(m.path, 4096),
  openAllDiffs: () => true,
  copy: (m) => typeof m.text === "string" && m.text.length <= MAX_COPY && isStr(m.requestId, 64),
  copyMessage: (m) => isStr(m.itemId) && isStr(m.requestId, 64),
  selectVariant: (m) => typeof m.variant === "string" && m.variant.length <= 100,
  selectBudget: (m) => typeof m.level === "string" && BUDGET_LEVELS.includes(m.level),
  budgetAction: (m) =>
    isStr(m.itemId) && (m.action === "continue" || m.action === "increase" || m.action === "newSession"),
  answerForm: (m) => isStr(m.formId) && isAnswer(m.answer),
  cancelForm: (m) => isStr(m.formId),
  editPending: (m) => isStr(m.id),
  removePending: (m) => isStr(m.id),
  openAgentDiff: (m) => isStr(m.path, 4096),
  openAgentDiffAll: () => true,
  openWorkspaceDiffAll: () => true,
  retryLast: () => true,
  focusModelPicker: () => true,
  dismissHint: () => true,
  getTaskPrompt: () => true,
  copyTaskPrompt: (m) => isStr(m.requestId, 64),
  openLink: (m) => isStr(m.href, 4096),
  startOpenCode: () => true,
  retry: () => true,
  configurePath: () => true,
  showLogs: () => true,
  signIn: () => true,
  connectProvider: () => true,
  refreshConnection: () => true,
  openFolder: () => true,
  openOfficial: (m) => typeof m.link === "string" && (OFFICIAL_LINKS as string[]).includes(m.link),
  dismissSignInHint: () => true,
};

const ALLOWED_KEYS: Partial<Record<WebviewMessage["type"], string[]>> = {
  send: ["text", "delivery"],
  selectSession: ["id"],
  selectModel: ["key"],
  selectAgent: ["id"],
  selectRoot: ["path"],
  removeAttachment: ["id"],
  respondPermission: ["requestId", "decision"],
  openFile: ["path"],
  openDiff: ["path"],
  copy: ["text", "requestId"],
  copyMessage: ["itemId", "requestId"],
  selectVariant: ["variant"],
  selectBudget: ["level"],
  budgetAction: ["itemId", "action"],
  answerForm: ["formId", "answer"],
  cancelForm: ["formId"],
  editPending: ["id"],
  removePending: ["id"],
  openAgentDiff: ["path"],
  copyTaskPrompt: ["requestId"],
  openLink: ["href"],
  openOfficial: ["link"],
};

/** Returns a typed message, or undefined if the payload does not match the schema exactly. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const msg = raw as Record<string, unknown>;
  const type = msg.type;
  if (typeof type !== "string" || !Object.prototype.hasOwnProperty.call(VALIDATORS, type)) return undefined;
  const key = type as WebviewMessage["type"];
  const allowed = new Set(["type", ...(ALLOWED_KEYS[key] ?? [])]);
  for (const k of Object.keys(msg)) if (!allowed.has(k)) return undefined;
  if (!VALIDATORS[key](msg)) return undefined;
  return msg as unknown as WebviewMessage;
}
