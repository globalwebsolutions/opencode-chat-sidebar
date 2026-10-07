// Message schema between the extension host and the sidebar webview.
// Webview -> host messages are untrusted input and are validated strictly by
// `parseWebviewMessage` before the host acts on them.

import type {
  AgentOption,
  ConnectionStatus,
  FileChange,
  ModelOption,
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
  changes: FileChange[];
  /** null when usage display is disabled or no figures are available. */
  usage: UsageInfo | null;
}

export type HostMessage =
  | { type: "state"; state: ViewState }
  | { type: "transcript"; items: TranscriptItem[] }
  | { type: "events"; events: UiEvent[] }
  | { type: "focusInput" };

export type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
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
  | { type: "copy"; text: string }
  | { type: "openLink"; href: string }
  | { type: "startOpenCode" }
  | { type: "retry" }
  | { type: "configurePath" }
  | { type: "showLogs" };

const MAX_TEXT = 200_000;
const MAX_ID = 512;

type Validator = (msg: Record<string, unknown>) => boolean;

const isStr = (v: unknown, max = MAX_ID): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;

const VALIDATORS: Record<WebviewMessage["type"], Validator> = {
  ready: () => true,
  send: (m) => typeof m.text === "string" && m.text.length <= MAX_TEXT,
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
  copy: (m) => typeof m.text === "string" && m.text.length <= MAX_TEXT,
  openLink: (m) => isStr(m.href, 4096),
  startOpenCode: () => true,
  retry: () => true,
  configurePath: () => true,
  showLogs: () => true,
};

const ALLOWED_KEYS: Partial<Record<WebviewMessage["type"], string[]>> = {
  send: ["text"],
  selectSession: ["id"],
  selectModel: ["key"],
  selectAgent: ["id"],
  selectRoot: ["path"],
  removeAttachment: ["id"],
  respondPermission: ["requestId", "decision"],
  openFile: ["path"],
  openDiff: ["path"],
  copy: ["text"],
  openLink: ["href"],
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
