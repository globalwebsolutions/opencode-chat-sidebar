// Minimal typings for the built-in `vscode.git` extension API (version 1).
// Only the members this extension uses are declared.

import * as vscode from "vscode";

export interface GitRef {
  name?: string;
  commit?: string;
}

export interface GitChange {
  uri: vscode.Uri;
  /** vscode.git Status enum value. */
  status: number;
}

export interface GitRepositoryState {
  HEAD: GitRef | undefined;
  workingTreeChanges: GitChange[];
  indexChanges: GitChange[];
  untrackedChanges?: GitChange[];
  onDidChange: vscode.Event<void>;
}

export interface GitRepository {
  rootUri: vscode.Uri;
  state: GitRepositoryState;
}

export interface GitAPI {
  repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
  enabled: boolean;
  getAPI(version: 1): GitAPI;
}

/** Returns the Git API if the built-in Git extension is installed and enabled. */
export async function getGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!ext) return undefined;
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    return exports.enabled ? exports.getAPI(1) : undefined;
  } catch {
    return undefined;
  }
}
