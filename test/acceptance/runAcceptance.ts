// Launches isolated VS Code Extension Development Hosts (temporary user-data
// and extensions dirs) and runs the acceptance scenarios against the real local
// OpenCode service.
//
//   npm run test:acceptance                 # fixture + worktree scenarios
//   ACCEPT_REAL_REPO=/path/to/repo ACCEPT_REAL_FILE=src/some/file.ts \
//     npm run test:acceptance             # also the read-only real-repo scenario
//   ACCEPT_ONLY_REAL=1                    # skip the fixture/worktree scenarios
//   ACCEPT_ONBOARDING=1                   # also the v0.3 onboarding / easy-open scenarios
//   ACCEPT_ONBOARDING_ONLY=1              # only those
//
// Onboarding scenarios never touch the user's OpenCode account: states that need a
// missing CLI, a stopped service, no account or no models use temporary, isolated
// `opencode serve` instances (own HOME/XDG dirs, no inherited API keys), and the
// only check against the real service is read-only.
//
// The real-repo scenario is read-only: it uses OpenCode's `plan` agent (edits
// denied) and verifies the repository's git state is byte-for-byte unchanged.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

const root = path.resolve(__dirname, "../../..");
const vscodeExecutablePath =
  process.env.VSCODE_EXECUTABLE ??
  (process.platform === "darwin" ? "/Applications/Visual Studio Code.app/Contents/MacOS/Code" : undefined);

function git(cwd: string, ...args: string[]): string {
  // Never take optional index locks: the repository may be in use by another agent.
  return execFileSync("git", ["--no-optional-locks", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).toString();
}

/** Other OpenCode sessions currently running in `dir` (read-only API query). */
async function activeSessionsIn(dir: string): Promise<string[]> {
  try {
    const svc = JSON.parse(
      fs.readFileSync(
        path.join(
          process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
          "opencode",
          "service.json",
        ),
        "utf8",
      ),
    );
    const headers = { authorization: "Basic " + Buffer.from("opencode:" + svc.password).toString("base64") };
    const active = (await (await fetch(new URL("/api/session/active", svc.url), { headers })).json()) as {
      data: Record<string, unknown>;
    };
    const out: string[] = [];
    for (const id of Object.keys(active.data ?? {})) {
      const s = (await (await fetch(new URL(`/api/session/${id}`, svc.url), { headers })).json()) as {
        data?: { location?: { directory?: string } };
      };
      if (s.data?.location?.directory === dir) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
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
  fs.writeFileSync(path.join(repo, "b.txt"), "unrelated file\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n");
  g("add", ".");
  g("commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, ".env"), "DUMMY_FIXTURE_VALUE=not-a-secret\n");
  const worktree = path.join(base, "fixture-wt");
  g("worktree", "add", "-q", "-b", "feature/wt", worktree);
  return { repo, worktree };
}

const userDataDirs: string[] = [];

interface ScenarioOptions {
  /** VS Code user settings for the test window. */
  settings?: Record<string, unknown>;
  /** Extra environment for the test window (and its terminals). */
  env?: Record<string, string>;
  /** Reuse a previous scenario's user-data dir (a "reload" of the same profile). */
  userData?: string;
  /** Open VS Code without a folder. */
  noFolder?: boolean;
}

async function runScenario(
  scenario: string,
  workspace: string,
  base: string,
  opts: ScenarioOptions = {},
): Promise<{ ok: boolean; report: unknown; userData: string }> {
  const report = path.join(base, `report-${scenario}.json`);
  // macOS limits IPC socket paths to ~104 chars, so the user-data dir lives in a short temp path.
  const shortTmp = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const userData = opts.userData ?? fs.mkdtempSync(path.join(shortTmp, `ocs-${scenario.slice(0, 3)}-`));
  if (!opts.userData) userDataDirs.push(userData);
  const settings: Record<string, unknown> = { ...opts.settings };
  if (scenario.startsWith("real-repo")) {
    // Keep VS Code's Git extension out of a repository someone else may be working in.
    settings["git.enabled"] = false;
    settings["git.autorefresh"] = false;
  }
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  const settingsFile = path.join(userData, "User", "settings.json");
  const previous = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : {};
  fs.writeFileSync(settingsFile, JSON.stringify({ ...previous, ...settings }, null, 2));
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, "suite.js"),
      launchArgs: [
        ...(opts.noFolder ? [] : [workspace]),
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
        ...opts.env,
      },
    });
    return { ok: true, report: JSON.parse(fs.readFileSync(report, "utf8")), userData };
  } catch {
    return {
      ok: false,
      report: fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, "utf8")) : null,
      userData,
    };
  }
}

