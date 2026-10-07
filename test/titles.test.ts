import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayTitle, fallbackTitle, isUsableTitle } from "../src/core/titles";

describe("session titles", () => {
  it("keeps good OpenCode titles", () => {
    assert.ok(isUsableTitle("Fix checkout totals"));
    assert.equal(displayTitle("Choosing between red and blue", "x"), "Choosing between red and blue");
    assert.ok(isUsableTitle("إصلاح حساب المجموع"));
  });

  it("rejects broken generated titles", () => {
    for (const t of [
      "We need title only. Massive request title...",
      "Title only: implement everything",
      "Here is a title for your request",
      "",
      "x".repeat(200),
      "line one\nline two",
      "New session",
    ]) {
      assert.equal(isUsableTitle(t), false, t);
    }
  });

  it("derives a concise fallback from the first user message", () => {
    assert.equal(
      fallbackTitle("Run git status only. Do not modify anything."),
      "Run git status only. Do not modify anything.",
    );
    const long = fallbackTitle(
      "Continue and COMPLETE the existing release implementation across inventory, billing, staffing and reporting modules",
    );
    assert.ok(long && long.length <= 61 && long.endsWith("…"), long ?? "");
    assert.equal(fallbackTitle("\n\n  **Fix** the `bug`\nmore"), "Fix the bug");
    assert.equal(fallbackTitle(""), null);
    assert.equal(displayTitle("We need title only", null), "Untitled session");
  });
});
