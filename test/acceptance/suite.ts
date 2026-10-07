// Runs inside a VS Code Extension Development Host launched by runAcceptance.ts.
// Drives the real extension (same message handlers the webview uses) against
// the real local OpenCode service. Scenario is selected by ACCEPT_SCENARIO.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { summarizeTask } from "../../src/core/currentTask";
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
  setNotifier(
    fn: (severity: string, message: string, actions: string[]) => Thenable<string | undefined>,
  ): void;
  viewVisible(): boolean;
}

const MODEL = process.env.ACCEPT_MODEL ?? "opencode-go/kimi-k2.7-code";
const results: Array<{ step: string; ok: boolean; detail: string }> = [];
const events: UiEvent[] = [];
/** Every OpenCode session this run created or used (for the read-only proof). */
const touchedSessions = new Set<string>();

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
  // OpenCode's provider catalog can change briefly (e.g. while it refreshes models.dev);
  // if the requested model is not offered yet, reload the catalog and try again.
  for (let attempt = 0; attempt < 3 && api.viewState().selectedModel !== MODEL; attempt++) {
    console.log(
      `model ${MODEL} not offered yet (${(api.viewState().models ?? []).length} models); reloading catalog`,
    );
    await new Promise((r) => setTimeout(r, 5000));
    await api.handle({ type: "retry" });
    await waitFor("connection", () => api.connection().kind === "connected", 30_000);
    await waitFor("models", () => (api.controller()?.models?.length ?? 0) > 0, 30_000);
    await api.handle({ type: "selectModel", key: MODEL });
  }
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
  const r1 = await sendAndWait(api, "Run `git --no-optional-locks status` only. Do not modify anything.");
  const sid = api.controller()?.current?.id;
  check("New session created", !!sid, String(sid));
  const deltas = events.slice(r1.since).filter((e) => e.type === "assistant.delta").length;
  check(
    "Streamed answer",
    deltas > 0 && lastAssistantText(api).length > 0,
    `${deltas} deltas; answer: ${lastAssistantText(api).slice(0, 160).replace(/\n/g, " ")}`,
  );
  const shells = toolsSince(api, mark).filter((t) => t.category === "shell");
  const gitStatus = shells.find((t) => /git\b.*\bstatus/.test(t.detail.command ?? ""));
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
  await v02RealRepo(api);
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
  const agentFiles = () => {
    const ac = api.viewState().agentChanges;
    return ac.status === "ok" ? ac.files : [];
  };
  await waitFor("changes panel", () => agentFiles().length > 0, 10_000);
  check(
    "Changed-files panel",
    agentFiles().some((c) => c.path === "a.txt"),
    JSON.stringify(api.viewState().agentChanges),
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
    !!tab2 && tab2.label.includes("OpenCode agent changes"),
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
  await v02Fixture(api);
}

// ================================================================== v0.2

async function waitIdle(_api: TestApi, since: number, timeoutMs = 240_000) {
  return waitFor(
    "session idle",
    () =>
      events
        .slice(since)
        .find((e): e is Extract<UiEvent, { type: "session.idle" }> => e.type === "session.idle"),
    timeoutMs,
  );
}

/** Copies an assistant message through the real handler and returns the clipboard text (clipboard restored after). */
async function copyViaUi(api: TestApi, itemId: string): Promise<string> {
  const saved = await vscode.env.clipboard.readText();
  try {
    await api.handle({ type: "copyMessage", itemId, requestId: "accept" });
    return await vscode.env.clipboard.readText();
  } finally {
    await vscode.env.clipboard.writeText(saved);
  }
}

function lastAssistant(api: TestApi): Extract<TranscriptItem, { kind: "assistant" }> | undefined {
  return [...items(api)]
    .reverse()
    .find((i): i is Extract<TranscriptItem, { kind: "assistant" }> => i.kind === "assistant");
}

