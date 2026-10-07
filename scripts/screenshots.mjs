// Renders Marketplace screenshots from the real webview bundle (dist/webview.js)
// with generic demo data and VS Code "Dark Modern" colors. Usage: npm run build && node scripts/screenshots.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const out = path.join(root, "docs", "marketplace", "screenshots");
const chrome = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => p && fs.existsSync(p));
const DARK = {
  "--vscode-foreground": "#cccccc",
  "--vscode-descriptionForeground": "#9d9d9d",
  "--vscode-sideBar-background": "#181818",
  "--vscode-font-family": "-apple-system, 'Segoe UI', sans-serif",
  "--vscode-font-size": "13px",
  "--vscode-editor-font-family": "Menlo, Consolas, monospace",
  "--vscode-widget-border": "#313131",
  "--vscode-input-background": "#313131",
  "--vscode-input-foreground": "#cccccc",
  "--vscode-input-border": "#3c3c3c",
  "--vscode-button-background": "#0078d4",
  "--vscode-button-foreground": "#ffffff",
  "--vscode-button-hoverBackground": "#026ec1",
  "--vscode-button-secondaryBackground": "#313131",
  "--vscode-button-secondaryForeground": "#cccccc",
  "--vscode-dropdown-background": "#313131",
  "--vscode-dropdown-foreground": "#cccccc",
  "--vscode-dropdown-border": "#3c3c3c",
  "--vscode-badge-background": "#616161",
  "--vscode-badge-foreground": "#f8f8f8",
  "--vscode-textLink-foreground": "#4daafc",
  "--vscode-textCodeBlock-background": "#2b2b2b",
  "--vscode-focusBorder": "#0078d4",
  "--vscode-errorForeground": "#f85149",
  "--vscode-inputValidation-warningBackground": "#352a05",
  "--vscode-inputValidation-warningBorder": "#b89500",
  "--vscode-inputValidation-errorBackground": "#5a1d1d",
  "--vscode-inputValidation-errorBorder": "#be1100",
  "--vscode-gitDecoration-addedResourceForeground": "#81b88b",
  "--vscode-gitDecoration-deletedResourceForeground": "#c74e39",
  "--vscode-list-hoverBackground": "#2a2d2e",
  "--vscode-list-inactiveSelectionBackground": "#37373d",
  "--vscode-editorWidget-background": "#202020",
  "--vscode-testing-iconPassed": "#73c991",
  "--vscode-progressBar-background": "#0078d4",
  "--vscode-toolbar-hoverBackground": "#5a5d5e50",
  "--vscode-terminal-background": "#181818",
};
const css = Object.entries(DARK)
  .map(([k, v]) => `${k}:${v}`)
  .join(";");
const D = (o = {}) => ({
  facts: [],
  command: null,
  cwd: null,
  output: null,
  outputTruncated: false,
  exitCode: null,
  files: [],
  error: null,
  ...o,
});
const models = [
  {
    key: "opencode-go/kimi-k2.7-code",
    providerID: "opencode-go",
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    providerName: "OpenCode Go",
    contextLimit: 262144,
    variants: [],
  },
  {
    key: "opencode-go/qwen3.7-plus",
    providerID: "opencode-go",
    id: "qwen3.7-plus",
    name: "Qwen3.7 Plus",
    providerName: "OpenCode Go",
    contextLimit: 262144,
    variants: ["none", "high", "max"],
  },
];
const base = (o = {}) => ({
  connection: { kind: "connected", version: "2.x", url: "http://127.0.0.1" },
  workspace: {
    active: { name: "acme-shop", path: "/projects/acme-shop" },
    folders: [{ name: "acme-shop", path: "/projects/acme-shop" }],
    branch: "feature/checkout-totals",
    detachedAt: null,
    repoKind: "local",
    repoRoot: "/projects/acme-shop",
    mainWorktree: null,
    uncommitted: 3,
  },
  models,
  agents: [
    { id: "build", name: "Build" },
    { id: "plan", name: "Plan" },
  ],
  selectedModel: "opencode-go/qwen3.7-plus",
  selectedAgent: "build",
  selectedVariant: "high",
  sessions: [],
  currentSession: { id: "s", title: "Fix checkout total rounding" },
  busy: false,
  stopping: false,
  attachments: [],
  agentChanges: { status: "none" },
  workspaceChanges: { count: 3 },
  usage: { contextTokens: 42100, contextLimit: 262144, cost: 0.08 },
  steps: 14,
  budget: {
    level: "medium",
    limits: { maxCost: 0.3, maxSteps: 50 },
    taskCost: 0.03,
    taskSteps: 5,
    active: false,
    state: "ok",
    allowance: 1,
  },
  budgetPresets: {
    small: { maxCost: 0.1, maxSteps: 20 },
    medium: { maxCost: 0.3, maxSteps: 50 },
    large: { maxCost: 1, maxSteps: 120 },
    custom: { maxCost: 0.5, maxSteps: 80 },
  },
  pending: [],
  locale: "en",
  showPlacementHint: false,
  ...o,
});
const report =
  "## Checkout totals\n\nThe rounding error comes from summing **rounded** line totals.\n\n| Step | Change |\n|:--|:--|\n| 1 | Sum raw prices |\n| 2 | Round once at the end |\n\n```ts\nconst total = round(lines.reduce((s, l) => s + l.price * l.qty, 0));\n```";
