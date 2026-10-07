// Runs inside a VS Code Extension Development Host launched by runAcceptance.ts.
// Drives the real extension (same message handlers the webview uses) against
// the real local OpenCode service. Scenario is selected by ACCEPT_SCENARIO.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { TranscriptItem, UiEvent } from "../../src/shared/model";
import type { WebviewMessage } from "../../src/shared/protocol";

interface TestApi {
  controller(): import("../../src/core/sessionController").SessionController | undefined;
  connection(): { kind: string };
  workspace(): import("../../src/shared/model").WorkspaceInfo;
  attachments(): import("../../src/shared/model").ContextAttachment[];
  viewState(): import("../../src/shared/protocol").ViewState;
  handle(msg: WebviewMessage): Promise<void>;
  ensureStarted(): Promise<void>;
  tap(fn: (events: UiEvent[]) => void): { dispose(): void };
}

const MODEL = process.env.ACCEPT_MODEL ?? "opencode-go/kimi-k2.7-code";
const results: Array<{ step: string; ok: boolean; detail: string }> = [];
const events: UiEvent[] = [];

function check(step: string, ok: boolean, detail = ""): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? "  — " + detail : ""}`);
}

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function items(api: TestApi): TranscriptItem[] {
  return api.controller()?.transcript.items ?? [];
}

async function sendAndWait(
  api: TestApi,
  text: string,
  timeoutMs = 240_000,
): Promise<{ outcome: string; since: number }> {
  const since = events.length;
  await api.handle({ type: "send", text });
  const idle = await waitFor(
    "session idle",
    () =>
      events
        .slice(since)
        .find((e): e is Extract<UiEvent, { type: "session.idle" }> => e.type === "session.idle"),
    timeoutMs,
  );
  return { outcome: idle.outcome, since };
}

function toolsSince(api: TestApi, sinceItems: number) {
  return items(api)
    .slice(sinceItems)
    .filter((i): i is Extract<TranscriptItem, { kind: "tool" }> => i.kind === "tool");
}

function lastAssistantText(api: TestApi): string {
  const a = [...items(api)].reverse().find((i) => i.kind === "assistant");
  return a?.kind === "assistant" ? a.text : "";
}

async function common(api: TestApi): Promise<void> {
  await vscode.commands.executeCommand("opencodeSidebar.focusChat");
  await api.ensureStarted();
  await waitFor("connection", () => api.connection().kind === "connected", 30_000);
  check("OpenCode connection", true, JSON.stringify(api.viewState().connection));
  await waitFor("models", () => (api.controller()?.models?.length ?? 0) > 0, 30_000);
  const st = api.viewState();
  check(
    "Models load dynamically",
    (st.models?.length ?? 0) > 0,
    `${st.models?.length} models, e.g. ${st.models
      ?.slice(0, 3)
      .map((m) => m.key)
      .join(", ")}`,
  );
  check(
    "Agents load dynamically",
    (st.agents?.length ?? 0) > 0,
    (st.agents ?? []).map((a) => a.id).join(", "),
  );
  await api.handle({ type: "selectModel", key: MODEL });
  check("Model selection", api.viewState().selectedModel === MODEL, String(api.viewState().selectedModel));
}

// ----------------------------------------------------------- real repository (read-only)

async function realRepo(api: TestApi): Promise<void> {
  await common(api);
  const ws = api.workspace();
  check(
    "Workspace name",
    !!ws.active && ws.active.name === process.env.ACCEPT_EXPECT_NAME,
    String(ws.active?.name),
  );
  const expectedBranch = process.env.ACCEPT_EXPECT_BRANCH;
  check("Git branch", !!ws.branch && ws.branch === expectedBranch, `${ws.branch} (git: ${expectedBranch})`);
  check("Repository type", ws.repoKind === "local", ws.repoKind);

  // Read-only safety: Plan agent denies all edits in OpenCode's own permission rules.
  await api.handle({ type: "selectAgent", id: "plan" });
  check("Agent selection (plan, edit-denied)", api.viewState().selectedAgent === "plan");

  await api.handle({ type: "newSession" });
  let mark = items(api).length;
  const r1 = await sendAndWait(api, "Run git status only. Do not modify anything.");
  const sid = api.controller()?.current?.id;
  check("New session created", !!sid, String(sid));
  const deltas = events.slice(r1.since).filter((e) => e.type === "assistant.delta").length;
  check(
    "Streamed answer",
    deltas > 0 && lastAssistantText(api).length > 0,
    `${deltas} deltas; answer: ${lastAssistantText(api).slice(0, 160).replace(/\n/g, " ")}`,
  );
  const shells = toolsSince(api, mark).filter((t) => t.category === "shell");
  const gitStatus = shells.find((t) => /git\s+status/.test(t.detail.command ?? ""));
  check(
    "Shell activity rendered",
    !!gitStatus,
    shells.map((s) => `${s.status}: ${s.detail.command} (cwd ${s.detail.cwd})`).join(" | "),
  );
  check(
    "Shell ran in the correct workspace",
    !!gitStatus && (gitStatus.detail.cwd === null || gitStatus.detail.cwd === ws.active?.path),
    String(gitStatus?.detail.cwd),
  );
  check(
    "Shell output mentions the branch",
    !!expectedBranch && !!gitStatus?.detail.output?.includes(expectedBranch),
    (gitStatus?.detail.output ?? "").split("\n")[0],
  );
  const nonReadOnly = toolsSince(api, mark).filter((t) => t.category === "edit");
  check("No edit tools used", nonReadOnly.length === 0, nonReadOnly.map((t) => t.title).join(", "));

  // Context: current file + selection.
  const relFile = process.env.ACCEPT_REAL_FILE;
  if (!relFile) throw new Error("ACCEPT_REAL_FILE is required for the real-repo scenario");
  const fileBase = path.basename(relFile);
  const doc = await vscode.workspace.openTextDocument(path.join(ws.active!.path, relFile));
  const editor = await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand("opencodeSidebar.addCurrentFile");
  const [startLine, endLine] = (process.env.ACCEPT_REAL_LINES ?? "20-27").split("-").map(Number);
  editor.selection = new vscode.Selection(startLine - 1, 0, endLine - 1, doc.lineAt(endLine - 1).text.length);
  await vscode.commands.executeCommand("opencodeSidebar.addSelection");
  const chips = api.viewState().attachments.map((a) => a.label);
  check(
    "Context chips (current file + selection)",
    chips.includes(fileBase) && chips.includes(`${fileBase}:${startLine}-${endLine}`),
    chips.join(", "),
  );
  mark = items(api).length;
  await sendAndWait(
    api,
    "Explain only the selected code in two or three sentences. Do not run tools and do not modify anything.",
  );
  const user = items(api)
    .slice(mark)
    .find((i) => i.kind === "user");
  check(
    "Context sent with the prompt",
    user?.kind === "user" &&
      user.attachments.includes(fileBase) &&
      user.attachments.includes(`${fileBase}:${startLine}-${endLine}`),
    user?.kind === "user" ? `text="${user.text}" attachments=${user.attachments.join(", ")}` : "no user item",
  );
  check("Attachments cleared after send", api.viewState().attachments.length === 0);
  check(
    "Explanation streamed",
    lastAssistantText(api).length > 40,
    lastAssistantText(api).slice(0, 200).replace(/\n/g, " "),
  );

  // Harmless permission: reading a file outside the workspace triggers OpenCode's external_directory "ask" rule.
  const outside = path.resolve(__dirname, "../../../package.json");
  const since = events.length;
  await api.handle({
    type: "send",
    text: `Read the file ${outside} and reply with only the value of its "name" field. Do not modify anything.`,
  });
  const asked = await waitFor(
    "permission request",
    () =>
      events
        .slice(since)
        .find(
          (e): e is Extract<UiEvent, { type: "permission.requested" }> => e.type === "permission.requested",
        ),
    180_000,
  );
  check(
    "Permission request rendered",
    true,
    `${asked.request.action}: ${asked.request.resources.join(", ")} (always offered: ${asked.request.canAlways})`,
  );
  await api.handle({ type: "respondPermission", requestId: asked.request.id, decision: "once" });
  const perm = items(api).find((i) => i.id === `perm:${asked.request.id}`);
  check(
    "Permission approved once from the sidebar",
    perm?.kind === "permission" && perm.status === "once",
    perm?.kind === "permission" ? perm.status : "missing",
  );
  await waitFor(
    "idle after permission",
    () => events.slice(since).some((e) => e.type === "session.idle"),
    180_000,
  );
  check(
    "Answer after approval",
    lastAssistantText(api).includes("opencode-sidebar"),
    lastAssistantText(api).slice(0, 120),
  );

  // Session continuation: reload from OpenCode's own history.
  await api.handle({ type: "refreshSessions" });
  const listed = api.viewState().sessions.find((s) => s.id === sid);
  check(
    "Session listed for this workspace",
    !!listed,
    listed ? `${listed.title} · ${listed.modelKey} · ${listed.agent}` : "",
  );
  await api.handle({ type: "newSession" });
  await api.handle({ type: "selectSession", id: sid! });
  const users = items(api).filter((i) => i.kind === "user").length;
  check(
    "Existing session continuation (history replay)",
    api.controller()?.current?.id === sid && users >= 3,
    `${users} user messages restored`,
  );
  const usage = api.viewState().usage;
  check("Usage display", !!usage?.contextTokens, JSON.stringify(usage));
}

// ----------------------------------------------------------- fixture (edits/diff/stop)

async function fixture(api: TestApi): Promise<void> {
  await common(api);
  const ws = api.workspace();
  check(
    "Fixture workspace detected",
    ws.repoKind === "local" && ws.branch === "main",
    `${ws.repoKind} ${ws.branch}`,
  );
  await api.handle({ type: "selectAgent", id: "build" });
  await api.handle({ type: "newSession" });

  let mark = items(api).length;
  const r = await sendAndWait(
    api,
    "Append a new line containing exactly the word world to the file a.txt using your edit tool. Do nothing else.",
  );
  check("Edit task finished", r.outcome === "succeeded", r.outcome);
  const summary = items(api)
    .slice(mark)
    .find((i) => i.kind === "turn-summary");
  check(
    "Edited-files summary",
    summary?.kind === "turn-summary" && summary.files.some((f) => f.path === "a.txt" && f.additions >= 1),
    JSON.stringify(summary?.kind === "turn-summary" ? summary.files : null),
  );
  await waitFor("changes panel", () => api.viewState().changes.length > 0, 10_000);
  check(
    "Changed-files panel",
    api.viewState().changes.some((c) => c.path === "a.txt"),
    JSON.stringify(api.viewState().changes),
  );
  await api.handle({ type: "openDiff", path: "a.txt" });
  await new Promise((r) => setTimeout(r, 800));
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  check(
    "Native diff editor opened",
    tab?.input instanceof vscode.TabInputTextDiff,
    `${tab?.label} (${tab?.input?.constructor.name})`,
  );
  await api.handle({ type: "openAllDiffs" });
  await new Promise((r) => setTimeout(r, 800));
  const tab2 = vscode.window.tabGroups.activeTabGroup.activeTab;
  check(
    "Multi-file native diff (View Diff)",
    !!tab2 && tab2.label.includes("OpenCode session changes"),
    `${tab2?.label}`,
  );

  // Sensitive permission + deny.
  mark = items(api).length;
  let since = events.length;
  await api.handle({
    type: "send",
    text: "Read the file .env in this directory and tell me how many lines it has. Do not modify anything.",
  });
  const asked = await waitFor(
    "permission",
    () =>
      events
        .slice(since)
        .find(
          (e): e is Extract<UiEvent, { type: "permission.requested" }> => e.type === "permission.requested",
        ),
    180_000,
  );
  check("Sensitive-path warning on permission card", asked.sensitive.length > 0, asked.sensitive.join("; "));
  await api.handle({ type: "respondPermission", requestId: asked.request.id, decision: "reject" });
  await waitFor("idle after deny", () => events.slice(since).some((e) => e.type === "session.idle"), 180_000);
  const denied = items(api).find((i) => i.id === `perm:${asked.request.id}`);
  check("Permission denied from the sidebar", denied?.kind === "permission" && denied.status === "reject");

  // Stop must cancel the real work.
  since = events.length;
  mark = items(api).length;
  await api.handle({
    type: "send",
    text: "Run the shell command `sleep 120 && echo finished` and wait for it to complete. Do not do anything else.",
  });
  await waitFor(
    "sleep to start",
    () =>
      toolsSince(api, mark).find(
        (t) =>
          t.category === "shell" &&
          /sleep 120/.test(t.detail.command ?? "") &&
          t.status === "running" &&
          t.detail.cwd,
      ),
    180_000,
  );
  await new Promise((r) => setTimeout(r, 1500));
  const running = psHas("sleep 120");
  const t0 = Date.now();
  await api.handle({ type: "stop" });
  const idle = await waitFor(
    "interrupted",
    () =>
      events
        .slice(since)
        .find((e): e is Extract<UiEvent, { type: "session.idle" }> => e.type === "session.idle"),
    30_000,
  );
  const elapsed = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 500));
  check(
    "Stop cancels via OpenCode interrupt",
    idle.outcome === "interrupted" && elapsed < 15_000,
    `outcome=${idle.outcome} after ${elapsed}ms`,
  );
  check(
    "Cancelled process is gone",
    running && !psHas("sleep 120"),
    `before=${running} after=${psHas("sleep 120")}`,
  );
  check("UI no longer busy after stop", api.viewState().busy === false && api.viewState().stopping === false);
}

function psHas(needle: string): boolean {
  try {
    return execFileSync("ps", ["-axo", "command"])
      .toString()
      .split("\n")
      .some((l) => l.includes(needle) && !l.includes("ps -axo"));
  } catch {
    return false;
  }
}

// ----------------------------------------------------------- worktree header

async function worktree(api: TestApi): Promise<void> {
  await vscode.commands.executeCommand("opencodeSidebar.focusChat");
  await api.ensureStarted();
  await waitFor("workspace", () => api.workspace().active, 10_000);
  const ws = api.workspace();
  check("Secondary worktree detected", ws.repoKind === "worktree", `${ws.repoKind}; main=${ws.mainWorktree}`);
  check("Worktree branch", ws.branch === "feature/wt", String(ws.branch));
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === "opencode-sidebar");
  if (!ext) throw new Error("extension not found");
  const exports = (await ext.activate()) as { testApi: TestApi };
  const api = exports.testApi;
  const tap = api.tap((evs) => events.push(...evs));
  const scenario = process.env.ACCEPT_SCENARIO;
  try {
    if (scenario === "real-repo") await realRepo(api);
    else if (scenario === "fixture") await fixture(api);
    else if (scenario === "worktree") await worktree(api);
    else throw new Error(`unknown scenario ${scenario}`);
  } catch (e) {
    check("Scenario completed", false, e instanceof Error ? e.message : String(e));
  } finally {
    tap.dispose();
    const report = process.env.ACCEPT_REPORT;
    if (report)
      fs.writeFileSync(
        report,
        JSON.stringify(
          { scenario, results, sessionId: exports.testApi.controller()?.current?.id ?? null },
          null,
          2,
        ),
      );
  }
  if (results.some((r) => !r.ok))
    throw new Error(`${results.filter((r) => !r.ok).length} acceptance check(s) failed`);
}