async function checkFullReportCopy(api: TestApi, prompt: string): Promise<void> {
  const since = events.length;
  await api.handle({ type: "send", text: prompt });
  await waitIdle(api, since);
  const item = lastAssistant(api);
  const sid = api.controller()?.current?.id;
  check(
    "Report has Markdown structure",
    !!item && /^#/m.test(item.text) && /^\s*[-*] /m.test(item.text) && /\|/.test(item.text),
    (item?.text ?? "").slice(0, 120).replace(/\n/g, "⏎"),
  );
  const copied = item ? await copyViaUi(api, item.id) : "";
  check(
    "Full-message Copy equals canonical text",
    !!item && copied === item.text,
    `${copied.length} chars copied`,
  );
  // Reload the session from OpenCode's own storage and compare again.
  await api.handle({ type: "newSession" });
  await api.handle({ type: "selectSession", id: sid! });
  const stored = lastAssistant(api);
  check(
    "Copied Markdown matches OpenCode's stored message exactly",
    !!stored && stored.text === copied,
    `${stored?.text.length} vs ${copied.length}`,
  );
}

async function checkQuestion(api: TestApi, prompt: string, pick: (opts: string[]) => string): Promise<void> {
  const since = events.length;
  await api.handle({ type: "send", text: prompt });
  const req = await waitFor(
    "OpenCode question",
    () =>
      events
        .slice(since)
        .find((e): e is Extract<UiEvent, { type: "form.requested" }> => e.type === "form.requested"),
    180_000,
  );
  const field = req.form.fields[0];
  check(
    "Question card rendered",
    items(api).some((i) => i.id === `form:${req.form.id}` && i.kind === "form" && i.status === "pending"),
    `${req.form.title}: ${field.type === "external" ? "" : (field.title ?? field.key)}`,
  );
  const sid = api.controller()?.current?.id;
  await api.handle({ type: "newSession" });
  await api.handle({ type: "selectSession", id: sid! });
  const restored = items(api).find((i) => i.id === `form:${req.form.id}`);
  check(
    "Pending question survives session reopen",
    restored?.kind === "form" && restored.status === "pending",
  );
  const options =
    field.type === "string" || field.type === "multiselect" ? (field.options ?? []).map((o) => o.value) : [];
  const value = pick(options);
  await api.handle({
    type: "answerForm",
    formId: req.form.id,
    answer: { [field.key]: field.type === "multiselect" ? [value] : value },
  });
  const answered = items(api).find((i) => i.id === `form:${req.form.id}`);
  check(
    "Question answered from the sidebar",
    answered?.kind === "form" && answered.status === "answered",
    value,
  );
  const after = events.length;
  await waitIdle(api, Math.min(since, after));
  check(
    "Agent continued after the answer",
    lastAssistantText(api).length > 0,
    lastAssistantText(api).slice(0, 100).replace(/\n/g, " "),
  );
}

async function v02RealRepo(api: TestApi): Promise<void> {
  const st = api.viewState();
  const providers = new Set((st.models ?? []).map((m) => m.providerName));
  check("v0.2 Model selector grouped by provider", providers.size >= 1, [...providers].join(" | "));
  check(
    "v0.2 Budget UI present",
    !!st.budget && !!st.budgetPresets.small,
    `level=${st.budget.level} small=${JSON.stringify(st.budgetPresets.small)}`,
  );
  await api.handle({ type: "selectAgent", id: "plan" });
  await api.handle({ type: "newSession" });
  await checkFullReportCopy(
    api,
    "Run `git --no-optional-locks status` only, then summarize it as a short Markdown report with a level-1 heading, a bullet list and a two-column table. Do not modify anything.",
  );
  await api.handle({ type: "newSession" });
  await checkQuestion(
    api,
    "Use your question tool to ask me whether I want a short or a detailed answer (two options). After I answer, run `git --no-optional-locks status` only and answer accordingly. Do not modify anything.",
    (opts) => opts.find((o) => /short/i.test(o)) ?? opts[0] ?? "Short",
  );
  // Cancellation still works (read-only command).
  await api.handle({ type: "newSession" });
  const since = events.length;
  const mark = items(api).length;
  await api.handle({
    type: "send",
    text: "Run the shell command `sleep 30` and wait for it to finish. Do not do anything else.",
  });
  await waitFor(
    "sleep running",
    () =>
      toolsSince(api, mark).find((t) => /sleep 30/.test(t.detail.command ?? "") && t.status === "running"),
    180_000,
  );
  await new Promise((r) => setTimeout(r, 1500));
  await api.handle({ type: "stop" });
  const idle = await waitIdle(api, since, 30_000);
  await new Promise((r) => setTimeout(r, 500));
  check("v0.2 Stop still cancels", idle.outcome === "interrupted" && !psHas("sleep 30"), idle.outcome);

  // Session titles: broken generated titles are never shown.
  await api.handle({ type: "refreshSessions" });
  await new Promise((r) => setTimeout(r, 1500));
  const titles = api.viewState().sessions.map((x) => x.title);
  check(
    "No broken generated titles in the session list",
    !titles.some((x) => /title only|massive request/i.test(x)),
    titles.slice(0, 6).join(" | "),
  );

  // Read-only proof that holds even while other agents work in this repository:
  // OpenCode's own snapshot diff of every session this run used must be empty.
  const changed: string[] = [];
  for (const id of touchedSessions) {
    await api.handle({ type: "selectSession", id });
    await api.controller()?.refreshChanges();
    const ac = api.viewState().agentChanges;
    if (ac.status !== "none")
      changed.push(
        `${id}:${ac.status}${ac.status === "ok" ? ":" + ac.files.map((f) => f.path).join(",") : ""}`,
      );
  }
  check(
    "This run changed no files (OpenCode snapshot diff of all its sessions)",
    changed.length === 0 && touchedSessions.size > 0,
    `${touchedSessions.size} sessions checked ${changed.join(" ")}`,
  );
}

