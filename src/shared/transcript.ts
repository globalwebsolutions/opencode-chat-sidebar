import type { FileChange, ToolDetail, TranscriptItem, UiEvent } from "./model";
import { describeTool, fileChangesFromMetadata, mergeFileChanges } from "./tools";

/** Hard cap on tool output kept in memory / sent to the webview. */
export const MAX_TOOL_OUTPUT = 20_000;

/**
 * Mutable transcript state. The same reducer runs in the extension host (the
 * canonical copy, used to restore the webview) and in the webview.
 */
export class Transcript {
  items: TranscriptItem[] = [];
  private index = new Map<string, number>();
  private turnFiles = new Map<string, FileChange>();
  private toolInputs = new Map<string, Record<string, unknown>>();
  private turn = 0;

  reset(items: TranscriptItem[] = []): void {
    this.items = [];
    this.index.clear();
    this.turnFiles.clear();
    this.toolInputs.clear();
    for (const item of items) this.upsert(item);
  }

  get(id: string): TranscriptItem | undefined {
    const i = this.index.get(id);
    return i === undefined ? undefined : this.items[i];
  }

  has(id: string): boolean {
    return this.index.has(id);
  }

  /** Inserts or replaces an item; returns its id. */
  upsert(item: TranscriptItem): string {
    const i = this.index.get(item.id);
    if (i === undefined) {
      this.index.set(item.id, this.items.length);
      this.items.push(item);
    } else {
      this.items[i] = item;
    }
    return item.id;
  }

