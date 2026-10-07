// Transport-neutral domain types shared by the extension host and the webview.
// Nothing in here may reference OpenCode wire objects directly; the adapter in
// src/opencode/ maps raw payloads onto these shapes.

export type ConnectionStatus =
  | { kind: "connecting" }
  | { kind: "connected"; version: string; url: string }
  | { kind: "not-running"; canStart: boolean; detail: string }
  | { kind: "cli-not-found"; searched: string[] }
  | { kind: "error"; message: string };

export type RepoKind = "local" | "worktree" | "not-git" | "unknown";

export interface WorkspaceFolderInfo {
  name: string;
  path: string;
}

export interface WorkspaceInfo {
  /** null when no folder is open. */
  active: WorkspaceFolderInfo | null;
  folders: WorkspaceFolderInfo[];
  branch: string | null;
  /** Short commit when HEAD is detached. */
  detachedAt: string | null;
  repoKind: RepoKind;
  repoRoot: string | null;
  /** For a secondary worktree, the path of the main working tree when known. */
  mainWorktree: string | null;
}

export interface ModelOption {
  /** `${providerID}/${id}` */
  key: string;
  providerID: string;
  id: string;
  name: string;
  providerName: string;
  contextLimit: number | null;
}

export interface AgentOption {
  id: string;
  name: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  created: number;
  updated: number;
  agent: string | null;
  modelKey: string | null;
  outcome: "succeeded" | "failed" | "interrupted" | null;
  /** Session cost in USD as reported by OpenCode, when present. */
  cost: number | null;
}

export type ContextAttachment =
  | { kind: "file"; id: string; relPath: string; absPath: string }
  | {
      kind: "selection";
      id: string;
      relPath: string;
      absPath: string;
      startLine: number;
      endLine: number;
      text: string;
      languageId: string;
    };

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageInfo {
  /** Tokens occupying the context window after the most recent step. */
  contextTokens: number | null;
  contextLimit: number | null;
  /** Session cost in USD as reported by OpenCode. */
  cost: number | null;
}

export type PermissionDecision = "once" | "always" | "reject";

export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  /** OpenCode only offers "always" when the request carries save patterns. */
  canAlways: boolean;
  message: string | null;
  toolId: string | null;
}

export type ToolStatus = "pending" | "running" | "completed" | "failed";

export interface ToolDetail {
  /** Short key/value facts derived from the tool input (never a raw JSON dump). */
  facts: Array<[string, string]>;
  command: string | null;
  cwd: string | null;
  output: string | null;
  outputTruncated: boolean;
  exitCode: number | null;
  files: FileChange[];
  error: string | null;
}

export type TranscriptItem =
  | { kind: "user"; id: string; text: string; attachments: string[] }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "reasoning"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      title: string;
      category: ToolCategory;
      status: ToolStatus;
      detail: ToolDetail;
    }
  | {
      kind: "permission";
      id: string;
      request: PermissionRequest;
      sensitive: string[];
      status: "pending" | "sending" | PermissionDecision | "expired";
    }
  | { kind: "turn-summary"; id: string; files: FileChange[] }
  | { kind: "notice"; id: string; level: "error" | "info"; text: string };

export type ToolCategory = "read" | "search" | "shell" | "edit" | "web" | "agent" | "other";

/**
 * Normalized session events (internal UI event model). Produced from OpenCode
 * events by src/opencode/events.ts and from local actions by the host.
 */
export type UiEvent =
  | { type: "user.message"; id: string; text: string; attachments: string[] }
  | { type: "assistant.delta"; partId: string; delta: string }
  | { type: "assistant.completed"; partId: string; text: string }
  | { type: "reasoning.delta"; partId: string; delta: string }
  | { type: "reasoning.completed"; partId: string; text: string }
  | { type: "tool.started"; toolId: string; name: string }
  | { type: "tool.input"; toolId: string; name: string | null; input: Record<string, unknown> }
  | { type: "tool.shell"; toolId: string; cwd: string | null; command: string | null }
  | {
      type: "tool.completed";
      toolId: string;
      output: string | null;
      metadata: Record<string, unknown> | null;
    }
  | {
      type: "tool.failed";
      toolId: string;
      error: string;
      output: string | null;
      metadata: Record<string, unknown> | null;
    }
  | { type: "permission.requested"; request: PermissionRequest; sensitive: string[] }
  | { type: "permission.sending"; requestId: string }
  | { type: "permission.resolved"; requestId: string; decision: PermissionDecision | "expired" }
  | { type: "files.changed"; files: string[] }
  | { type: "session.busy" }
  | { type: "session.idle"; outcome: "succeeded" | "failed" | "interrupted" }
  | { type: "session.error"; message: string }
  | { type: "session.retry"; attempt: number; message: string }
  | { type: "session.renamed"; title: string }
  | { type: "usage.step"; tokens: TokenUsage; modelKey: string | null }
  | { type: "usage.session"; cost: number; tokens: TokenUsage }
  | { type: "notice"; level: "error" | "info"; text: string };
