// Strips credential-looking values from diagnostic log lines.

const REDACTIONS: Array<[RegExp, string]> = [
  [/(authorization["']?\s*[:=]\s*["']?)(basic|bearer)\s+[A-Za-z0-9+/=._-]+/gi, "$1$2 [redacted]"],
  [/\b(basic|bearer)\s+[A-Za-z0-9+/=._-]{12,}/gi, "$1 [redacted]"],
  [
    /("?(password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi,
    "$1[redacted]",
  ],
  [/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-key]"],
  [/:\/\/([^:/@\s]+):([^@/\s]+)@/g, "://$1:[redacted]@"],
];

/** Removes credential-looking values from a log line. */
export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}
