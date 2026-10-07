import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  classifyRepository,
  detectRepository,
  parseGitFile,
  readHead,
  type FsProbe,
} from "../src/core/repository";

function fakeFs(entries: Record<string, string | "DIR">): FsProbe {
  return {
    kind: (f) => (entries[f] === undefined ? undefined : entries[f] === "DIR" ? "dir" : "file"),
    read: (f) => (entries[f] === undefined || entries[f] === "DIR" ? undefined : entries[f]),
  };
}

const realFs: FsProbe = {
  kind(f) {
    try {
      const st = fs.statSync(f);
      return st.isDirectory() ? "dir" : "file";
    } catch {
      return undefined;
    }
  },
  read(f) {
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return undefined;
    }
  },
};

describe("repository detection (synthetic)", () => {
  it("parses gitdir pointers", () => {
    assert.equal(parseGitFile("gitdir: /r/.git/worktrees/x\n"), "/r/.git/worktrees/x");
    assert.equal(parseGitFile("nonsense"), null);
  });

  it("classifies a .git directory as a local repository", () => {
    const r = classifyRepository("/r", fakeFs({ "/r/.git": "DIR" }));
    assert.equal(r.kind, "local");
  });

  it("classifies a worktree .git file and derives the main working tree", () => {
    const r = classifyRepository("/wt", fakeFs({ "/wt/.git": "gitdir: /main/.git/worktrees/feature\n" }));
    assert.deepEqual(r, { kind: "worktree", root: "/wt", mainWorktree: "/main" });
  });

  it("treats a submodule .git file as local", () => {
    const r = classifyRepository(
      "/super/lib",
      fakeFs({ "/super/lib/.git": "gitdir: ../.git/modules/lib\n" }),
    );
    assert.equal(r.kind, "local");
  });

  it("reports unknown for an unrecognized .git file", () => {
    assert.equal(classifyRepository("/x", fakeFs({ "/x/.git": "garbage" })).kind, "unknown");
  });

  it("walks up to the repository root from a subfolder", () => {
    const r = detectRepository("/r/a/b", fakeFs({ "/r/.git": "DIR" }));
    assert.equal(r.root, "/r");
  });

  it("reports not-git when there is no repository", () => {
    assert.equal(detectRepository("/plain/dir", fakeFs({})).kind, "not-git");
  });

  it("reads branch and detached HEAD", () => {
    assert.deepEqual(
      readHead("/r", fakeFs({ "/r/.git": "DIR", "/r/.git/HEAD": "ref: refs/heads/release/1.0-staging\n" })),
      {
        branch: "release/1.0-staging",
        detachedAt: null,
      },
    );
    assert.deepEqual(
      readHead(
        "/r",
        fakeFs({ "/r/.git": "DIR", "/r/.git/HEAD": "1a2b3c4f00000000000000000000000000000000\n" }),
      ),
      {
        branch: null,
        detachedAt: "1a2b3c4",
      },
    );
  });
});

describe("repository detection (real git)", () => {
  let dir = "";
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir },
    })
      .toString()
      .trim();

  before(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-repo-")));
    const main = path.join(dir, "main");
    fs.mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(main, "a.txt"), "a\n");
    git(main, "add", ".");
    git(main, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
    git(main, "worktree", "add", "-q", "-b", "feature/x", path.join(dir, "wt"));
    fs.mkdirSync(path.join(dir, "wt", "sub"));
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("detects the main working tree as a local repository on its branch", () => {
    const main = path.join(dir, "main");
    const r = detectRepository(main, realFs);
    assert.equal(r.kind, "local");
    assert.equal(readHead(r.root!, realFs).branch, "main");
  });

  it("detects a secondary worktree, its branch and the main working tree", () => {
    const r = detectRepository(path.join(dir, "wt", "sub"), realFs);
    assert.equal(r.kind, "worktree");
    assert.equal(r.root, path.join(dir, "wt"));
    assert.equal(r.mainWorktree, path.join(dir, "main"));
    assert.equal(readHead(r.root!, realFs).branch, "feature/x");
  });

  it("reports a detached HEAD in a worktree", () => {
    const wt = path.join(dir, "wt");
    git(wt, "checkout", "-q", "--detach");
    const h = readHead(wt, realFs);
    assert.equal(h.branch, null);
    assert.match(h.detachedAt ?? "", /^[0-9a-f]{7}$/);
  });
});
