// Tracks the active workspace folder, its Git branch and whether it is a
// regular repository or a secondary worktree. Uses the built-in Git extension
// for branch state and change events; falls back to reading `.git/HEAD`.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { detectRepository, readHead, type FsProbe } from "../core/repository";
import type { WorkspaceFolderInfo, WorkspaceInfo } from "../shared/model";
import { getGitApi, type GitAPI, type GitRepository } from "./gitApi";

const ACTIVE_ROOT_KEY = "opencodeSidebar.activeRoot";

export const nodeFsProbe: FsProbe = {
  kind(file) {
    try {
      const st = fs.statSync(file);
      return st.isDirectory() ? "dir" : st.isFile() ? "file" : undefined;
    } catch {
      return undefined;
    }
  },
  read(file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  },
};

export class WorkspaceTracker implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<WorkspaceInfo>();
  readonly onDidChange = this.emitter.event;
  private disposables: vscode.Disposable[] = [];
  private repoListener: vscode.Disposable | undefined;
  private git: GitAPI | undefined;
  private info: WorkspaceInfo = emptyInfo();
  private started = false;

  constructor(private readonly memento: vscode.Memento) {}

  get current(): WorkspaceInfo {
    return this.info;
  }

  /** Starts tracking. Called lazily when the sidebar is first shown. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()));
    this.git = await getGitApi();
    if (this.git) {
      this.disposables.push(this.git.onDidOpenRepository(() => this.refresh()));
      this.disposables.push(this.git.onDidCloseRepository(() => this.refresh()));
    }
    // Without the Git extension, re-read HEAD when the window regains focus.
    this.disposables.push(
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused && !this.git) this.refresh();
      }),
    );
    this.refresh();
  }

  get gitApi(): GitAPI | undefined {
    return this.git;
  }

  folders(): WorkspaceFolderInfo[] {
    return (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === "file")
      .map((f) => ({ name: f.name, path: f.uri.fsPath }));
  }

  async setActiveRoot(folderPath: string): Promise<boolean> {
    if (!this.folders().some((f) => f.path === folderPath)) return false;
    await this.memento.update(ACTIVE_ROOT_KEY, folderPath);
    this.refresh();
    return true;
  }

  private chooseActive(folders: WorkspaceFolderInfo[]): WorkspaceFolderInfo | null {
    if (!folders.length) return null;
    const remembered = this.memento.get<string>(ACTIVE_ROOT_KEY);
    const found = folders.find((f) => f.path === remembered);
    if (found) return found;
    // Multi-root: start with the first folder; the header shows a picker so the
    // choice is always visible and never silently switches later.
    return folders[0];
  }

  refresh(): void {
    const folders = this.folders();
    const active = this.chooseActive(folders);
    let next: WorkspaceInfo = { ...emptyInfo(), folders, active };
    if (active) {
      const detection = detectRepository(active.path, nodeFsProbe);
      next = {
        ...next,
        repoKind: detection.kind,
        repoRoot: detection.root,
        mainWorktree: detection.mainWorktree,
      };
      if (detection.root) {
        const repo = this.git?.getRepository(vscode.Uri.file(detection.root)) ?? null;
        this.watchRepository(repo);
        const head = repo?.state.HEAD;
        next.uncommitted = repo ? this.changeList(repo).length : null;
        if (repo && head && (head.name || head.commit)) {
          next.branch = head.name ?? null;
          next.detachedAt = head.name ? null : (head.commit?.slice(0, 7) ?? null);
        } else {
          const h = readHead(detection.root, nodeFsProbe);
          next.branch = h.branch;
          next.detachedAt = h.detachedAt;
        }
      } else {
        this.watchRepository(null);
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(this.info)) {
      this.info = next;
      this.emitter.fire(next);
    }
  }

  private watchedRoot: string | null = null;

  private watchRepository(repo: GitRepository | null): void {
    const root = repo ? repo.rootUri.fsPath : null;
    if (root === this.watchedRoot) return;
    this.repoListener?.dispose();
    this.repoListener = repo?.state.onDidChange(() => this.refresh());
    this.watchedRoot = root;
  }

  private changeList(
    repo: GitRepository,
  ): Array<{ absPath: string; status: "added" | "deleted" | "modified" }> {
    const seen = new Map<string, "added" | "deleted" | "modified">();
    const st = repo.state;
    for (const c of [...st.indexChanges, ...st.workingTreeChanges, ...(st.untrackedChanges ?? [])]) {
      // vscode.git Status: 1 INDEX_ADDED, 7 UNTRACKED, 9 INTENT_TO_ADD → added; 2 INDEX_DELETED, 6 DELETED → deleted.
      const status = [1, 7, 9].includes(c.status)
        ? "added"
        : [2, 6].includes(c.status)
          ? "deleted"
          : "modified";
      if (!seen.has(c.uri.fsPath) || status !== "modified") seen.set(c.uri.fsPath, status);
    }
    return [...seen].map(([absPath, status]) => ({ absPath, status }));
  }

  /** Uncommitted changes of the active repository (HEAD ↔ working tree), or null without Git. */
  workspaceChanges(): Array<{ absPath: string; status: "added" | "deleted" | "modified" }> | null {
    const root = this.info.repoRoot;
    const repo = root ? (this.git?.getRepository(vscode.Uri.file(root)) ?? null) : null;
    return repo ? this.changeList(repo) : null;
  }

  /** Resolves a path reported by OpenCode (relative to the active folder) to an absolute path inside it. */
  resolveInActive(p: string): string | null {
    const root = this.info.active?.path;
    if (!root) return null;
    const abs = path.resolve(root, p);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return abs;
  }

  dispose(): void {
    this.repoListener?.dispose();
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }
}

function emptyInfo(): WorkspaceInfo {
  return {
    active: null,
    folders: [],
    branch: null,
    detachedAt: null,
    repoKind: "unknown",
    repoRoot: null,
    mainWorktree: null,
    uncommitted: null,
  };
}
