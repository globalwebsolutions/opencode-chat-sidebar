// Classifies a folder as a regular local repository, a secondary Git worktree,
// or neither, by inspecting the `.git` entry. Read-only; never runs git.

import * as path from "node:path";
import type { RepoKind } from "../shared/model";

export interface FsProbe {
  /** "file" | "dir" | undefined when missing. */
  kind(file: string): "file" | "dir" | undefined;
  read(file: string): string | undefined;
}

export interface RepositoryDetection {
  kind: RepoKind;
  root: string | null;
  /** Main working tree for secondary worktrees, when it can be derived. */
  mainWorktree: string | null;
}

/** Walks up from `start` to find the nearest directory containing `.git`. */
export function findRepositoryRoot(start: string, fs: FsProbe): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.kind(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Parses the `gitdir:` pointer from a `.git` file. */
export function parseGitFile(content: string): string | null {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  return m ? m[1] : null;
}

/**
 * Determines the repository kind for `root` (a directory that contains `.git`).
 * - `.git` directory → local repository (the main working tree).
 * - `.git` file whose gitdir is `<common>/worktrees/<name>` → secondary worktree.
 * - `.git` file pointing at `<super>/.git/modules/...` → submodule, treated as local.
 */
export function classifyRepository(root: string, fs: FsProbe): RepositoryDetection {
  const dotGit = path.join(root, ".git");
  const kind = fs.kind(dotGit);
  if (kind === "dir") return { kind: "local", root, mainWorktree: null };
  if (kind !== "file") return { kind: "not-git", root: null, mainWorktree: null };

  const content = fs.read(dotGit);
  const pointer = content ? parseGitFile(content) : null;
  if (!pointer) return { kind: "unknown", root, mainWorktree: null };
  const gitdir = path.resolve(root, pointer);
  const normalized = gitdir.replace(/\\/g, "/");
  const wt = /^(.*)\/worktrees\/[^/]+\/?$/.exec(normalized);
  if (wt) {
    const commonDir = wt[1];
    // The common dir is normally `<main>/.git`; a bare repository has no main working tree.
    const main = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null;
    return { kind: "worktree", root, mainWorktree: main };
  }
  if (/\/modules\//.test(normalized)) return { kind: "local", root, mainWorktree: null };
  return { kind: "unknown", root, mainWorktree: null };
}

export function detectRepository(folder: string, fs: FsProbe): RepositoryDetection {
  const root = findRepositoryRoot(folder, fs);
  if (!root) return { kind: "not-git", root: null, mainWorktree: null };
  return classifyRepository(root, fs);
}

/** Reads the branch from `.git/HEAD` (or the worktree's HEAD). Returns detached commit when not on a branch. */
export function readHead(root: string, fs: FsProbe): { branch: string | null; detachedAt: string | null } {
  const dotGit = path.join(root, ".git");
  let headFile = path.join(dotGit, "HEAD");
  if (fs.kind(dotGit) === "file") {
    const pointer = parseGitFile(fs.read(dotGit) ?? "");
    if (!pointer) return { branch: null, detachedAt: null };
    headFile = path.join(path.resolve(root, pointer), "HEAD");
  }
  const head = fs.read(headFile)?.trim();
  if (!head) return { branch: null, detachedAt: null };
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  if (ref) return { branch: ref[1], detachedAt: null };
  if (/^[0-9a-f]{7,64}$/i.test(head)) return { branch: null, detachedAt: head.slice(0, 7) };
  return { branch: null, detachedAt: null };
}
