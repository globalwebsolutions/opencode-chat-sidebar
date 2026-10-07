import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconstructSides } from "../src/core/patch";

// Real shape returned by OpenCode for a session diff without `context` (full-file patch).
const FULL = `diff --git a/big.txt b/big.txt
index 1ab0ab4..0215f20 100644
--- a/big.txt
+++ b/big.txt
@@ -1,5 +1,5 @@
 line 1
 line 2
-line 3
+line three
 line 4
 user dirty line
`;

describe("agent snapshot reconstruction", () => {
  it("rebuilds both sides of a full-file patch, keeping pre-existing user changes in the baseline", () => {
    const s = reconstructSides(FULL, "modified");
    assert.deepEqual(s, {
      before: "line 1\nline 2\nline 3\nline 4\nuser dirty line\n",
      after: "line 1\nline 2\nline three\nline 4\nuser dirty line\n",
    });
  });

  it("handles added and deleted files", () => {
    assert.deepEqual(reconstructSides("--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n", "added"), {
      before: "",
      after: "a\nb\n",
    });
    assert.deepEqual(reconstructSides("--- a/o.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n", "deleted"), {
      before: "a\nb\n",
      after: "",
    });
  });

  it("respects 'No newline at end of file' markers", () => {
    const p = "@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
    assert.deepEqual(reconstructSides(p, "modified"), { before: "old", after: "new" });
  });

  it("refuses partial (context-limited) patches instead of guessing", () => {
    const partial = "@@ -18,5 +18,5 @@\n line 18\n line 19\n-line 20\n+line twenty\n line 21\n";
    assert.equal(reconstructSides(partial, "modified"), null);
    const twoHunks = "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -10,1 +10,1 @@\n-c\n+d\n";
    assert.equal(reconstructSides(twoHunks, "modified"), null);
  });

  it("refuses binary or inconsistent patches", () => {
    assert.equal(reconstructSides("Binary files a/x.png and b/x.png differ\n", "modified"), null);
    assert.equal(
      reconstructSides("@@ -1,3 +1,3 @@\n a\n-b\n+c\n", "modified"),
      null,
      "line counts do not match header",
    );
    assert.equal(reconstructSides("", "modified"), null);
  });
});