// ------------------------------------------------------ isolated OpenCode servers

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

interface IsolatedServer {
  url: string;
  dir: string;
  proc: ChildProcess;
}

/**
 * Starts `opencode serve` with its own HOME/XDG dirs and a minimal environment (no provider
 * API keys), so it has no account, no credentials and no access to the user's OpenCode data.
 */
async function startIsolatedOpenCode(
  cli: string,
  base: string,
  name: string,
  password: string,
  config: Record<string, unknown>,
): Promise<IsolatedServer> {
  const dir = path.join(base, `oc-${name}`);
  for (const d of ["home", "config/opencode", "data", "state", "cache"])
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config", "opencode", "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  );
  const port = await freePort();
  const log = fs.openSync(path.join(dir, "serve.log"), "w");
  const proc = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: path.join(dir, "home"),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: path.join(dir, "home"),
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_DATA_HOME: path.join(dir, "data"),
      XDG_STATE_HOME: path.join(dir, "state"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: ["ignore", log, log],
  });
  const url = `http://127.0.0.1:${port}`;
  const auth = { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") };
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if ((await fetch(new URL("/api/info", url), { headers: auth })).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline || proc.exitCode !== null)
      throw new Error(`isolated OpenCode ${name} did not start`);
    await new Promise((r) => setTimeout(r, 500));
  }
  return { url, dir, proc };
}