async function v02Fixture(api: TestApi): Promise<void> {
  const root = api.workspace().active!.path;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString();

  // --- full-report copy
  await api.handle({ type: "newSession" });
  await checkFullReportCopy(
    api,
    "Write a short Markdown report about this folder with a level-1 heading, a bullet list, a two-column table and a fenced code block. Do not run any tools.",
  );

  // --- agent-only diff on a repository that is already dirty
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qam", "baseline");
  fs.appendFileSync(path.join(root, "a.txt"), "user line\n");
  fs.writeFileSync(path.join(root, "b.txt"), "user change in another file\n");
  await api.handle({ type: "selectAgent", id: "build" });
  await api.handle({ type: "newSession" });
  let since = events.length;
  await api.handle({
    type: "send",
    text: "Append a new last line containing exactly AGENT LINE to the file a.txt using your edit tool. Do not touch any other file.",
  });
  await waitIdle(api, since);
  await waitFor("agent changes", () => api.viewState().agentChanges.status !== "none", 15_000);
  const ac = api.viewState().agentChanges;
  const files = ac.status === "ok" ? ac.files.map((f) => f.path) : [];
  check(
    "Agent changes list only the agent's file (dirty repo, other file)",
    ac.status === "ok" && files.length === 1 && files[0] === "a.txt",
    JSON.stringify(ac),
  );
  // VS Code's Git extension notices external edits asynchronously (it can take 10 s+ for temp
  // folders). Ask it to refresh, as the Source Control "Refresh" button does, then wait.
  await vscode.commands.executeCommand("git.refresh").then(undefined, () => undefined);
  await waitFor(
    "git refresh",
    () => (api.viewState().workspaceChanges?.count ?? 0) >= 2 || undefined,
    30_000,
  ).catch(() => undefined);
  check(
    "Workspace changes counted separately",
    (api.viewState().workspaceChanges?.count ?? 0) >= 2,
    JSON.stringify(api.viewState().workspaceChanges),
  );
  await api.handle({ type: "openAgentDiff", path: "a.txt" });
  await new Promise((r) => setTimeout(r, 1000));
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  const isAgentDiff =
    input instanceof vscode.TabInputTextDiff && input.original.scheme === "opencode-sidebar-agent";
  check("Agent-only diff opens in the native diff editor", isAgentDiff, `${tab?.label}`);
  if (input instanceof vscode.TabInputTextDiff) {
    const before = (await vscode.workspace.openTextDocument(input.original)).getText();
    const afterText = (await vscode.workspace.openTextDocument(input.modified)).getText();
    check(
      "Same-file pre-existing user change is baseline, not attributed to the agent",
      before.includes("user line") &&
        !before.includes("AGENT LINE") &&
        afterText.includes("user line") &&
        afterText.includes("AGENT LINE"),
      JSON.stringify({ before, after: afterText }),
    );
  }
  const sid = api.controller()?.current?.id;
  await api.handle({ type: "newSession" });
  await api.handle({ type: "selectSession", id: sid! });
  await waitFor("changes after reopen", () => api.viewState().agentChanges.status === "ok", 15_000);
  const ac2 = api.viewState().agentChanges;
  check(
    "Agent changes survive session restart",
    ac2.status === "ok" && ac2.files.length === 1 && ac2.files[0].path === "a.txt",
    JSON.stringify(ac2),
  );

  // --- steering and queue (OpenCode inbox delivery)
  await api.handle({ type: "newSession" });
  since = events.length;
  const mark = items(api).length;
  await api.handle({
    type: "send",
    text: "Run the shell command `sleep 12 && echo first` and wait for it, then reply DONE.",
  });
  await waitFor(
    "sleep running",
    () =>
      toolsSince(api, mark).find((t) => /sleep 12/.test(t.detail.command ?? "") && t.status === "running"),
    180_000,
  );
  await api.handle({
    type: "send",
    text: "Steering: after that command, also run `echo steered`.",
    delivery: "steer",
  });
  await api.handle({
    type: "send",
    text: "Queued: then reply with the single word QUEUED.",
    delivery: "queue",
  });
  // Current Task: the running prompt, copied exactly.
  const sleepPrompt = "Run the shell command `sleep 12 && echo first` and wait for it, then reply DONE.";
  const runningTask = api.viewState().task;
  check(
    "Current Task shows the running prompt",
    runningTask?.label === "current" && runningTask.summary === summarizeTask(sleepPrompt),
    JSON.stringify(runningTask),
  );
  const savedClip = await vscode.env.clipboard.readText();
  await api.handle({ type: "copyTaskPrompt", requestId: "task" });
  const copiedPrompt = await vscode.env.clipboard.readText();
  await vscode.env.clipboard.writeText(savedClip);
  check(
    "Copy Prompt copies the exact original prompt",
    copiedPrompt === sleepPrompt,
    copiedPrompt.slice(0, 60),
  );
  await api.handle({ type: "send", text: "Queued2: reply SECOND.", delivery: "queue" });
  await waitFor("3 pending", () => api.viewState().pending.length === 3 || undefined, 10_000).catch(
    () => undefined,
  );
  const pend = api.viewState().pending;
  check(
    "Steer/queue messages shown as pending with their delivery",
    pend.some((p) => p.delivery === "steer") && pend.filter((p) => p.delivery === "queue").length === 2,
    JSON.stringify(pend.map((p) => [p.delivery, p.text.slice(0, 12)])),
  );
  check(
    "Queued prompt shows as Next with a count",
    api.viewState().task?.next?.summary === "Queued: then reply with the single word QUEUED." &&
      api.viewState().task?.next?.more === 1,
    JSON.stringify(api.viewState().task?.next),
  );
  const second = pend.find((p) => p.text.startsWith("Queued2"));
  if (second) await api.handle({ type: "removePending", id: second.id });
  check(
    "Removing a queued message updates Next",
    api.viewState().task?.next?.more === 0,
    JSON.stringify(api.viewState().task?.next),
  );
  await waitFor("steer delivered", () => api.viewState().task?.steer ?? undefined, 120_000).catch(
    () => undefined,
  );
  check(
    "Steer does not replace Current Task",
    api.viewState().task?.id === runningTask?.id && /^Steering:/.test(api.viewState().task?.steer ?? ""),
    JSON.stringify({ id: api.viewState().task?.id, steer: api.viewState().task?.steer }),
  );
  check(
    "Removed queued message is cancelled in OpenCode",
    !api.viewState().pending.some((p) => p.text.startsWith("Queued2")),
  );
  await waitFor(
    "queue drained and idle",
    () =>
      api.viewState().pending.length === 0 &&
      !api.viewState().busy &&
      events.slice(since).some((e) => e.type === "session.idle")
        ? true
        : undefined,
    240_000,
  );
  const users = items(api)
    .filter((i): i is Extract<TranscriptItem, { kind: "user" }> => i.kind === "user")
    .map((u) => u.text);
  const outputs = toolsSince(api, mark)
    .map((t) => t.detail.output ?? "")
    .join("\n");
  check(
    "Steering delivered into the running task",
    users.some((u) => u.startsWith("Steering:")) && outputs.includes("steered"),
    outputs.slice(0, 80).replace(/\n/g, " "),
  );
  check(
    "Queued message delivered after the task",
    users.some((u) => u.startsWith("Queued:")) &&
      /QUEUED/.test(
        items(api)
          .filter((i) => i.kind === "assistant")
          .map((i) => (i.kind === "assistant" ? i.text : ""))
          .join(" "),
      ),
  );
  check("Removed message never delivered", !users.some((u) => u.startsWith("Queued2")));
  const doneTask = api.viewState().task;
  check(
    "Delivered queued prompt became the task; finished task shows as Last Task",
    doneTask?.label === "last" &&
      doneTask.summary.startsWith("Queued: then reply") &&
      doneTask.status === "completed",
    JSON.stringify(doneTask),
  );
  const sqSession = api.controller()?.current?.id;
  await api.handle({ type: "newSession" });
  check("New session shows no task", api.viewState().task === null);
  await api.handle({ type: "selectSession", id: sqSession! });
  check(
    "Session reopen restores the task from OpenCode messages",
    api.viewState().task?.id === doneTask?.id && api.viewState().task?.status === "completed",
    JSON.stringify(api.viewState().task),
  );

  // --- question form
  await api.handle({ type: "newSession" });
  await checkQuestion(
    api,
    "Use your question tool to ask me which color I prefer, with options red and blue. Then reply with my answer.",
    (opts) => opts.find((o) => /blue/i.test(o)) ?? "Blue",
  );
  check(
    "Answer reached the agent",
    /blue/i.test(lastAssistantText(api)),
    lastAssistantText(api).slice(0, 60),
  );

  // --- budget guard interrupts the real run
  await vscode.workspace
    .getConfiguration("opencodeSidebar")
    .update("budget.small", { maxCost: 0, maxSteps: 5 }, vscode.ConfigurationTarget.Global);
  await api.handle({ type: "selectBudget", level: "small" });
  await api.handle({ type: "newSession" });
  since = events.length;
  await api.handle({
    type: "send",
    text: "Run these shell commands one at a time, each as its own separate tool call and waiting for each before the next: `echo 1`, `echo 2`, `echo 3`, `echo 4`, `echo 5`, `echo 6`, `echo 7`, `echo 8`, `echo 9`, `echo 10`. Then reply DONE.",
  });
  const stopCard = await waitFor(
    "budget stop",
    () =>
      events
        .slice(since)
        .find((e): e is Extract<UiEvent, { type: "budget" }> => e.type === "budget" && e.state === "stopped"),
    240_000,
  );
  const warned = events.slice(since).some((e) => e.type === "budget" && e.state === "warning");
  const idle = await waitIdle(api, since, 60_000);
  check("Budget warning shown before the limit", warned);
  const budgetTask = api.viewState().task;
  check(
    "Budget stop keeps the task (Stopped — budget reached)",
    budgetTask?.status === "budget-stopped" && budgetTask.summary.startsWith("Run these shell commands"),
    JSON.stringify(budgetTask),
  );
  check(
    "Budget hard limit interrupts the real OpenCode run",
    idle.outcome === "interrupted",
    `${idle.outcome}; task steps=${api.viewState().budget.taskSteps}`,
  );
  since = events.length;
  await api.handle({ type: "budgetAction", itemId: stopCard.id, action: "continue" });
  await waitFor(
    "continuation started",
    () => events.slice(since).some((e) => e.type === "session.busy") || undefined,
    60_000,
  );
  await waitFor(
    "continuation delivered",
    () => api.viewState().task?.status === "running" || undefined,
    30_000,
  ).catch(() => undefined);
  check(
    "Continue once keeps the same task",
    api.viewState().task?.id === budgetTask?.id && api.viewState().task?.status === "running",
    JSON.stringify(api.viewState().task),
  );
  const carried = api.viewState().budget;
  check(
    "Continue once resumes the same task with one override",
    carried.allowance === 2 && carried.taskSteps >= 5 && api.viewState().budget.level === "small",
    JSON.stringify(carried),
  );
  await waitIdle(api, since, 240_000);
  await api.handle({ type: "selectBudget", level: "off" });

  // --- task completion notification and "Open Chat"
  const shown: string[] = [];
  api.setNotifier(async (_severity, message) => {
    shown.push(message);
    return "Open Chat";
  });
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
  await new Promise((r) => setTimeout(r, 800));
  const hiddenBefore = !api.viewVisible();
  await api.handle({ type: "newSession" });
  since = events.length;
  await api.handle({ type: "send", text: "Reply with the single word OK." });
  await waitIdle(api, since, 180_000);
  await waitFor("view revealed", () => api.viewVisible() || undefined, 10_000).catch(() => undefined);
  check(
    "Completion notification uses the task summary and Open Chat reveals the view",
    hiddenBefore &&
      shown.length === 1 &&
      shown[0] === "✅ OpenCode task completed: Reply with the single word OK." &&
      api.viewVisible(),
    JSON.stringify({ hiddenBefore, shown, visible: api.viewVisible() }),
  );
  await api.handle({ type: "newSession" });
  await api.handle({ type: "selectSession", id: sqSession! });
  check("Reopening a session does not replay notifications", shown.length === 1);

  // --- model variant
  const withVariant = (api.viewState().models ?? []).find(
    (m) => m.providerID === MODEL.split("/")[0] && m.variants.includes("none"),
  );
  if (withVariant) {
    await api.handle({ type: "selectModel", key: withVariant.key });
    await api.handle({ type: "selectVariant", variant: "none" });
    await api.handle({ type: "newSession" });
    since = events.length;
    await api.handle({ type: "send", text: "Reply with the single word OK." });
    await waitIdle(api, since, 180_000);
    const cur = api.controller()?.current;
    const errorCard = items(api).find((i) => i.kind === "error");
    check(
      "Model variant sent to OpenCode",
      cur?.variant === "none",
      `${withVariant.key} variant=${cur?.variant}; run: ${errorCard?.kind === "error" ? `error → ${errorCard.title}` : lastAssistantText(api).slice(0, 30)}`,
    );
    await api.handle({ type: "selectModel", key: MODEL });
    check(
      "Variant cleared for a model without that variant",
      api.viewState().selectedVariant === null ||
        (api.viewState().models ?? [])
          .find((m) => m.key === MODEL)
          ?.variants.includes(api.viewState().selectedVariant ?? "") === true,
    );
  } else {
    check("Model variant sent to OpenCode", true, "skipped: no model with variant 'none' for this provider");
  }
}

