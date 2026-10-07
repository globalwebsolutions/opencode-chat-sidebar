import * as vscode from "vscode";
import { ChatViewProvider, VIEW_ID } from "./host/chatView";
import { EMPTY_SCHEME, EmptyDocumentProvider } from "./host/diff";
import { Logger } from "./host/log";

/**
 * Activation is cheap: it registers the view, commands and an output channel.
 * Nothing connects to OpenCode until the sidebar is shown.
 */
export function activate(context: vscode.ExtensionContext) {
  const log = new Logger();
  const provider = new ChatViewProvider(context, log);
  context.subscriptions.push(
    log,
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, new EmptyDocumentProvider()),
    vscode.commands.registerCommand("opencodeSidebar.focusChat", () => provider.focus()),
    vscode.commands.registerCommand("opencodeSidebar.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("opencodeSidebar.addCurrentFile", () => provider.addCurrentFile()),
    vscode.commands.registerCommand("opencodeSidebar.addSelection", () => provider.addSelection()),
    vscode.commands.registerCommand("opencodeSidebar.stop", () => provider.stop()),
  );
  log.info("OpenCode Sidebar activated");
  // Exported for the local acceptance harness; not a public API.
  return { testApi: provider.testApi };
}

export function deactivate(): void {
  // Disposables registered on the context are cleaned up by VS Code. The shared
  // OpenCode background service is intentionally left running: it is owned by
  // OpenCode and may be serving other clients (TUI, other windows).
}
