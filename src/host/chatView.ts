// Sidebar webview provider and host-side controller: owns the OpenCode
// connection, VS Code integrations (editor context, quick pick, diff, links)
// and the bridge to the webview.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { discoverExecutable } from "../core/cliDiscovery";
import { chipFor, validateSelection } from "../core/context";
import { classifyPath } from "../core/sensitive";
import { decideNotification, type TaskNotice } from "../core/currentTask";
import { deriveOnboarding, OPENCODE_LINKS, statusBarText } from "../core/onboarding";
import { SessionController } from "../core/sessionController";
import { HttpOpenCodeClient, type EventSubscription } from "../opencode/client";
import { discoverServer, startService } from "../opencode/service";
import type {
  AccountStatus,
  BudgetLevel,
  ConnectionStatus,
  ContextAttachment,
  OnboardingView,
  SignInState,
  UiEvent,
} from "../shared/model";
import {
  parseWebviewMessage,
  type HostMessage,
  type ViewState,
  type WebviewMessage,
} from "../shared/protocol";
import { CONFIG_SECTION, readConfig, readNotificationSettings } from "./config";
import { openAgentDiffs, openAgentFileDiff, openAllDiffs, openFileDiff, type AgentSideSource } from "./diff";
import type { Logger } from "./log";
import { WorkspaceTracker } from "./workspace";

export const VIEW_ID = "opencodeSidebar.chat";
/** The one command every entry point uses to open the chat. */
export const FOCUS_COMMAND = "opencodeSidebar.focusChat";
const HINT_KEY = "opencodeSidebar.placementHintDismissed";
const SIGN_IN_HINT_KEY = "opencodeSidebar.signInHintDismissed";
const SIGN_IN_POLL_MS = 3000;
const SIGN_IN_MAX_MS = 15 * 60_000;

function uiLocale(): "en" | "ar" {
  return vscode.env.language.toLowerCase().startsWith("ar") ? "ar" : "en";
}

