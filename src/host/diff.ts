// Opens changed files in VS Code's native diff editor (HEAD ↔ working tree)
// using the built-in Git extension's `git:` URIs. No custom diff rendering.

import * as path from "node:path";
import * as vscode from "vscode";
import type { FileChange } from "../shared/model";
import type { GitAPI } from "./gitApi";

export const EMPTY_SCHEME = "opencode-sidebar-empty";

/** Serves empty documents for the missing side of added/deleted files. */
export class EmptyDocumentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(): string {
    return "";
  }
}

function emptyUri(file: string): vscode.Uri {
  return vscode.Uri.from({ scheme: EMPTY_SCHEME, path: "/" + path.basename(file) });
}

export function diffSides(
  git: GitAPI,
  absPath: string,
  status: FileChange["status"],
): { left: vscode.Uri; right: vscode.Uri } {
  const file = vscode.Uri.file(absPath);
  const left = status === "added" ? emptyUri(absPath) : git.toGitUri(file, "HEAD");
  const right = status === "deleted" ? emptyUri(absPath) : file;
  return { left, right };
}

export async function openFileDiff(
  git: GitAPI | undefined,
  absPath: string,
  status: FileChange["status"],
): Promise<"diff" | "file"> {
  if (!git || !git.getRepository(vscode.Uri.file(absPath))) {
    await vscode.window.showTextDocument(vscode.Uri.file(absPath), { preview: true });
    return "file";
  }
  const { left, right } = diffSides(git, absPath, status);
  const title = `${path.basename(absPath)} (HEAD ↔ Working Tree)`;
  await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
  return "diff";
}

export async function openAllDiffs(
  git: GitAPI | undefined,
  files: Array<{ absPath: string; status: FileChange["status"] }>,
): Promise<void> {
  if (!files.length) return;
  if (!git) {
    await openFileDiff(undefined, files[0].absPath, files[0].status);
    return;
  }
  const resources = files.map((f) => {
    const { left, right } = diffSides(git, f.absPath, f.status);
    return [vscode.Uri.file(f.absPath), left, right] as const;
  });
  try {
    // Native multi-file diff editor.
    await vscode.commands.executeCommand(
      "vscode.changes",
      "Workspace changes (HEAD ↔ Working Tree)",
      resources,
    );
  } catch {
    await openFileDiff(git, files[0].absPath, files[0].status);
  }
}

// ------------------------------------------------------------- agent-only diff

export const AGENT_SCHEME = "opencode-sidebar-agent";

export interface AgentSideSource {
  /** Before/after content for a file of the given session, or null when unavailable. */
  sides(sessionId: string, file: string): { before: string; after: string } | null;
}

/**
 * Serves the agent's before/after snapshots (reconstructed from OpenCode's
 * full-file session patches) as read-only documents for the native diff editor.
 * URI: opencode-sidebar-agent:/<before|after>/<relative file>?session=<id>
 */
export class AgentDocumentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly source: () => AgentSideSource | undefined) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const m = /^\/(before|after)\/(.+)$/.exec(uri.path);
    const session = new URLSearchParams(uri.query).get("session");
    if (!m || !session) return "";
    const sides = this.source()?.sides(session, m[2]);
    if (!sides) return "(Agent snapshot is no longer available. Reopen the session and try again.)";
    return m[1] === "before" ? sides.before : sides.after;
  }
}

export function agentUris(sessionId: string, file: string): { left: vscode.Uri; right: vscode.Uri } {
  const make = (side: string) =>
    vscode.Uri.from({
      scheme: AGENT_SCHEME,
      path: `/${side}/${file}`,
      query: `session=${encodeURIComponent(sessionId)}`,
    });
  return { left: make("before"), right: make("after") };
}

export async function openAgentFileDiff(sessionId: string, file: string): Promise<void> {
  const { left, right } = agentUris(sessionId, file);
  await vscode.commands.executeCommand("vscode.diff", left, right, `${path.basename(file)} (Agent changes)`, {
    preview: true,
  });
}

export async function openAgentDiffs(
  sessionId: string,
  files: Array<{ file: string; absPath: string }>,
): Promise<void> {
  if (!files.length) return;
  const resources = files.map((f) => {
    const { left, right } = agentUris(sessionId, f.file);
    return [vscode.Uri.file(f.absPath), left, right] as const;
  });
  try {
    await vscode.commands.executeCommand("vscode.changes", "OpenCode agent changes", resources);
  } catch {
    await openAgentFileDiff(sessionId, files[0].file);
  }
}
