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
    await vscode.commands.executeCommand("vscode.changes", "OpenCode session changes", resources);
  } catch {
    await openFileDiff(git, files[0].absPath, files[0].status);
  }
}
