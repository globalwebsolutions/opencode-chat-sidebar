// Splits a sent prompt back into the user's own words and the selection
// snippets appended by src/core/context.ts, so the transcript shows chips
// instead of a wall of code.

const SNIPPET =
  /\n*Selected code from `([^`\n]+)` \((lines? [0-9]+(?:-[0-9]+)?)\):\n(`{3,})[^\n]*\n[\s\S]*?\n\3(?=\n|$)/g;

export interface SplitUserText {
  text: string;
  snippets: string[];
}

export function splitUserText(full: string): SplitUserText {
  const snippets: string[] = [];
  const text = full.replace(SNIPPET, (_m, path: string, range: string) => {
    const base = path.split(/[\\/]/).pop() ?? path;
    snippets.push(`${base}:${range.replace(/^lines? /, "")}`);
    return "";
  });
  return { text: text.trim(), snippets };
}
