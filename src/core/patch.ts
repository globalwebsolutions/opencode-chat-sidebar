// Rebuilds the "before" and "after" contents of a file from an OpenCode
// full-file unified patch (session diff requested without `context`). The
// result feeds VS Code's native diff editor; nothing here renders a diff.

export interface FileSides {
  before: string;
  after: string;
}

/**
 * Returns both sides, or null when the patch is not a complete full-file patch
 * (binary, truncated, or hunks that do not cover the whole file). A null result
 * means agent-only content cannot be shown reliably for this file.
 */
export function reconstructSides(patch: string, status: "added" | "deleted" | "modified"): FileSides | null {
  if (!patch || /^Binary files /m.test(patch) || /^GIT binary patch/m.test(patch)) return null;
  const lines = patch.split("\n");
  const before: string[] = [];
  const after: string[] = [];
  let hunks = 0;
  let expectOldStart = 1;
  let expectNewStart = 1;
  let i = 0;
  let noEolOld = false;
  let noEolNew = false;
  // Skip headers up to the first hunk.
  while (i < lines.length && !lines[i].startsWith("@@")) i++;
  while (i < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
    if (!header) {
      if (lines[i] === "") {
        i++;
        continue;
      }
      return null;
    }
    hunks++;
    const oldStart = Number(header[1]);
    const oldLen = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newLen = header[4] === undefined ? 1 : Number(header[4]);
    // Full-file patches have exactly one hunk that starts at line 1 (or 0 for empty sides).
    const oldOk = oldLen === 0 ? oldStart === 0 || oldStart === expectOldStart : oldStart === expectOldStart;
    const newOk = newLen === 0 ? newStart === 0 || newStart === expectNewStart : newStart === expectNewStart;
    if (hunks > 1 || !oldOk || !newOk) return null;
    i++;
    let oldSeen = 0;
    let newSeen = 0;
    let last: "old" | "new" | "both" | null = null;
    while (i < lines.length && !lines[i].startsWith("@@")) {
      const l = lines[i];
      if (l.startsWith("\\")) {
        if (last === "old") noEolOld = true;
        else if (last === "new") noEolNew = true;
        else if (last === "both") noEolOld = noEolNew = true;
      } else if (l.startsWith("+")) {
        after.push(l.slice(1));
        newSeen++;
        last = "new";
      } else if (l.startsWith("-")) {
        before.push(l.slice(1));
        oldSeen++;
        last = "old";
      } else if (l.startsWith(" ")) {
        before.push(l.slice(1));
        after.push(l.slice(1));
        oldSeen++;
        newSeen++;
        last = "both";
      } else if (l === "" && i === lines.length - 1) {
        // trailing newline of the patch text
      } else {
        return null;
      }
      i++;
    }
    if (oldSeen !== oldLen || newSeen !== newLen) return null;
    expectOldStart += oldLen;
    expectNewStart += newLen;
  }
  if (hunks === 0) {
    // A pure mode change or empty file: both sides empty is only valid for added/deleted empty files.
    return status === "modified" ? null : { before: "", after: "" };
  }
  const join = (arr: string[], noEol: boolean) =>
    arr.length === 0 ? "" : arr.join("\n") + (noEol ? "" : "\n");
  return {
    before: status === "added" ? "" : join(before, noEolOld),
    after: status === "deleted" ? "" : join(after, noEolNew),
  };
}
