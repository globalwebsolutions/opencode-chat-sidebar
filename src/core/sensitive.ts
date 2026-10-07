// Detects clearly sensitive paths in permission requests so the UI can show an
// extra warning. This never reads files; it only inspects path strings.

export interface SensitiveMatch {
  value: string;
  reason: string;
}

const TEMPLATE_SUFFIX = /\.(example|sample|template|dist|defaults?)$/i;

interface Rule {
  test: (segments: string[], base: string, full: string) => boolean;
  reason: string;
}

const RULES: Rule[] = [
  {
    test: (_s, base) => (base === ".env" || /^\.env\..+/.test(base)) && !TEMPLATE_SUFFIX.test(base),
    reason: "Environment file — may contain secrets",
  },
  {
    test: (_s, base) =>
      /\.env$/i.test(base) &&
      base !== ".env" &&
      !TEMPLATE_SUFFIX.test(base) &&
      /secret|prod|local/i.test(base),
    reason: "Environment file — may contain secrets",
  },
  { test: (s) => s.includes(".ssh"), reason: "SSH directory" },
  { test: (_s, base) => /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.pub)?$/.test(base), reason: "SSH key" },
  { test: (s) => s.includes(".gnupg"), reason: "GnuPG keyring" },
  { test: (_s, base) => /\.(pem|key|ppk|p8|der)$/i.test(base), reason: "Private key / certificate" },
  { test: (_s, base) => /\.(jks|keystore|p12|pfx|bks)$/i.test(base), reason: "Keystore" },
  { test: (_s, _b, full) => /(^|\/)\.aws\/(credentials|config)$/.test(full), reason: "AWS credentials" },
  { test: (_s, _b, full) => /(^|\/)\.kube\/config$/.test(full), reason: "Kubernetes credentials" },
  { test: (_s, _b, full) => /(^|\/)\.docker\/config\.json$/.test(full), reason: "Docker credentials" },
  { test: (_s, _b, full) => /(^|\/)\.config\/gcloud\//.test(full), reason: "Google Cloud credentials" },
  {
    test: (_s, base) =>
      /^(\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|\.pgpass|\.htpasswd|credentials(\.json)?|application_default_credentials\.json|service[-_]?account.*\.json|auth\.json)$/i.test(
        base,
      ),
    reason: "Credential file",
  },
  {
    test: (_s, base) => /^(secrets?|vault)(\.[a-z0-9]+)*$/i.test(base) && !TEMPLATE_SUFFIX.test(base),
    reason: "Secrets file",
  },
];

/** Classifies a single path-like string. */
export function classifyPath(value: string): SensitiveMatch | undefined {
  const cleaned = value.trim().replace(/^['"`]+|['"`;,)]+$/g, "");
  if (!cleaned || cleaned === "*" || cleaned.length > 4096) return undefined;
  const full = cleaned.replace(/\\/g, "/");
  const segments = full.split("/").filter(Boolean);
  if (!segments.length) return undefined;
  const base = segments[segments.length - 1];
  for (const rule of RULES) {
    if (rule.test(segments, base, full)) return { value: cleaned, reason: rule.reason };
  }
  return undefined;
}

/**
 * Scans permission resources (paths, globs or shell commands) for sensitive
 * paths. Shell commands are tokenized on whitespace and common separators.
 */
export function findSensitive(resources: readonly string[]): SensitiveMatch[] {
  const seen = new Set<string>();
  const out: SensitiveMatch[] = [];
  for (const resource of resources) {
    const tokens = resource.split(/[\s|&;<>()=]+/).filter(Boolean);
    for (const token of [resource, ...tokens]) {
      const match = classifyPath(token);
      if (match && !seen.has(match.value)) {
        seen.add(match.value);
        out.push(match);
      }
    }
  }
  return out;
}