// ======================================================= 0.2.1 Current Task (real repo, read-only)

/** Reads stored messages straight from OpenCode (independent of the extension). */
async function storedMessages(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const home = process.env.HOME ?? "";
  const svc = JSON.parse(
    fs.readFileSync(
      path.join(process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "opencode", "service.json"),
      "utf8",
    ),
  );
  const headers = { authorization: "Basic " + Buffer.from("opencode:" + svc.password).toString("base64") };
  const out: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const url = new URL(`/api/session/${sessionId}/message`, svc.url);
    if (cursor) url.searchParams.set("cursor", cursor);
    else url.searchParams.set("order", "asc");
    url.searchParams.set("limit", "100");
    const page = (await (await fetch(url, { headers })).json()) as {
      data: Array<Record<string, unknown>>;
      cursor?: { next?: string | null };
    };
    out.push(...page.data);
    cursor = page.cursor?.next ?? null;
    if (!cursor || page.data.length === 0) break;
  }
  return out;
}

async function realRepoTask(api: TestApi): Promise<void> {
  await common(api);
  // Never let Budget Guard act on someone else's run while browsing existing sessions.
  await api.handle({ type: "selectBudget", level: "off" });
  await api.handle({ type: "selectAgent", id: "plan" });

  // 1. An existing, idle session.
  const active = new Set<string>();
  const svcActive = await (async () => {
    const home = process.env.HOME ?? "";
    const svc = JSON.parse(
      fs.readFileSync(path.join(home, ".local", "state", "opencode", "service.json"), "utf8"),
    );
    const headers = { authorization: "Basic " + Buffer.from("opencode:" + svc.password).toString("base64") };
    return (
      (await (await fetch(new URL("/api/session/active", svc.url), { headers })).json()) as {
        data: Record<string, unknown>;
      }
    ).data;
  })();
  for (const id of Object.keys(svcActive ?? {})) active.add(id);
  await api.handle({ type: "refreshSessions" });
  const candidate = api.viewState().sessions.find((x) => !active.has(x.id));
  check("Found an existing idle session", !!candidate, candidate ? `${candidate.title}` : "none");
  if (candidate) {
    await api.handle({ type: "selectSession", id: candidate.id });
    const st = api.viewState();
    check(
      "Session Title stays visible beside Current Task",
      !!st.currentSession?.title && st.currentSession.title.length > 0,
      st.currentSession?.title,
    );
    const msgs = await storedMessages(candidate.id);
    const users = msgs.filter((m) => m.type === "user");
    const task = st.task;
    const stored = users.find((u) => u.id === task?.id);
    check(
      "Current Task is an actual stored prompt of the session",
      !!task && !!stored && task.summary === summarizeTask(String(stored.text)),
      `${task?.label} · ${task?.status} · “${task?.summary}”`,
    );
    await api.handle({ type: "getTaskPrompt" });
    const saved = await vscode.env.clipboard.readText();
    await api.handle({ type: "copyTaskPrompt", requestId: "t" });
    const copied = await vscode.env.clipboard.readText();
    await vscode.env.clipboard.writeText(saved);
    check(
      "Expanded prompt / Copy Prompt match the stored message exactly",
      !!stored && copied === stored.text,
      `${copied.length} chars, ${copied.split("\n").length} lines`,
    );
  }

  // 2. Steer and queue on a read-only run (plan agent).
  await api.handle({ type: "newSession" });
  check("New session shows no task", api.viewState().task === null);
  let since = events.length;
  const mark = items(api).length;
  await api.handle({
    type: "send",
    text: "Run the shell command `sleep 15` and wait for it. Then reply DONE. Do not modify anything.",
  });
  await waitFor(
    "sleep running",
    () =>
      toolsSince(api, mark).find((t) => /sleep 15/.test(t.detail.command ?? "") && t.status === "running"),
    180_000,
  );
  const taskId = api.viewState().task?.id;
  await api.handle({
    type: "send",
    text: "Steer: afterwards also run `git --no-optional-locks status`.",
    delivery: "steer",
  });
  await api.handle({
    type: "send",
    text: "Queued: then reply with the single word QUEUED.",
    delivery: "queue",
  });
  await waitFor("next", () => api.viewState().task?.next ?? undefined, 15_000).catch(() => undefined);
  check(
    "Queued prompt shows as Next",
    api.viewState().task?.next?.summary === "Queued: then reply with the single word QUEUED.",
    JSON.stringify(api.viewState().task?.next),
  );
  await waitFor("steer", () => api.viewState().task?.steer ?? undefined, 120_000).catch(() => undefined);
  check(
    "Steer does not replace Current Task",
    api.viewState().task?.id === taskId && /^Steer:/.test(api.viewState().task?.steer ?? ""),
    JSON.stringify(api.viewState().task),
  );
  await waitFor(
    "drained",
    () =>
      (!api.viewState().busy &&
        api.viewState().pending.length === 0 &&
        events.slice(since).some((e) => e.type === "session.idle")) ||
      undefined,
    240_000,
  );

  // 3. Budget stop keeps the task (read-only commands).
  await vscode.workspace
    .getConfiguration("opencodeSidebar")
    .update("budget.small", { maxCost: 0, maxSteps: 3 }, vscode.ConfigurationTarget.Global);
  await api.handle({ type: "selectBudget", level: "small" });
  await api.handle({ type: "newSession" });
  since = events.length;
  await api.handle({
    type: "send",
    text: "Run these shell commands one at a time as separate tool calls: `echo 1`, `echo 2`, `echo 3`, `echo 4`, `echo 5`, `echo 6`. Then reply DONE. Do not modify anything.",
  });
  await waitFor(
    "budget stop",
    () => events.slice(since).find((e) => e.type === "budget" && e.state === "stopped"),
    240_000,
  );
  await waitIdle(api, since, 60_000);
  const t = api.viewState().task;
  check(
    "Budget stop does not lose the task",
    t?.status === "budget-stopped" && t.summary.startsWith("Run these shell commands"),
    JSON.stringify(t),
  );
  await api.handle({ type: "selectBudget", level: "off" });

  // Read-only proof via OpenCode snapshots of this run's own sessions.
  const changed: string[] = [];
  for (const id of touchedSessions) {
    if (candidate && id === candidate.id) continue; // pre-existing session, only viewed
    await api.handle({ type: "selectSession", id });
    await api.controller()?.refreshChanges();
    const ac = api.viewState().agentChanges;
    if (ac.status === "ok") changed.push(`${id}:${ac.files.map((f) => f.path).join(",")}`);
  }
  check("This run's sessions made no file changes (snapshot diff)", changed.length === 0, changed.join(" "));
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
  const tap = api.tap((evs) => {
    events.push(...evs);
    const id = api.controller()?.current?.id;
    if (id) touchedSessions.add(id);
  });
  const scenario = process.env.ACCEPT_SCENARIO;
  try {
    if (scenario === "real-repo") await realRepo(api);
    else if (scenario === "real-repo-task") await realRepoTask(api);
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
