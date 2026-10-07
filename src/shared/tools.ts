import type { FileChange, ToolCategory } from "./model";

export interface ToolDescription {
  title: string;
  category: ToolCategory;
  facts: Array<[string, string]>;
  command: string | null;
}

const MAX_FACT = 300;

function str(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function clip(value: string, max = MAX_FACT): string {
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

export function categorize(name: string): ToolCategory {
  const n = name.toLowerCase();
  if (/^(read|view|cat|open)/.test(n)) return "read";
  if (/(grep|glob|find|search|list|ls|codesearch)/.test(n) && !/web/.test(n)) return "search";
  if (/(shell|bash|exec|command|terminal)/.test(n)) return "shell";
  if (/(edit|write|patch|replace|create|delete|move|rename)/.test(n)) return "edit";
  if (/(web|fetch|http|url)/.test(n)) return "web";
  if (/(task|agent|subagent)/.test(n)) return "agent";
  return "other";
}

/** Builds a compact, human-readable description of a tool call from its name and input. */
export function describeTool(name: string, input: Record<string, unknown> | null): ToolDescription {
  const category = categorize(name);
  const inp = input ?? {};
  const path =
    str(inp.path) ?? str(inp.filePath) ?? str(inp.file_path) ?? str(inp.file) ?? str(inp.target) ?? null;
  const pattern = str(inp.pattern) ?? str(inp.query) ?? str(inp.glob) ?? null;
  const command = category === "shell" ? (str(inp.command) ?? str(inp.cmd) ?? null) : null;
  const facts: Array<[string, string]> = [];

  for (const [key, value] of Object.entries(inp)) {
    if (category === "edit" && /^(oldString|newString|content|patch|diff|old_string|new_string)$/.test(key)) {
      continue; // shown via the diff editor instead of inline
    }
    if (key === "command" && command) continue;
    const s = str(value);
    if (s !== null) facts.push([key, clip(s)]);
    else if (Array.isArray(value)) facts.push([key, clip(value.map((v) => str(v) ?? "…").join(", "))]);
  }

  let title: string;
  switch (category) {
    case "read":
      title = path ? `Read ${basename(path)}` : "Read file";
      break;
    case "search":
      title = pattern
        ? `Searched ${clip(pattern, 60)}`
        : path
          ? `Listed ${basename(path)}`
          : "Searched files";
      break;
    case "shell":
      title = command ? clip(firstLine(command), 80) : "Ran command";
      break;
    case "edit":
      title = path ? `Edited ${basename(path)}` : "Edited files";
      break;
    case "web": {
      const url = str(inp.url) ?? pattern;
      title = url ? `Fetched ${clip(url, 60)}` : "Web request";
      break;
    }
    case "agent": {
      const desc = str(inp.description) ?? str(inp.prompt);
      title = desc ? `Subagent: ${clip(firstLine(desc), 60)}` : "Ran subagent";
      break;
    }
    default:
      title = name;
  }
  return { title, category, facts, command };
}

function firstLine(text: string): string {
  const i = text.indexOf("\n");
  return i < 0 ? text : text.slice(0, i) + " …";
}

/** Extracts per-file change counts from edit-tool metadata (`metadata.files`). */
export function fileChangesFromMetadata(metadata: Record<string, unknown> | null): FileChange[] {
  const files = metadata?.files;
  if (!Array.isArray(files)) return [];
  const out: FileChange[] = [];
  for (const f of files) {
    if (!f || typeof f !== "object") continue;
    const rec = f as Record<string, unknown>;
    const path = str(rec.file) ?? str(rec.path);
    if (!path) continue;
    const status = rec.status === "added" || rec.status === "deleted" ? rec.status : "modified";
    out.push({
      path,
      additions: typeof rec.additions === "number" ? rec.additions : 0,
      deletions: typeof rec.deletions === "number" ? rec.deletions : 0,
      status,
    });
  }
  return out;
}

export function mergeFileChanges(into: Map<string, FileChange>, changes: FileChange[]): void {
  for (const c of changes) {
    const prev = into.get(c.path);
    if (!prev) into.set(c.path, { ...c });
    else
      into.set(c.path, {
        path: c.path,
        additions: prev.additions + c.additions,
        deletions: prev.deletions + c.deletions,
        status: prev.status === "added" ? "added" : c.status,
      });
  }
}
