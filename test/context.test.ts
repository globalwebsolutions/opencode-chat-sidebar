import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPrompt, chipFor, fenceFor, MAX_SELECTION_CHARS, validateSelection } from "../src/core/context";
import type { ContextAttachment } from "../src/shared/model";
import { splitUserText } from "../src/shared/userText";

const file: ContextAttachment = {
  kind: "file",
  id: "1",
  relPath: "app/Checkout.php",
  absPath: "/repo/app/Checkout.php",
};
const sel: ContextAttachment = {
  kind: "selection",
  id: "2",
  relPath: "app/Checkout.php",
  absPath: "/repo/app/Checkout.php",
  startLine: 10,
  endLine: 14,
  text: "$total = 0;\nforeach ($items as $i) {\n  $total += $i->price;\n}\nreturn $total;",
  languageId: "php",
};

describe("context attachments", () => {
  it("sends whole files as OpenCode file attachments, not inline text", () => {
    const p = buildPrompt("Explain", [file]);
    assert.equal(p.text, "Explain");
    assert.deepEqual(p.files, [{ uri: "file:///repo/app/Checkout.php", name: "app/Checkout.php" }]);
  });

  it("inlines only the selected lines with path and line range", () => {
    const p = buildPrompt("Explain only this selection", [sel]);
    assert.equal(p.files.length, 0);
    assert.match(
      p.text,
      /^Explain only this selection\n\nSelected code from `app\/Checkout\.php` \(lines 10-14\):\n```php\n/,
    );
    assert.ok(p.text.includes("$total += $i->price;"));
    assert.ok(p.text.trimEnd().endsWith("```"));
  });

  it("deduplicates file attachments", () => {
    assert.equal(buildPrompt("x", [file, { ...file, id: "3" }]).files.length, 1);
  });

  it("uses a longer fence when the selection contains backticks", () => {
    assert.equal(fenceFor("no ticks"), "```");
    assert.equal(fenceFor("has ``` fence"), "````");
  });

  it("encodes special characters in file URIs", () => {
    const p = buildPrompt("x", [{ ...file, absPath: "/repo/my file#1.php" }]);
    assert.equal(p.files[0].uri, "file:///repo/my%20file%231.php");
  });

  it("formats chips", () => {
    assert.deepEqual(chipFor(file), { id: "1", label: "Checkout.php", detail: "app/Checkout.php" });
    assert.equal(chipFor(sel).label, "Checkout.php:10-14");
    assert.equal(chipFor({ ...sel, endLine: 10 }).label, "Checkout.php:10");
  });

  it("rejects empty and oversized selections", () => {
    assert.ok(validateSelection("   \n"));
    assert.ok(validateSelection("x".repeat(MAX_SELECTION_CHARS + 1)));
    assert.equal(validateSelection("ok"), undefined);
  });

  it("round-trips: sent selections are shown as chips in the transcript", () => {
    const p = buildPrompt("Explain only this selection", [
      sel,
      { ...sel, id: "4", startLine: 3, endLine: 3, text: "x" },
    ]);
    const split = splitUserText(p.text);
    assert.equal(split.text, "Explain only this selection");
    assert.deepEqual(split.snippets, ["Checkout.php:10-14", "Checkout.php:3"]);
  });

  it("leaves ordinary user text untouched", () => {
    assert.deepEqual(splitUserText("hello `world`"), { text: "hello `world`", snippets: [] });
  });
});