/** v0.3 onboarding and easy-open scenarios (A–G). */
async function onboardingScenarios(base: string, repo: string, summary: Record<string, unknown>) {
  const cli = execFileSync("/bin/sh", ["-c", "command -v opencode"]).toString().trim();
  const password = crypto.randomBytes(18).toString("base64url");
  secrets.push(password);
  const servers: IsolatedServer[] = [];
  let failed = false;
  try {
    // "free": a fresh OpenCode with its default free models and no account.
    const free = await startIsolatedOpenCode(cli, base, "free", password, {});
    servers.push(free);
    // "bare": no account and no models (the built-in OpenCode provider disabled). OpenAI is
    // disabled too, so a connected OpenAI key yields "connected but no models".
    const bare = await startIsolatedOpenCode(cli, base, "bare", password, {
      disabled_providers: ["opencode", "openai"],
    });
    servers.push(bare);
    // Warm the free server's catalog for the fixture folder (a cold location briefly lists no models).
    const auth = { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") };
    const modelsUrl = `${free.url}/api/model?location%5Bdirectory%5D=${encodeURIComponent(repo)}`;
    for (let i = 0; i < 60; i++) {
      const list = (await (await fetch(modelsUrl, { headers: auth })).json()) as { data?: unknown[] };
      if (list.data?.length) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const dead = `http://127.0.0.1:${await freePort()}`;
    const env = {
      OPENCODE_SERVER_PASSWORD: password,
      ACCEPT_CLI: cli,
      ACCEPT_FREE_URL: free.url,
      ACCEPT_BARE_URL: bare.url,
      ACCEPT_DEAD_URL: dead,
    };
    const runs: Array<[string, ScenarioOptions]> = [
      [
        "onb-a-missing",
        {
          env,
          settings: {
            "opencodeSidebar.executablePath": path.join(base, "no-such", "opencode"),
            "opencodeSidebar.serverUrl": dead,
          },
        },
      ],
      [
        "onb-b-stopped",
        { env, settings: { "opencodeSidebar.executablePath": cli, "opencodeSidebar.serverUrl": dead } },
      ],
      ["onb-c-signin", { env, settings: { "opencodeSidebar.serverUrl": bare.url } }],
      ["onb-f-nofolder", { env, noFolder: true, settings: { "opencodeSidebar.serverUrl": free.url } }],
      // Read-only against the user's real OpenCode service: a configured user sees no onboarding.
      ["onb-e-ready", { env: { ACCEPT_CLI: cli } }],
      ["easy-open", { env, settings: { "opencodeSidebar.serverUrl": free.url } }],
    ];
    let easyProfile: string | undefined;
    // ACCEPT_ONBOARDING_FILTER=onb-c runs only matching scenarios (for debugging).
    const filter = process.env.ACCEPT_ONBOARDING_FILTER;
    for (const [name, opts] of runs) {
      if (filter && !name.includes(filter)) continue;
      const r = await runScenario(name, repo, base, opts);
      summary[name] = { ok: r.ok, report: r.report };
      if (!r.ok) failed = true;
      if (name === "easy-open") easyProfile = r.userData;
    }
    if (filter && !"easy-open-reload".includes(filter)) return failed;
    // Same profile again: the moved view, the Status Bar item and Focus Chat after a reload.
    const reload = await runScenario("easy-open-reload", repo, base, {
      env,
      userData: easyProfile,
      settings: { "opencodeSidebar.serverUrl": free.url },
    });
    summary["easy-open-reload"] = { ok: reload.ok, report: reload.report };
    if (!reload.ok) failed = true;
  } finally {
    for (const s of servers) s.proc.kill();
  }
  return failed;
}

/** Secrets that must never be persisted by the extension (scanned for at the end). */
const secrets: string[] = [];

/** Confirms the extension never persisted the OpenCode service password. */
function scanForSecret(dir: string, secret: string, skip: (p: string) => boolean = () => false): string[] {
  const hits: string[] = [];
  const needles = [Buffer.from(secret), Buffer.from(Buffer.from("opencode:" + secret).toString("base64"))];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (skip(p + (entry.isDirectory() ? "/" : ""))) continue;
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
    if (process.env.ACCEPT_REAL_TASK) {
      const r = await runScenario("real-repo-task", real, base);
      summary.realRepoTask = r;
      if (!r.ok) failed = true;
    }
    if (!process.env.ACCEPT_REAL_TASK_ONLY) {
      const concurrentBefore = await activeSessionsIn(real);
      const before = fingerprint(real);
      const r = await runScenario("real-repo", real, base);
      const after = fingerprint(real);
      const concurrent = [...new Set([...concurrentBefore, ...(await activeSessionsIn(real))])];
      // With another agent working in the repository, the fingerprint cannot prove anything about
      // this run; the suite instead verifies OpenCode's snapshot diff of every session it created.
      summary.realRepo = { ...r, repositoryUnchanged: before === after, concurrentSessions: concurrent };
      if (!r.ok || (before !== after && concurrent.length === 0)) failed = true;
    }
  }
  if (process.env.ACCEPT_ONBOARDING || process.env.ACCEPT_ONBOARDING_ONLY) {
    if (await onboardingScenarios(base, repo, summary)) failed = true;
  }
  for (const [name, ws] of (process.env.ACCEPT_ONLY_REAL || process.env.ACCEPT_ONBOARDING_ONLY
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
      // The isolated servers' own data dirs legitimately hold their test keys; skip them.
      const dirs = [base, ...userDataDirs];
      const hits = [password, ...secrets].flatMap((secret) =>
        dirs.flatMap((d) => scanForSecret(d, secret, (p) => /\/oc-(free|bare)\//.test(p))),
      );
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
