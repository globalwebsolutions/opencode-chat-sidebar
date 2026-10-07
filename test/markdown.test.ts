import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSafeHref, parseInline, parseMarkdown } from "../src/webview/markdown";

describe("markdown parser", () => {
  it("parses fenced code with language and keeps content verbatim", () => {
    const b = parseMarkdown("Intro\n\n```php\n<?php echo '<b>'; ?>\n```\nAfter");
    assert.deepEqual(b[1], { t: "code", lang: "php", text: "<?php echo '<b>'; ?>", closed: true });
    assert.equal(b[2].t, "p");
  });

  it("treats an unclosed fence (still streaming) as code", () => {
    const b = parseMarkdown("```ts\nconst a = 1;");
    assert.deepEqual(b[0], { t: "code", lang: "ts", text: "const a = 1;", closed: false });
  });

  it("parses headings, lists, nested lists and quotes", () => {
    const b = parseMarkdown("## Title\n- one\n- two\n  - nested\n1. first\n2. second\n\n> quoted");
    assert.equal(b[0].t, "h");
    assert.ok(b[1].t === "list" && !b[1].ordered && b[1].items.length === 2);
    assert.ok(b[1].t === "list" && b[1].items[1].some((x) => x.t === "list"));
    assert.ok(b[2].t === "list" && b[2].ordered && b[2].items.length === 2);
    assert.equal(b[3].t, "quote");
  });

  it("parses GFM tables with alignment", () => {
    const b = parseMarkdown("| File | +/- |\n|:--|--:|\n| a.ts | `+3` |\n| b\\|c | 1 |");
    assert.ok(b[0].t === "table");
    if (b[0].t === "table") {
      assert.deepEqual(b[0].align, ["left", "right"]);
      assert.equal(b[0].rows.length, 2);
      assert.deepEqual(b[0].rows[1][0], [{ t: "text", v: "b|c" }]);
    }
  });

  it("parses inline formatting", () => {
    assert.deepEqual(parseInline("**bold** and *em* and `code` and ~~del~~"), [
      { t: "strong", c: [{ t: "text", v: "bold" }] },
      { t: "text", v: " and " },
      { t: "em", c: [{ t: "text", v: "em" }] },
      { t: "text", v: " and " },
      { t: "code", v: "code" },
      { t: "text", v: " and " },
      { t: "del", c: [{ t: "text", v: "del" }] },
    ]);
  });

  it("does not treat snake_case as emphasis", () => {
    assert.deepEqual(parseInline("use snake_case_name here"), [{ t: "text", v: "use snake_case_name here" }]);
  });

  it("parses links and autolinks, dropping unsafe schemes", () => {
    assert.deepEqual(parseInline("[docs](https://opencode.ai)"), [
      { t: "link", href: "https://opencode.ai", c: [{ t: "text", v: "docs" }] },
    ]);
    assert.deepEqual(parseInline("see https://example.com/x."), [
      { t: "text", v: "see " },
      { t: "link", href: "https://example.com/x", c: [{ t: "text", v: "https://example.com/x" }] },
      { t: "text", v: "." },
    ]);
    assert.deepEqual(parseInline("[click](javascript:alert(1))"), [{ t: "text", v: "click" }]);
    assert.equal(isSafeHref("data:text/html,x"), false);
    assert.equal(isSafeHref("//evil.example"), false);
    assert.equal(isSafeHref("src/app.ts:12"), true);
  });

  it("keeps raw HTML as text", () => {
    assert.deepEqual(parseInline("<script>alert(1)</script>"), [
      { t: "text", v: "<script>alert(1)</script>" },
    ]);
  });

  it("renders single newlines as line breaks", () => {
    assert.deepEqual(parseInline("a\nb"), [{ t: "text", v: "a" }, { t: "br" }, { t: "text", v: "b" }]);
  });
});
