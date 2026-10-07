// Small Markdown parser for chat output. It produces an AST that the webview
// renders with DOM APIs (textContent / createElement) — never innerHTML — so
// model output cannot inject markup or scripts.
//
// Supported: paragraphs, ATX headings, fenced code, lists (nested by indent),
// blockquotes, horizontal rules, GFM tables, inline code, bold, italic,
// strikethrough, links, autolinks and hard line breaks.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Align = "" | "left" | "center" | "right";

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "code"; lang: string; text: string; closed: boolean }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "quote"; c: Block[] }
  | { t: "hr" }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Returns true for hrefs that may be rendered as links (no javascript:, data:, etc.). */
export function isSafeHref(href: string): boolean {
  const h = href.trim();
  if (!h) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(h);
  if (!scheme) return !/^\s*\/\//.test(h); // relative path; reject protocol-relative
  return ["http", "https", "file", "mailto"].includes(scheme[1].toLowerCase());
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  return parseBlocks(lines);
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEP.test(next) && next.includes("-"))
  );
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const l = lines[i];
        const trimmed = l.trim();
        if (
          trimmed.startsWith(marker[0].repeat(marker.length)) &&
          /^([`~])\1*$/.test(trimmed) &&
          trimmed[0] === marker[0]
        ) {
          closed = true;
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      blocks.push({ t: "code", lang: fence[2] ?? "", text: body.join("\n"), closed });
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: "h", level: heading[1].length, c: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && !isBlank(lines[i])) {
        const q = QUOTE.exec(lines[i]);
        inner.push(q ? q[1] : lines[i]);
        i++;
      }
      blocks.push({ t: "quote", c: parseBlocks(inner) });
      continue;
    }

    const next = lines[i + 1];
    if (line.includes("|") && next !== undefined && TABLE_SEP.test(next) && next.includes("-")) {
      const head = splitRow(line);
      const align = splitRow(next).map(alignOf);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]).map((cell) => parseInline(cell)));
        i++;
      }
      blocks.push({ t: "table", align, head: head.map((cell) => parseInline(cell)), rows });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const start = ordered ? parseInt(item[2], 10) : 1;
      const baseIndent = item[1].length;
      const items: Block[][] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
        const contentIndent = m[1].length + m[2].length + 1;
        const itemLines = [m[3]];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (isBlank(l)) {
            // A blank line continues the item only if followed by indented content.
            const after = lines[i + 1];
            if (after !== undefined && /^\s+/.test(after) && leadingSpaces(after) >= contentIndent) {
              itemLines.push("");
              i++;
              continue;
            }
            break;
          }
          const lead = leadingSpaces(l);
          if (lead >= Math.min(contentIndent, baseIndent + 2)) {
            itemLines.push(l.slice(Math.min(lead, contentIndent)));
            i++;
            continue;
          }
          if (LIST_ITEM.test(l) || startsBlock(l, lines[i + 1])) break;
          itemLines.push(l.trim()); // lazy continuation
          i++;
        }
        items.push(parseBlocks(itemLines));
        while (
          i < lines.length &&
          isBlank(lines[i]) &&
          LIST_ITEM.exec(lines[i + 1] ?? "")?.[1].length === baseIndent
        )
          i++;
      }
      blocks.push({ t: "list", ordered, start, items });
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      (para.length === 0 || !startsBlock(lines[i], lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ t: "p", c: parseInline(para.join("\n")) });
  }
  return blocks;
}

function leadingSpaces(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
      cur += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function alignOf(cell: string): Align {
  const c = cell.trim();
  const left = c.startsWith(":");
  const right = c.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : "";
}

const AUTOLINK = /^<(https?:\/\/[^\s>]+)>/;
const BARE_URL = /^https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);

    if (ch === "\\" && i + 1 < src.length) {
      if (src[i + 1] === "\n") {
        flush();
        out.push({ t: "br" });
        i += 2;
        continue;
      }
      if (/[\\`*_{}[\]()#+\-.!|~<>]/.test(src[i + 1])) {
        text += src[i + 1];
        i += 2;
        continue;
      }
    }

    if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }

    if (ch === "`") {
      const run = /^`+/.exec(rest)![0];
      const close = src.indexOf(run, i + run.length);
      if (close > 0) {
        flush();
        let code = src.slice(i + run.length, close);
        if (/^ .* $/.test(code)) code = code.slice(1, -1);
        out.push({ t: "code", v: code.replace(/\n/g, " ") });
        i = close + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }

    const auto = AUTOLINK.exec(rest);
    if (auto) {
      flush();
      out.push({ t: "link", href: auto[1], c: [{ t: "text", v: auto[1] }] });
      i += auto[0].length;
      continue;
    }

    if (ch === "[") {
      const link = parseLink(src, i);
      if (link) {
        flush();
        const children = parseInline(link.label);
        if (isSafeHref(link.href)) out.push({ t: "link", href: link.href, c: children });
        else out.push(...children);
        i = link.end;
        continue;
      }
    }

    if ((ch === "*" || ch === "_" || ch === "~") && src[i + 1] === ch) {
      const marker = ch + ch;
      const close = findClose(src, i + 2, marker);
      if (close > i + 2) {
        flush();
        const inner = parseInline(src.slice(i + 2, close));
        out.push(ch === "~" ? { t: "del", c: inner } : { t: "strong", c: inner });
        i = close + 2;
        continue;
      }
    }

    if (
      (ch === "*" || ch === "_") &&
      src[i + 1] !== ch &&
      src[i + 1] !== undefined &&
      !/\s/.test(src[i + 1])
    ) {
      // `_` inside words (snake_case) is not emphasis.
      const prev = src[i - 1];
      if (!(ch === "_" && prev !== undefined && /[A-Za-z0-9]/.test(prev))) {
        const close = findClose(src, i + 1, ch);
        if (
          close > i + 1 &&
          !/\s/.test(src[close - 1]) &&
          !(ch === "_" && /[A-Za-z0-9]/.test(src[close + 1] ?? ""))
        ) {
          flush();
          out.push({ t: "em", c: parseInline(src.slice(i + 1, close)) });
          i = close + 1;
          continue;
        }
      }
    }

    if ((ch === "h" || ch === "H") && (i === 0 || /[\s(]/.test(src[i - 1]))) {
      const bare = BARE_URL.exec(rest);
      if (bare) {
        flush();
        out.push({ t: "link", href: bare[0], c: [{ t: "text", v: bare[0] }] });
        i += bare[0].length;
        continue;
      }
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}

function findClose(src: string, from: number, marker: string): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (src[i] === "`") {
      const run = /^`+/.exec(src.slice(i))![0];
      const end = src.indexOf(run, i + run.length);
      i = end < 0 ? i + run.length : end + run.length;
      continue;
    }
    if (src.startsWith(marker, i) && (marker.length === 2 || src[i + 1] !== marker)) return i;
    i++;
  }
  return -1;
}

function parseLink(src: string, start: number): { label: string; href: string; end: number } | null {
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] === "[") depth++;
    else if (src[i] === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || src[i + 1] !== "(") return null;
  const label = src.slice(start + 1, i);
  let j = i + 2;
  let parens = 1;
  for (; j < src.length; j++) {
    if (src[j] === "(") parens++;
    else if (src[j] === ")") {
      parens--;
      if (parens === 0) break;
    } else if (src[j] === "\n") return null;
  }
  if (parens !== 0) return null;
  let href = src.slice(i + 2, j).trim();
  const titled = /^(\S+)\s+["'(].*["')]$/.exec(href);
  if (titled) href = titled[1];
  if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1);
  return { label, href, end: j + 1 };
}
