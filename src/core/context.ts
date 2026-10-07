// Turns explicit, user-chosen context attachments into an OpenCode prompt.
//
// - Whole files are sent as OpenCode file attachments (file:// URIs); OpenCode
//   reads and inlines them itself, exactly like an @file mention in its TUI.
// - Selections are sent inline as a fenced snippet with path + line range, so
//   only the selected lines are transmitted, never the whole file.

import { pathToFileURL } from "node:url";
import type { ContextAttachment } from "../shared/model";
import type { AttachmentChip } from "../shared/protocol";

export const MAX_SELECTION_CHARS = 60_000;

export interface PromptPayload {
  text: string;
  files: Array<{ uri: string; name: string }>;
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

export function chipFor(a: ContextAttachment): AttachmentChip {
  if (a.kind === "file") return { id: a.id, label: basename(a.relPath), detail: a.relPath };
  const range = a.startLine === a.endLine ? `${a.startLine}` : `${a.startLine}-${a.endLine}`;
  return { id: a.id, label: `${basename(a.relPath)}:${range}`, detail: `${a.relPath} lines ${range}` };
}

/** Picks a backtick fence longer than any backtick run inside `text`. */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

export function formatSelection(a: Extract<ContextAttachment, { kind: "selection" }>): string {
  const fence = fenceFor(a.text);
  const range = a.startLine === a.endLine ? `line ${a.startLine}` : `lines ${a.startLine}-${a.endLine}`;
  const lang = /^[\w+-]+$/.test(a.languageId) ? a.languageId : "";
  const body = a.text.endsWith("\n") ? a.text : a.text + "\n";
  return `Selected code from \`${a.relPath}\` (${range}):\n${fence}${lang}\n${body}${fence}`;
}

export function buildPrompt(text: string, attachments: readonly ContextAttachment[]): PromptPayload {
  const files: PromptPayload["files"] = [];
  const seen = new Set<string>();
  const snippets: string[] = [];
  for (const a of attachments) {
    if (a.kind === "file") {
      if (seen.has(a.absPath)) continue;
      seen.add(a.absPath);
      files.push({ uri: pathToFileURL(a.absPath).href, name: a.relPath });
    } else {
      snippets.push(formatSelection(a));
    }
  }
  const parts = [text.trim(), ...snippets].filter((p) => p.length > 0);
  return { text: parts.join("\n\n"), files };
}

/** Validates a selection before it is attached. Returns an error message or undefined. */
export function validateSelection(text: string): string | undefined {
  if (text.trim().length === 0) return "The selection is empty.";
  if (text.length > MAX_SELECTION_CHARS) {
    return `The selection is too large (${text.length.toLocaleString()} characters). Attach the file instead or select fewer lines.`;
  }
  return undefined;
}
