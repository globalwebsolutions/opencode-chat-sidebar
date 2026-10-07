// Launches isolated VS Code Extension Development Hosts (temporary user-data
// and extensions dirs) and runs the acceptance scenarios against the real local
// OpenCode service.
//
//   npm run test:acceptance                 # fixture + worktree scenarios
//   ACCEPT_REAL_REPO=/path/to/repo ACCEPT_REAL_FILE=src/some/file.ts \
//     npm run test:acceptance             # also the read-only real-repo scenario
//   ACCEPT_ONLY_REAL=1                    # skip the fixture/worktree scenarios
//
// The real-repo scenario is read-only: it uses OpenCode's `plan` agent (edits
// denied) and verifies the repository's git state is byte-for-byte unchanged.

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

const root = path.resolve(__dirname, "../../..");
const vscodeExecutablePath =
  process.env.VSCODE_EXECUTABLE ??
  (process.platform === "darwin" ? "/Applications/Visual Studio Code.app/Contents/MacOS/Code" : undefined);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

/** Fingerprint of a repository's working state (read-only git plumbing). */
function fingerprint(repo: string): string {
  const parts = [
    git(repo, "rev-parse", "HEAD"),
    git(repo, "symbolic-ref", "-q", "HEAD"),
    git(repo, "status", "--porcelain=v1", "-uall"),
    git(repo, "diff", "--no-ext-diff"),
    git(repo, "diff", "--cached", "--no-ext-diff"),
    git(repo, "stash", "list"),
  ];
  return crypto.createHash("sha256").update(parts.join("\0")).digest("hex");
}

function makeFixture(base: string): { repo: string; worktree: string } {
  const repo = path.join(base, "fixture-repo");
  fs.mkdirSync(repo, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n");
  g("add", ".");
  g("commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, ".env"), "DUMMY_FIXTURE_VALUE=not-a-secret\n");
  const worktree = path.join(base, "fixture-wt");
  g("worktree", "add", "-q", "-b", "feature/wt", worktree);
  return { repo, worktree };
}

const userDataDirs: string[] = [];

async function runScenario(
  scenario: string,
  workspace: string,
  base: string,
): Promise<{ ok: boolean; report: unknown }> {
  const report = path.join(base, `report-${scenario}.json`);
  // macOS limits IPC socket paths to ~104 chars, so the user-data dir lives in a short temp path.
  const shortTmp = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const userData = fs.mkdtempSync(path.join(shortTmp, `ocs-${scenario.slice(0, 3)}-`));
  userDataDirs.push(userData);
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, "suite.js"),
      launchArgs: [
        workspace,
        "--disable-extensions",
        "--skip-welcome",
        "--skip-release-notes",
        `--user-data-dir=${userData}`,
        `--extensions-dir=${path.join(base, "extensions")}`,
      ],
      extensionTestsEnv: {
        ACCEPT_SCENARIO: scenario,
        ACCEPT_REPORT: report,
        ACCEPT_EXPECT_BRANCH: git(workspace, "rev-parse", "--abbrev-ref", "HEAD").trim(),
        ACCEPT_EXPECT_NAME: path.basename(workspace),
        ACCEPT_REAL_FILE: process.env.ACCEPT_REAL_FILE ?? "",
        ACCEPT_REAL_LINES: process.env.ACCEPT_REAL_LINES ?? "20-27",
        ACCEPT_MODEL: process.env.ACCEPT_MODEL ?? "opencode-go/kimi-k2.7-code",
      },
    });
    return { ok: true, report: JSON.parse(fs.readFileSync(report, "utf8")) };
  } catch {
    return { ok: false, report: fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, "utf8")) : null };
  }
}

/** Confirms the extension never persisted the OpenCode service password. */
function scanForSecret(dir: string, secret: string): string[] {
  const hits: string[] = [];
  const needles = [Buffer.from(secret), Buffer.from(Buffer.from("opencode:" + secret).toString("base64"))];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && fs.statSync(p).size < 50 * 1024 * 1024) {
        const buf = fs.readFileSync(p);
        if (needles.some((n) => buf.includes(n))) hits.push(p);
      }
    }
  };
  walk(dir);
  return hits;
}

async function main(): Promise<void> {
  // When launched from a VS Code terminal these leak into the child and make the
  // Code binary behave as plain Node.
  for (const k of Object.keys(process.env))
    if (k === "ELECTRON_RUN_AS_NODE" || k.startsWith("VSCODE_")) delete process.env[k];
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ocs-accept-")));
  const { repo, worktree } = makeFixture(base);
  const summary: Record<string, unknown> = { base };
  let failed = false;

  const real = process.env.ACCEPT_REAL_REPO;
  if (real) {
    const before = fingerprint(real);
    const r = await runScenario("real-repo", real, base);
    const after = fingerprint(real);
    summary.realRepo = { ...r, repositoryUnchanged: before === after };
    if (!r.ok || before !== after) failed = true;
  }
  for (const [name, ws] of (process.env.ACCEPT_ONLY_REAL
    ? []
    : [
        ["fixture", repo],
        ["worktree", worktree],
      ]) as Array<readonly [string, string]>) {
    const r = await runScenario(name, ws, base);
    summary[name] = r;
    if (!r.ok) failed = true;
  }

  const servicePath = path.join(
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
    "opencode",
    "service.json",
  );
  try {
    const password = JSON.parse(fs.readFileSync(servicePath, "utf8")).password as string | undefined;
    if (password) {
      const hits = [base, ...userDataDirs].flatMap((d) => scanForSecret(d, password));
      summary.credentialScan = { scanned: [base, ...userDataDirs], hits };
      if (hits.length) failed = true;
    }
  } catch {
    summary.credentialScan = "skipped (no service registration)";
  }

  const out = path.join(root, "out-test", "acceptance-summary.json");
  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`\nAcceptance summary written to ${out}`);
  if (failed) {
    console.error("Acceptance FAILED");
    process.exit(1);
  }
  console.log("Acceptance PASSED");
}

void main();
