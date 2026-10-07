// Session title hygiene. OpenCode generates titles with a small model; a few
// come back as instructions or truncated junk. Those are replaced locally with
// a concise title derived from the first user message (no extra model call).

const BAD_TITLE = [
  /\btitle only\b/i,
  /^we need (a |the )?title/i,
  /\bmassive request\b/i,
  /^(generate|create|write) (a |the )?title/i,
  /^(here is|here's|sure[,!]?|okay[,!]?)\b/i,
  /^(untitled|new session|title)$/i,
];

export const MAX_TITLE = 80;

export function isUsableTitle(title: string | null | undefined): title is string {
  if (!title) return false;
  const t = title.trim();
  if (t.length < 2 || t.length > MAX_TITLE) return false;
  if (/[\r\n]/.test(t)) return false;
  return !BAD_TITLE.some((re) => re.test(t));
}

/** Concise fallback from the first user message: first non-empty line, trimmed to ~60 chars at a word boundary. */
export function fallbackTitle(firstUserText: string | null | undefined): string | null {
  if (!firstUserText) return null;
  const line = firstUserText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const plain = line
    .replace(/[`*_#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= 60) return plain;
  const cut = plain.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return (space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, "") + "…";
}

export function displayTitle(
  title: string | null | undefined,
  firstUserText: string | null | undefined,
): string {
  if (isUsableTitle(title)) return title.trim();
  return fallbackTitle(firstUserText) ?? "Untitled session";
}