  /** Applies a normalized event. Returns ids of items that were added or changed. */
  apply(ev: UiEvent): string[] {
    switch (ev.type) {
      case "user.message": {
        const id = `user:${ev.id}`;
        if (this.has(id)) return [];
        this.turn++;
        this.turnFiles.clear();
        return [this.upsert({ kind: "user", id, text: ev.text, attachments: ev.attachments })];
      }
      case "assistant.delta":
      case "reasoning.delta": {
        const kind = ev.type === "assistant.delta" ? "assistant" : "reasoning";
        const id = `${kind === "assistant" ? "text" : "think"}:${ev.partId}`;
        const prev = this.get(id);
        const text =
          (prev && (prev.kind === "assistant" || prev.kind === "reasoning") ? prev.text : "") + ev.delta;
        return [this.upsert({ kind, id, text, streaming: true })];
      }
      case "assistant.completed":
      case "reasoning.completed": {
        const kind = ev.type === "assistant.completed" ? "assistant" : "reasoning";
        const id = `${kind === "assistant" ? "text" : "think"}:${ev.partId}`;
        if (kind === "reasoning" && ev.text.trim() === "" && !this.has(id)) return [];
        return [this.upsert({ kind, id, text: ev.text, streaming: false })];
      }
      case "tool.started": {
        const id = `tool:${ev.toolId}`;
        if (this.has(id)) return [];
        const d = describeTool(ev.name, null);
        return [
          this.upsert({
            kind: "tool",
            id,
            name: ev.name,
            title: d.title,
            category: d.category,
            status: "pending",
            detail: emptyDetail(),
          }),
        ];
      }
      case "tool.input": {
        const id = `tool:${ev.toolId}`;
        const prev = this.get(id);
        const name = ev.name ?? (prev?.kind === "tool" ? prev.name : "tool");
        this.toolInputs.set(ev.toolId, ev.input);
        const d = describeTool(name, ev.input);
        const detail = prev?.kind === "tool" ? { ...prev.detail } : emptyDetail();
        detail.facts = d.facts;
        detail.command = d.command ?? detail.command;
        const status = prev?.kind === "tool" && prev.status !== "pending" ? prev.status : "running";
        return [
          this.upsert({ kind: "tool", id, name, title: d.title, category: d.category, status, detail }),
        ];
      }
      case "tool.shell": {
        const id = `tool:${ev.toolId}`;
        const prev = this.get(id);
        if (prev?.kind !== "tool") return [];
        const detail = {
          ...prev.detail,
          cwd: ev.cwd ?? prev.detail.cwd,
          command: prev.detail.command ?? ev.command,
        };
        return [this.upsert({ ...prev, detail })];
      }
      case "tool.completed":
      case "tool.failed": {
        const id = `tool:${ev.toolId}`;
        const prev = this.get(id);
        const base =
          prev?.kind === "tool"
            ? prev
            : {
                kind: "tool" as const,
                id,
                name: "tool",
                title: "Tool",
                category: "other" as const,
                status: "pending" as const,
                detail: emptyDetail(),
              };
        const detail: ToolDetail = { ...base.detail };
        if (ev.output !== null) {
          detail.output =
            ev.output.length > MAX_TOOL_OUTPUT ? ev.output.slice(0, MAX_TOOL_OUTPUT) : ev.output;
          detail.outputTruncated = ev.output.length > MAX_TOOL_OUTPUT || ev.metadata?.truncated === true;
        }
        if (typeof ev.metadata?.exit === "number") detail.exitCode = ev.metadata.exit;
        const files = fileChangesFromMetadata(ev.metadata);
        if (files.length) {
          detail.files = files;
          mergeFileChanges(this.turnFiles, files);
        }
        if (ev.type === "tool.failed") detail.error = ev.error;
        const failed = ev.type === "tool.failed" || (detail.exitCode !== null && detail.exitCode !== 0);
        return [this.upsert({ ...base, status: failed ? "failed" : "completed", detail })];
      }
      case "permission.requested": {
        const id = `perm:${ev.request.id}`;
        const prev = this.get(id);
        if (prev?.kind === "permission" && prev.status !== "pending" && prev.status !== "sending") return [];
        return [
          this.upsert({
            kind: "permission",
            id,
            request: ev.request,
            sensitive: ev.sensitive,
            status: "pending",
          }),
        ];
      }
      case "permission.sending":
      case "permission.resolved": {
        const id = `perm:${ev.requestId}`;
        const prev = this.get(id);
        if (prev?.kind !== "permission") return [];
        const status = ev.type === "permission.sending" ? "sending" : ev.decision;
        return [this.upsert({ ...prev, status })];
      }
      case "session.idle": {
        const changed: string[] = [];
        for (const item of this.items) {
          if ((item.kind === "assistant" || item.kind === "reasoning") && item.streaming) {
            changed.push(this.upsert({ ...item, streaming: false }));
          } else if (item.kind === "tool" && (item.status === "running" || item.status === "pending")) {
            const status = ev.outcome === "succeeded" ? "completed" : "failed";
            const detail = {
              ...item.detail,
              error: item.detail.error ?? (ev.outcome === "interrupted" ? "Interrupted" : null),
            };
            changed.push(this.upsert({ ...item, status, detail }));
          } else if (item.kind === "permission" && (item.status === "pending" || item.status === "sending")) {
            changed.push(this.upsert({ ...item, status: "expired" }));
          }
        }
        if (this.turnFiles.size) {
          const files = [...this.turnFiles.values()];
          changed.push(this.upsert({ kind: "turn-summary", id: `summary:${this.turn}`, files }));
          this.turnFiles.clear();
        }
        if (ev.outcome === "interrupted") {
          changed.push(
            this.upsert({ kind: "notice", id: `stopped:${this.turn}`, level: "info", text: "Stopped." }),
          );
        }
        return changed;
      }
      case "session.error":
        return [
          this.upsert({
            kind: "notice",
            id: `error:${this.turn}:${this.items.length}`,
            level: "error",
            text: ev.message,
          }),
        ];
      case "session.retry":
        return [
          this.upsert({
            kind: "notice",
            id: `retry:${this.turn}`,
            level: "info",
            text: `Retrying (attempt ${ev.attempt}): ${ev.message}`,
          }),
        ];
      case "notice":
        return [
          this.upsert({ kind: "notice", id: `notice:${this.items.length}`, level: ev.level, text: ev.text }),
        ];
      default:
        return [];
    }
  }
}

export function emptyDetail(): ToolDetail {
  return {
    facts: [],
    command: null,
    cwd: null,
    output: null,
    outputTruncated: false,
    exitCode: null,
    files: [],
    error: null,
  };
}