const scenes = {
  "1-chat": {
    state: base({ attachments: [{ id: "a", label: "cart.ts:40-58", detail: "src/cart.ts lines 40-58" }] }),
    items: [
      {
        kind: "user",
        id: "u1",
        text: "Why is the checkout total sometimes off by a cent?",
        attachments: ["cart.ts:40-58"],
      },
      {
        kind: "tool",
        id: "t1",
        name: "read",
        title: "Read cart.ts",
        category: "read",
        status: "completed",
        detail: D(),
      },
      {
        kind: "tool",
        id: "t2",
        name: "shell",
        title: "npm test -- cart",
        category: "shell",
        status: "completed",
        detail: D({ command: "npm test -- cart", exitCode: 0 }),
      },
      { kind: "assistant", id: "a1", text: report, streaming: false },
    ],
  },
  "2-budget": {
    state: base({
      budget: {
        level: "small",
        limits: { maxCost: 0.1, maxSteps: 20 },
        taskCost: 0.06,
        taskSteps: 20,
        active: false,
        state: "exceeded",
        allowance: 1,
      },
      steps: 20,
    }),
    items: [
      { kind: "user", id: "u1", text: "Refactor every module to the new logger.", attachments: [] },
      {
        kind: "tool",
        id: "t1",
        name: "edit",
        title: "Edited logger.ts",
        category: "edit",
        status: "completed",
        detail: D({ files: [{ path: "src/logger.ts", additions: 18, deletions: 6, status: "modified" }] }),
      },
      {
        kind: "budget",
        id: "b1",
        state: "warning",
        text: "Task budget is nearly exhausted.",
        resolved: null,
      },
      {
        kind: "tool",
        id: "t2",
        name: "edit",
        title: "Edited orders.ts",
        category: "edit",
        status: "completed",
        detail: D({ files: [{ path: "src/orders.ts", additions: 9, deletions: 4, status: "modified" }] }),
      },
      { kind: "notice", id: "n1", level: "info", text: "Stopped." },
      {
        kind: "budget",
        id: "b2",
        state: "stopped",
        text: "Task budget reached. The agent was stopped.",
        resolved: null,
      },
    ],
  },
  "3-agent-changes": {
    state: base({
      agentChanges: {
        status: "ok",
        files: [
          { path: "src/cart.ts", additions: 6, deletions: 3, status: "modified" },
          { path: "test/cart.test.ts", additions: 24, deletions: 0, status: "added" },
        ],
      },
    }),
    items: [
      { kind: "user", id: "u1", text: "Fix the rounding and add a regression test.", attachments: [] },
      {
        kind: "tool",
        id: "t1",
        name: "edit",
        title: "Edited cart.ts",
        category: "edit",
        status: "completed",
        detail: D({ files: [{ path: "src/cart.ts", additions: 6, deletions: 3, status: "modified" }] }),
      },
      {
        kind: "tool",
        id: "t2",
        name: "write",
        title: "Edited cart.test.ts",
        category: "edit",
        status: "completed",
        detail: D({ files: [{ path: "test/cart.test.ts", additions: 24, deletions: 0, status: "added" }] }),
      },
      {
        kind: "tool",
        id: "t3",
        name: "shell",
        title: "npm test -- cart",
        category: "shell",
        status: "completed",
        detail: D({ command: "npm test -- cart", exitCode: 0 }),
      },
      {
        kind: "turn-summary",
        id: "s1",
        files: [
          { path: "src/cart.ts", additions: 6, deletions: 3, status: "modified" },
          { path: "test/cart.test.ts", additions: 24, deletions: 0, status: "added" },
        ],
      },
      {
        kind: "assistant",
        id: "a1",
        text: "Done. Totals are now rounded once, and `cart.test.ts` covers the case.",
        streaming: false,
      },
    ],
    open: true,
  },
  "4-question-steer": {
    state: base({
      busy: true,
      budget: {
        level: "medium",
        limits: { maxCost: 0.3, maxSteps: 50 },
        taskCost: 0.02,
        taskSteps: 4,
        active: true,
        state: "ok",
        allowance: 1,
      },
      pending: [
        { id: "q", text: "After that, run only the cart tests.", attachments: [], delivery: "queue" },
      ],
    }),
    items: [
      { kind: "user", id: "u1", text: "Add a currency formatter for the receipt.", attachments: [] },
      {
        kind: "form",
        id: "form:f1",
        status: "pending",
        answer: null,
        form: {
          id: "f1",
          sessionID: "s",
          title: "Questions",
          toolId: null,
          fields: [
            {
              key: "q0",
              type: "string",
              title: "Currency display",
              description: "How should prices appear on the receipt?",
              options: [
                { value: "symbol", label: "Symbol ($12.50)" },
                { value: "code", label: "ISO code (USD 12.50)" },
              ],
              custom: true,
            },
          ],
        },
      },
    ],
  },
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-shots-"));
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
for (const [name, scene] of Object.entries(scenes)) {
  const html = path.join(dir, `${name}.html`);
  fs.writeFileSync(
    html,
    `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="file://${path.join(root, "media", "main.css")}"><style>:root{${css}} body{background:#181818}</style></head><body><div id="app"></div><script>window.acquireVsCodeApi=()=>({postMessage(){},getState(){},setState(){}});</script><script src="file://${path.join(root, "dist", "webview.js")}"></script></body></html>`,
  );
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 860, deviceScaleFactor: 2 });
  await page.goto("file://" + html);
  await page.evaluate((s) => {
    window.postMessage({ type: "state", state: s.state }, "*");
    window.postMessage({ type: "transcript", items: s.items }, "*");
  }, scene);
  await new Promise((r) => setTimeout(r, 400));
  if (scene.open) await page.click('[data-testid="agent-changes-toggle"]').catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  await page.close();
}
await browser.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("screenshots written to", out);