const AR_STRINGS = {
  budgetWarning: "اقتربت المهمة من حد الاستهلاك المحدد.",
  budgetStopped: "تم بلوغ حد استهلاك المهمة. تم إيقاف الوكيل.",
  contextWarning: (p: number) => `نافذة السياق ممتلئة بنسبة ${p}٪. يُفضّل بدء جلسة جديدة.`,
};

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable, AgentSideSource {
  private view: vscode.WebviewView | undefined;
  private webviewReady = false;
  private connection: ConnectionStatus = { kind: "connecting" };
  private controller: SessionController | undefined;
  private subscription: EventSubscription | undefined;
  private attachments: ContextAttachment[] = [];
  private pendingEvents: UiEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private stateTimer: ReturnType<typeof setTimeout> | undefined;
  private connecting: Promise<void> | undefined;
  private starting: Promise<void> | undefined;
  private autoStartTried = false;
  private streamWasOpen = false;
  private readonly workspace: WorkspaceTracker;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly taps = new Set<(events: UiEvent[]) => void>();
  private readonly statusItem: vscode.StatusBarItem;
  private focusPending = false;
  private signInState: SignInState = "idle";
  private signInTerminal: vscode.Terminal | undefined;
  private signInTimer: ReturnType<typeof setInterval> | undefined;
  private signInStarted = 0;
  private signInBaseline: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: Logger,
  ) {
    this.workspace = new WorkspaceTracker(context.workspaceState);
    this.disposables.push(this.workspace);
    // Status Bar shortcut to the chat. It stays neutral until the sidebar has connected.
    this.statusItem = vscode.window.createStatusBarItem(
      "opencodeSidebar.status",
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusItem.name = "OpenCode Chat Sidebar";
    this.statusItem.command = FOCUS_COMMAND;
    this.disposables.push(this.statusItem);
    this.updateStatusBar(null);
    this.disposables.push(
      vscode.window.onDidCloseTerminal((t) => {
        if (t === this.signInTerminal) void this.finishSignIn(t);
      }),
    );
    this.disposables.push(
      this.workspace.onDidChange((info) => {
        // Branch / Git status updates also fire this event; only a different folder reloads.
        const dir = info.active?.path ?? null;
        if (this.controller && this.controller.directory !== dir) void this.controller.setDirectory(dir);
        this.postState();
      }),
    );
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(CONFIG_SECTION)) return;
        if (
          e.affectsConfiguration(`${CONFIG_SECTION}.serverUrl`) ||
          e.affectsConfiguration(`${CONFIG_SECTION}.allowRemoteServer`) ||
          e.affectsConfiguration(`${CONFIG_SECTION}.executablePath`)
        ) {
          void this.reconnect();
        } else this.postState();
        if (e.affectsConfiguration(`${CONFIG_SECTION}.showStatusBarItem`))
          this.updateStatusBar(this.lastStage);
      }),
    );
  }

  // ------------------------------------------------------------ webview

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, "dist");
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [distRoot, mediaRoot] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((raw) => void this.onMessage(raw), undefined, this.disposables);
    view.onDidChangeVisibility(() => {
      if (view.visible && this.focusPending) this.post({ type: "focusInput" });
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.webviewReady = false;
    });
    void this.ensureStarted();
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>OpenCode</title>
</head>
<body>
<div id="app" role="application" aria-label="OpenCode chat"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  private post(message: HostMessage): void {
    if (this.view && this.webviewReady) void this.view.webview.postMessage(message);
  }

  /** Coalesces state pushes; the state snapshot is small. */
  postState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      const state = this.viewState();
      this.updateStatusBar(state.onboarding.stage);
      this.post({ type: "state", state });
    }, 16);
  }

  private queueEvents(events: UiEvent[]): void {
    for (const tap of this.taps) tap(events);
    this.pendingEvents.push(...events);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const batch = this.pendingEvents;
      this.pendingEvents = [];
      if (batch.length) this.post({ type: "events", events: batch });
    }, 30);
  }

  private viewState(): ViewState {
    const c = this.controller;
    const cfg = readConfig();
    return {
      connection: this.connection,
      workspace: this.workspace.current,
      models: c?.models ?? null,
      agents: c?.agents ?? null,
      selectedModel: c?.selectedModel ?? null,
      selectedAgent: c?.selectedAgent ?? null,
      sessions: c?.displaySessions() ?? [],
      currentSession: c?.current ? { id: c.current.id, title: c.currentTitle() ?? "Untitled session" } : null,
      busy: c?.busy ?? false,
      stopping: c?.stopping ?? false,
      attachments: this.attachments.map(chipFor),
      agentChanges: c?.agentChanges ?? { status: "none" },
      workspaceChanges:
        this.workspace.current.uncommitted === null ? null : { count: this.workspace.current.uncommitted },
      usage: cfg.showUsage ? (c?.usage() ?? null) : null,
      steps: c?.steps ?? 0,
      selectedVariant: c?.selectedVariant ?? null,
      budget: c?.budgetView() ?? {
        level: cfg.budgetDefault,
        limits: { maxCost: null, maxSteps: null },
        taskCost: null,
        taskSteps: 0,
        active: false,
        state: "ok",
        allowance: 1,
      },
      budgetPresets: cfg.budget.presets,
      pending: c?.pending ?? [],
      locale: uiLocale(),
      showPlacementHint: !this.context.globalState.get<boolean>(HINT_KEY, false),
      task: c?.taskView() ?? null,
      onboarding: this.onboarding(),
    };
  }

  private onboarding(): OnboardingView {
    const c = this.controller;
    return deriveOnboarding({
      connection: this.connection,
      hasFolder: !!this.workspace.current.active,
      catalogLoaded: c?.catalogLoaded ?? false,
      catalogLoading: c?.catalogLoading ?? false,
      models: c?.models ?? null,
      account: c?.account ?? null,
      signIn: this.signInState,
      hintDismissed: this.context.globalState.get<boolean>(SIGN_IN_HINT_KEY, false),
    });
  }

  private lastStage: OnboardingView["stage"] | null = null;

  private updateStatusBar(stage: OnboardingView["stage"] | null): void {
    this.lastStage = stage;
    if (!readConfig().showStatusBarItem) {
      this.statusItem.hide();
      return;
    }
    const text = statusBarText(stage);
    this.statusItem.text = `$(comment-discussion) ${text}`;
    this.statusItem.tooltip = `OpenCode Chat Sidebar — ${text === "OpenCode Chat" ? "open the chat" : text}. Click to open the chat.`;
    this.statusItem.accessibilityInformation = {
      label: `${text}. Open OpenCode Chat Sidebar`,
      role: "button",
    };
    this.statusItem.backgroundColor =
      stage === "sign-in" || stage === "sign-in-expired" || stage === "not-installed"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    this.statusItem.show();
  }

  // ------------------------------------------------------- connection

  private async ensureStarted(): Promise<void> {
    await this.workspace.start();
    if (!this.controller && !this.connecting) await this.connect();
  }

  private setConnection(status: ConnectionStatus): void {
    this.connection = status;
    this.postState();
  }

  private reconnectGeneration = 0;

  /** Drops the current connection and connects again with the current settings. */
  private async reconnect(): Promise<void> {
    const generation = ++this.reconnectGeneration;
    // A connect still in flight read older settings: let it finish, then start over. Several
    // quick changes (e.g. two settings) collapse into one reconnect with the latest values.
    if (this.connecting) await this.connecting.catch(() => undefined);
    if (generation !== this.reconnectGeneration) return;
    this.teardown();
    await this.connect();
  }

  private teardown(): void {
    this.subscription?.dispose();
    this.subscription = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.streamWasOpen = false;
  }

  private connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const cfg = readConfig();
    this.setConnection({ kind: "connecting" });
    const outcome = await discoverServer(
      { serverUrl: cfg.serverUrl, allowRemote: cfg.allowRemoteServer },
      {
        readFile: (f) => fs.promises.readFile(f, "utf8").catch(() => undefined),
        fetch,
        env: process.env,
      },
    );
    if (!outcome.ok) {
      this.log.warn(`OpenCode server not available: ${outcome.detail}`);
      if (outcome.reason === "invalid-setting" || outcome.reason === "unauthorized") {
        this.setConnection({ kind: "error", message: outcome.detail });
        return;
      }
      const cli = this.findCli();
      if (!cli.found) {
        this.setConnection({ kind: "cli-not-found", searched: cli.searched });
        return;
      }
      const canStart = cfg.serverUrl.trim() === "";
      this.setConnection({
        kind: "not-running",
        canStart,
        detail: canStart
          ? "OpenCode is installed but its background service is not running."
          : outcome.detail,
      });
      if (canStart && cfg.autoStart && !this.autoStartTried) {
        this.autoStartTried = true;
        await this.startOpenCode();
      }
      return;
    }

    this.log.info(`Connected to OpenCode ${outcome.version} at ${outcome.endpoint.url} (${outcome.source})`);
    const client = new HttpOpenCodeClient(outcome.endpoint);
    const controller = new SessionController(
      client,
      this.context.workspaceState,
      {
        onEvents: (events) => this.queueEvents(events),
        onTranscriptReset: (items) => {
          this.pendingEvents = [];
          this.post({ type: "transcript", items });
        },
        onStateChanged: () => this.postState(),
        onTaskNotice: (notice) => void this.showTaskNotice(notice),
      },
      this.log,
      () => {
        const c = readConfig();
        return {
          model: c.defaultModel.trim(),
          agent: c.defaultAgent.trim(),
          budgetLevel: c.budgetDefault,
          budget: c.budget,
          contextWarnPercent: c.contextWarnPercent,
          strings: uiLocale() === "ar" ? AR_STRINGS : undefined,
        };
      },
    );
    this.controller = controller;
    this.subscription = client.subscribe({
      onEvent: (raw) => controller.handleRawEvent(raw),
      onOpen: () => {
        this.log.info("Event stream connected");
        if (this.streamWasOpen) void controller.resync();
        this.streamWasOpen = true;
        this.setConnection({ kind: "connected", version: outcome.version, url: outcome.endpoint.url });
      },
      onClose: (error) => {
        if (this.controller !== controller) return;
        this.log.warn(`Event stream closed: ${error ?? "unknown"}; reconnecting`);
        this.setConnection({ kind: "connecting" });
      },
    });
    this.setConnection({ kind: "connected", version: outcome.version, url: outcome.endpoint.url });
    await controller.setDirectory(this.workspace.current.active?.path ?? null);
  }

  private findCli() {
    const cfg = readConfig();
    return discoverExecutable({
      configuredPath: cfg.executablePath,
      pathEnv: process.env.PATH ?? "",
      home: process.env.HOME ?? process.env.USERPROFILE ?? "",
      platform: process.platform,
      isExecutable: (file) => {
        try {
          const st = fs.statSync(file);
          if (!st.isFile()) return false;
          if (process.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
    });
  }

  async startOpenCode(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const cli = this.findCli();
      if (!cli.found) {
        this.setConnection({ kind: "cli-not-found", searched: cli.searched });
        return;
      }
      this.setConnection({ kind: "connecting" });
      this.log.info(`Starting OpenCode background service via ${cli.path} service start`);
      const result = await startService(cli.path);
      if (!result.ok) {
        this.log.error(`opencode service start failed: ${result.output}`);
        this.setConnection({
          kind: "error",
          message: "Could not start OpenCode. See the OpenCode Chat Sidebar output for details.",
        });
        return;
      }
      for (let i = 0; i < 20 && !this.controller; i++) {
        await this.connect();
        if (this.controller) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!this.controller)
        this.setConnection({ kind: "error", message: "OpenCode started but could not be reached." });
    })().finally(() => (this.starting = undefined));
    return this.starting;
  }

  // ---------------------------------------------------------- commands

  /** Reveals the chat view (wherever the user moved it) and focuses the message box. */
  async focus(): Promise<void> {
    this.focusPending = !(this.view && this.webviewReady);
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    this.post({ type: "focusInput" });
  }

  /** Re-checks the service, account, providers, models and agents without reloading the window. */
  async refreshConnection(): Promise<void> {
    const c = this.controller;
    if (!c || this.connection.kind !== "connected") {
      await this.reconnect();
      return;
    }
    await Promise.all([c.refreshCatalog(), c.refreshSessions()]);
    // Nothing answered: the service probably went away, so rediscover it.
    if (this.controller === c && c.directory && c.models === null && c.account === null)
      await this.reconnect();
  }

  /**
   * Runs OpenCode's own sign-in (`opencode auth login`) in a VS Code terminal. The extension
   * never sees the credentials: OpenCode stores them. "account" uses the OpenCode Console
   * device flow; "provider" opens OpenCode's provider picker.
   */
  async signIn(target: "account" | "provider" = "account"): Promise<void> {
    const cli = this.findCli();
    if (!cli.found) {
      this.setConnection({ kind: "cli-not-found", searched: cli.searched });
      return;
    }
    if (this.signInTerminal && this.signInTerminal.exitStatus === undefined) {
      try {
        this.signInTerminal.show();
        return;
      } catch {
        // Closed a moment ago (the close event has not arrived yet): start a new sign-in.
        this.signInTerminal = undefined;
      }
    }
    const args = ["auth", "login"];
    if (target === "account") args.push("opencode", "--method", "device");
    // A server chosen in settings is used for the login too; otherwise the background service.
    if (readConfig().serverUrl.trim() && this.connection.kind === "connected")
      args.push("--server", this.connection.url);
    this.log.info(`Starting sign-in: opencode ${args.join(" ")}`);
    const terminal = vscode.window.createTerminal({
      name: target === "account" ? "OpenCode Sign In" : "OpenCode Providers",
      shellPath: cli.path,
      shellArgs: args,
      iconPath: new vscode.ThemeIcon("account"),
      message: "Sign in using OpenCode. OpenCode Chat Sidebar never sees or stores your password or keys.",
    });
    this.signInTerminal = terminal;
    this.signInStarted = Date.now();
    this.signInBaseline = accountKey(this.controller?.account ?? null, this.controller?.models?.length);
    this.signInState = "waiting";
    terminal.show();
    clearInterval(this.signInTimer);
    this.signInTimer = setInterval(() => void this.pollSignIn(terminal), SIGN_IN_POLL_MS);
    this.postState();
  }

  private async pollSignIn(terminal: vscode.Terminal): Promise<void> {
    if (terminal !== this.signInTerminal) return;
    if (terminal.exitStatus !== undefined) return this.finishSignIn(terminal);
    if (Date.now() - this.signInStarted > SIGN_IN_MAX_MS) {
      this.endSignInWait("idle");
      return;
    }
    // OpenCode also emits integration/provider events, which refresh the catalog; polling is a fallback.
    const c = this.controller;
    if (!c) return;
    await c.refreshCatalog();
    if (this.signInChanged()) this.endSignInWait("idle");
  }

  private async finishSignIn(terminal: vscode.Terminal): Promise<void> {
    if (terminal !== this.signInTerminal) return;
    const status = terminal.exitStatus;
    // Closed by the user (or VS Code) rather than OpenCode finishing: treat as cancelled.
    const closed = !status || status.reason !== vscode.TerminalExitReason.Process;
    const code = status?.code;
    this.signInTerminal = undefined;
    clearInterval(this.signInTimer);
    if (this.controller) await this.controller.refreshCatalog();
    else await this.reconnect();
    if (this.signInChanged() || (!closed && code === 0)) this.endSignInWait("idle");
    // 129/130/143: hang-up, Ctrl+C, terminate.
    else if (closed || code === undefined || code === 129 || code === 130 || code === 143)
      this.endSignInWait("cancelled");
    else {
      this.log.warn(`opencode auth login exited with code ${code}`);
      this.endSignInWait("failed");
    }
  }

  private signInChanged(): boolean {
    const c = this.controller;
    return !!c && accountKey(c.account, c.models?.length) !== this.signInBaseline;
  }

  private endSignInWait(state: SignInState): void {
    clearInterval(this.signInTimer);
    this.signInTimer = undefined;
    this.signInState = state;
    this.postState();
  }

  private async openFolder(): Promise<void> {
    // Native "Open Folder…" dialog.
    await vscode.commands.executeCommand("vscode.openFolder");
  }

  async newSession(): Promise<void> {
    await this.controller?.newSession();
    await this.focus();
  }

  async stop(): Promise<void> {
    await this.controller?.stop();
  }

  private addAttachment(a: ContextAttachment): void {
    const duplicate = this.attachments.some((x) =>
      a.kind === "file"
        ? x.kind === "file" && x.absPath === a.absPath
        : x.kind === "selection" &&
          x.absPath === a.absPath &&
          x.startLine === a.startLine &&
          x.endLine === a.endLine,
    );
    if (!duplicate) this.attachments.push(a);
    this.postState();
  }

  private relativeToActive(absPath: string): string | null {
    const root = this.workspace.current.active?.path;
    if (!root) return null;
    const rel = path.relative(root, absPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join("/");
  }

  private async confirmSensitive(relPath: string): Promise<boolean> {
    const match = classifyPath(relPath);
    if (!match) return true;
    const choice = await vscode.window.showWarningMessage(
      `${relPath} looks sensitive (${match.reason}). Attaching it sends its contents to your model provider through OpenCode.`,
      { modal: true },
      "Attach Anyway",
    );
    return choice === "Attach Anyway";
  }

  async addCurrentFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      void vscode.window.showInformationMessage("OpenCode: open a file in the editor first.");
      return;
    }
    const absPath = editor.document.uri.fsPath;
    const rel = this.relativeToActive(absPath);
    if (!rel) {
      void vscode.window.showWarningMessage(
        "OpenCode: the current file is outside the active workspace folder.",
      );
      return;
    }
    if (!(await this.confirmSensitive(rel))) return;
    if (editor.document.isDirty) {
      void vscode.window.showInformationMessage(
        "OpenCode reads files from disk — save the file to include unsaved changes.",
      );
    }
    this.addAttachment({ kind: "file", id: crypto.randomUUID(), relPath: rel, absPath });
    await this.focus();
  }

  async addSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage("OpenCode: select some code in the editor first.");
      return;
    }
    const sel = editor.selection;
    // A selection ending at column 0 of the next line should not count that line.
    const endLine =
      sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
    const text = editor.document.getText(sel);
    const error = validateSelection(text);
    if (error) {
      void vscode.window.showWarningMessage(`OpenCode: ${error}`);
      return;
    }
    const absPath =
      editor.document.uri.scheme === "file" ? editor.document.uri.fsPath : editor.document.uri.toString();
    const rel =
      editor.document.uri.scheme === "file"
        ? (this.relativeToActive(absPath) ?? absPath)
        : path.basename(editor.document.fileName);
    if (!(await this.confirmSensitive(rel))) return;
    this.addAttachment({
      kind: "selection",
      id: crypto.randomUUID(),
      relPath: rel,
      absPath,
      startLine: sel.start.line + 1,
      endLine: endLine + 1,
      text,
      languageId: editor.document.languageId,
    });
    await this.focus();
  }

  /** "+ Context" menu: native quick pick, keyboard accessible. */
  private async contextMenu(): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        { label: "$(file) Current File", id: "file" },
        { label: "$(selection) Selection", id: "selection" },
        { label: "$(search) Search Workspace Files…", id: "search" },
      ],
      { title: "Add context for OpenCode", placeHolder: "Only what you attach is sent with your message" },
    );
    if (choice?.id === "file") await this.addCurrentFile();
    else if (choice?.id === "selection") await this.addSelection();
    else if (choice?.id === "search") await this.pickFile();
  }

  private async pickFile(): Promise<void> {
    const root = this.workspace.current.active?.path;
    if (!root) return;
    const picked = await vscode.window.showQuickPick(
      (async () => {
        // Only runs on explicit user action; honours files.exclude and is capped.
        const uris = await vscode.workspace.findFiles(
          new vscode.RelativePattern(root, "**/*"),
          undefined,
          5000,
        );
        return uris
          .map((u) => this.relativeToActive(u.fsPath))
          .filter((r): r is string => !!r)
          .sort()
          .map((r) => ({ label: path.posix.basename(r), description: r }));
      })(),
      {
        title: "Attach file to OpenCode context",
        placeHolder: "Search workspace files",
        matchOnDescription: true,
      },
    );
    if (!picked?.description) return;
    const absPath = path.join(root, picked.description);
    if (!(await this.confirmSensitive(picked.description))) return;
    this.addAttachment({ kind: "file", id: crypto.randomUUID(), relPath: picked.description, absPath });
  }

  // ---------------------------------------------------------- messages

  private async onMessage(raw: unknown): Promise<void> {
    const msg = parseWebviewMessage(raw);
    if (!msg) {
      this.log.warn("Ignored malformed message from webview");
      return;
    }
    try {
      await this.handle(msg);
    } catch (e) {
      this.log.error(`Handling ${msg.type} failed`, e);
    }
  }

  private async handle(msg: WebviewMessage): Promise<void> {
    const c = this.controller;
    switch (msg.type) {
      case "ready":
        this.webviewReady = true;
        this.post({ type: "transcript", items: c?.transcript.items ?? [] });
        this.post({ type: "state", state: this.viewState() });
        if (this.focusPending) {
          this.focusPending = false;
          this.post({ type: "focusInput" });
        }
        return;
      case "send": {
        if (!c) return;
        const attachments = this.attachments;
        const sent = await c.send(msg.text, attachments, msg.delivery);
        if (sent) {
          this.attachments = [];
          this.postState();
        } else this.post({ type: "state", state: this.viewState() });
        return;
      }
      case "stop":
        return c?.stop();
      case "newSession":
        return c?.newSession();
      case "selectSession":
        if (c) await c.openSession(msg.id);
        return;
      case "refreshSessions":
        return c?.refreshSessions();
      case "selectModel":
        return c?.selectModel(msg.key);
      case "selectAgent":
        return c?.selectAgent(msg.id);
      case "selectRoot":
        await this.workspace.setActiveRoot(msg.path);
        return;
      case "addCurrentFile":
        return this.addCurrentFile();
      case "addSelection":
        return this.addSelection();
      case "pickFile":
        return this.contextMenu();
      case "removeAttachment":
        this.attachments = this.attachments.filter((a) => a.id !== msg.id);
        this.postState();
        return;
      case "respondPermission":
        return c?.respondPermission(msg.requestId, msg.decision);
      case "openFile":
        return this.openFile(msg.path);
      case "openDiff":
      case "openAgentDiff":
        return this.openAgentDiff(msg.path);
      case "openAllDiffs":
      case "openAgentDiffAll":
        return this.openAgentDiffAll();
      case "openWorkspaceDiffAll": {
        const files = this.workspace.workspaceChanges();
        if (!files || files.length === 0) {
          void vscode.window.showInformationMessage("OpenCode: no uncommitted workspace changes.");
          return;
        }
        await openAllDiffs(this.workspace.gitApi, files);
        return;
      }
      case "copy":
        return this.copy(msg.requestId, msg.text);
      case "copyMessage": {
        const text = c?.copyText(msg.itemId) ?? null;
        if (text === null) {
          this.post({ type: "copyResult", requestId: msg.requestId, ok: false });
          return;
        }
        return this.copy(msg.requestId, text);
      }
      case "selectVariant":
        return c?.selectVariant(msg.variant === "" ? null : msg.variant);
      case "selectBudget":
        return c?.selectBudget(msg.level as BudgetLevel);
      case "budgetAction":
        if (!c) return;
        if (msg.action === "continue") await c.budgetContinueOnce(msg.itemId);
        else if (msg.action === "increase") await c.budgetIncrease(msg.itemId);
        else await c.budgetNewSession(msg.itemId);
        return;
      case "answerForm": {
        if (!c) return;
        const error = await c.answerForm(msg.formId, msg.answer);
        if (error) this.post({ type: "formError", formId: msg.formId, error });
        return;
      }
      case "cancelForm":
        return c?.cancelForm(msg.formId);
      case "editPending": {
        const text = (await c?.cancelPending(msg.id)) ?? null;
        if (text !== null) this.post({ type: "restoreInput", text });
        return;
      }
      case "removePending":
        await c?.cancelPending(msg.id);
        return;
      case "retryLast":
        await c?.retry();
        return;
      case "focusModelPicker":
        this.post({ type: "focusModel" });
        return;
      case "getTaskPrompt": {
        const prompt = c?.taskPrompt();
        if (prompt) this.post({ type: "taskPrompt", id: prompt.id, text: prompt.text });
        return;
      }
      case "copyTaskPrompt": {
        const prompt = c?.taskPrompt();
        if (!prompt) {
          this.post({ type: "copyResult", requestId: msg.requestId, ok: false });
          return;
        }
        return this.copy(msg.requestId, prompt.text);
      }
      case "dismissHint":
        await this.context.globalState.update(HINT_KEY, true);
        this.postState();
        return;
      case "openLink":
        return this.openLink(msg.href);
      case "startOpenCode":
        return this.startOpenCode();
      case "retry":
        return this.reconnect();
      case "configurePath":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          `${CONFIG_SECTION}.executablePath`,
        );
        return;
      case "showLogs":
        this.log.show();
        return;
      case "signIn":
        return this.signIn("account");
      case "connectProvider":
        return this.signIn("provider");
      case "refreshConnection":
        if (this.signInState === "cancelled" || this.signInState === "failed") this.signInState = "idle";
        return this.refreshConnection();
      case "openFolder":
        return this.openFolder();
      case "openOfficial":
        await vscode.env.openExternal(vscode.Uri.parse(OPENCODE_LINKS[msg.link]));
        return;
      case "dismissSignInHint":
        await this.context.globalState.update(SIGN_IN_HINT_KEY, true);
        this.postState();
        return;
    }
  }

  /** Native VS Code notification for a task milestone; "Open Chat" reveals the sidebar. */
  private async showTaskNotice(notice: TaskNotice): Promise<void> {
    const decision = decideNotification(notice, readNotificationSettings(), {
      viewVisible: !!this.view?.visible,
      windowFocused: vscode.window.state.focused,
    });
    if (!decision.show) return;
    this.log.info(`Notification (${notice.kind}) shown`);
    const choice = await this.notifier(decision.severity, decision.message, ["Open Chat"]);
    if (choice === "Open Chat") await vscode.commands.executeCommand(FOCUS_COMMAND);
  }

  /** Replaceable for tests; defaults to VS Code's native notifications. */
  notifier: (
    severity: "info" | "warning" | "error",
    message: string,
    actions: string[],
  ) => Thenable<string | undefined> = (severity, message, actions) =>
    severity === "error"
      ? vscode.window.showErrorMessage(message, ...actions)
      : severity === "warning"
        ? vscode.window.showWarningMessage(message, ...actions)
        : vscode.window.showInformationMessage(message, ...actions);

  private async copy(requestId: string, text: string): Promise<void> {
    try {
      await vscode.env.clipboard.writeText(text);
      this.post({ type: "copyResult", requestId, ok: true });
    } catch (e) {
      this.log.error("Clipboard write failed", e);
      this.post({ type: "copyResult", requestId, ok: false });
    }
  }

  /** AgentSideSource for the agent-diff document provider. */
  sides(sessionId: string, file: string): { before: string; after: string } | null {
    const c = this.controller;
    if (!c || c.current?.id !== sessionId) return null;
    return c.agentFileSides(file);
  }

  private async openAgentDiff(file: string): Promise<void> {
    const c = this.controller;
    const abs = this.workspace.resolveInActive(file);
    if (!c?.current || !abs) return;
    if (c.agentChanges.status === "ok" && c.agentFileSides(file)) {
      await openAgentFileDiff(c.current.id, file);
      return;
    }
    // Never guess ownership: fall back to the plain workspace diff and say so.
    void vscode.window.showWarningMessage(
      `Agent-only diff unavailable for ${file}. Showing the workspace diff (HEAD ↔ working tree) instead.`,
    );
    const status = c.changes.find((f) => f.path === file)?.status ?? "modified";
    await openFileDiff(this.workspace.gitApi, abs, status);
  }

  private async openAgentDiffAll(): Promise<void> {
    const c = this.controller;
    if (!c?.current) return;
    if (c.agentChanges.status !== "ok") {
      void vscode.window.showWarningMessage(
        "Agent-only diff unavailable. Showing workspace changes instead.",
      );
      await this.handle({ type: "openWorkspaceDiffAll" });
      return;
    }
    const files = c.agentChanges.files
      .filter((f) => c.agentFileSides(f.path))
      .map((f) => ({ file: f.path, absPath: this.workspace.resolveInActive(f.path) }))
      .filter((f): f is { file: string; absPath: string } => !!f.absPath);
    if (files.length < c.agentChanges.files.length) {
      void vscode.window.showWarningMessage(
        `Agent-only diff unavailable for ${c.agentChanges.files.length - files.length} file(s) (binary or incomplete snapshot).`,
      );
    }
    await openAgentDiffs(c.current.id, files);
  }

  private async openFile(p: string): Promise<void> {
    const m = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(p);
    const file = m?.[1] ?? p;
    const line = m?.[2] ? Math.max(0, Number(m[2]) - 1) : undefined;
    const abs = path.isAbsolute(file) ? file : this.workspace.resolveInActive(file);
    if (!abs || !fs.existsSync(abs)) {
      void vscode.window.showWarningMessage(`OpenCode: file not found: ${file}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (line !== undefined) {
      const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  private async openLink(href: string): Promise<void> {
    if (/^https?:\/\//i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) return; // ignore other schemes
    const file = /^file:/i.test(href) ? vscode.Uri.parse(href).fsPath : decodeURIComponent(href);
    await this.openFile(file);
  }

  dispose(): void {
    clearInterval(this.signInTimer);
    this.teardown();
    clearTimeout(this.flushTimer);
    clearTimeout(this.stateTimer);
    for (const d of this.disposables) d.dispose();
  }

  /** Test hook: exposes internals to the acceptance harness only. */
  get testApi() {
    return {
      controller: () => this.controller,
      connection: () => this.connection,
      workspace: () => this.workspace.current,
      attachments: () => this.attachments,
      viewState: () => this.viewState(),
      handle: (msg: WebviewMessage) => this.handle(msg),
      ensureStarted: () => this.ensureStarted(),
      setNotifier: (fn: ChatViewProvider["notifier"]) => {
        this.notifier = fn;
      },
      viewVisible: () => !!this.view?.visible,
      statusBar: () => ({
        text: this.statusItem.text,
        tooltip: String(this.statusItem.tooltip ?? ""),
        command: this.statusItem.command,
      }),
      signInState: () => this.signInState,
      focusPending: () => this.focusPending,
      tap: (fn: (events: UiEvent[]) => void) => {
        this.taps.add(fn);
        return { dispose: () => this.taps.delete(fn) };
      },
    };
  }
}

/** Fingerprint of the connection evidence, used to notice when a sign-in completed. */
function accountKey(account: AccountStatus | null, modelCount: number | undefined): string | null {
  return account ? `${account.opencode}:${account.otherProviders}:${modelCount ?? -1}` : null;
}
