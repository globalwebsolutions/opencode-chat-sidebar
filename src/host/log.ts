import * as vscode from "vscode";
import { redact } from "../core/redact";

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel("OpenCode Chat Sidebar", { log: true });
  }

  info(message: string): void {
    this.channel.info(redact(message));
  }

  warn(message: string): void {
    this.channel.warn(redact(message));
  }

  error(message: string, error?: unknown): void {
    const detail =
      error instanceof Error ? `${error.name}: ${error.message}` : error === undefined ? "" : String(error);
    this.channel.error(redact(detail ? `${message} — ${detail}` : message));
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
