// Click-through tests of the real webview bundle (dist/webview.js + media/main.css)
// in headless Chrome. The VS Code API is stubbed: messages the webview posts are
// recorded, and host messages are delivered with window.postMessage exactly as
// VS Code does. Run `npm run build` first.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Browser, Page } from "puppeteer-core" with { "resolution-mode": "import" };
import type { TranscriptItem } from "../../src/shared/model";
import type { HostMessage, ViewState } from "../../src/shared/protocol";

const ROOT = path.resolve(__dirname, "../../..");
/** Directory holding dist/webview.js and media/main.css; override to test an unpacked VSIX. */
const BUNDLE_ROOT = process.env.WEBVIEW_BUNDLE_ROOT ?? ROOT;
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((p): p is string => !!p);
const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p));

type Sent = Record<string, unknown> & { type: string };

export function baseState(over: Partial<ViewState> = {}): ViewState {
  return {
    connection: { kind: "connected", version: "2.0.24", url: "http://127.0.0.1:1" },
    workspace: {
      active: { name: "my-app", path: "/w/my-app" },
      folders: [{ name: "my-app", path: "/w/my-app" }],
      branch: "main",
      detachedAt: null,
      repoKind: "local",
      repoRoot: "/w/my-app",
      mainWorktree: null,
      uncommitted: 2,
    },
    models: [
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
        contextLimit: 131072,
        variants: ["none", "high", "max"],
      },
      {
        key: "opencode/gpt-6-luna",
        providerID: "opencode",
        id: "gpt-6-luna",
        name: "GPT 6 Luna",
        providerName: "Personal / OpenCode",
        contextLimit: 400000,
        variants: ["low", "high"],
      },
    ],
    agents: [
      { id: "build", name: "Build" },
      { id: "plan", name: "Plan" },
    ],
    selectedModel: "opencode-go/kimi-k2.7-code",
    selectedAgent: "build",
    selectedVariant: null,
    sessions: [],
    currentSession: { id: "ses_1", title: "Test session" },
    busy: false,
    stopping: false,
    attachments: [],
    agentChanges: { status: "none" },
    workspaceChanges: { count: 2 },
    usage: { contextTokens: 42000, contextLimit: 262144, cost: 0.08 },
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
    ...over,
  };
}

const REPORT =
  "# Report\n\n- one\n- two\n\n| A | B |\n|--|--|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\nتم بنجاح.";

let browser: Browser | undefined;
let page: Page;
let htmlFile = "";

async function host(msg: HostMessage) {
  await page.evaluate((m) => window.postMessage(m, "*"), msg as unknown as Record<string, unknown>);
  // Host messages are async tasks and item renders are coalesced per animation frame: wait two frames.
  await page.evaluate(
    () =>
      new Promise((r) =>
        setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 5))), 0),
      ),
  );
}
async function sent(): Promise<Sent[]> {
  return page.evaluate(() => (window as unknown as { __sent: Sent[] }).__sent);
}
async function lastSent(type: string): Promise<Sent | undefined> {
  return (await sent()).filter((m) => m.type === type).at(-1);
}
async function clearSent() {
  await page.evaluate(() => ((window as unknown as { __sent: Sent[] }).__sent.length = 0));
}
async function text(sel: string) {
  return page.$eval(sel, (el) => (el as HTMLElement).innerText);
}

describe(
  "webview interactions (headless Chrome)",
  { skip: CHROME ? false : "Chrome not found (set CHROME_PATH)" },
  () => {
    before(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocs-webview-"));
      htmlFile = path.join(dir, "index.html");
      const css = "file://" + path.join(BUNDLE_ROOT, "media", "main.css");
      const js = "file://" + path.join(BUNDLE_ROOT, "dist", "webview.js");
      fs.writeFileSync(
        htmlFile,
        `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${css}"></head>
<body><div id="app"></div>
<script>window.__sent=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__sent.push(JSON.parse(JSON.stringify(m))),getState:()=>undefined,setState:()=>{}});</script>
<script src="${js}"></script></body></html>`,
      );
      const puppeteer = (await import("puppeteer-core")).default;
      browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        args: ["--no-sandbox", "--disable-gpu"],
      });
    });

    after(async () => {
      await browser?.close();
    });

    beforeEach(async () => {
      page = await browser!.newPage();
      await page.setViewport({ width: 360, height: 900 });
      await page.goto("file://" + htmlFile);
      await page.waitForFunction(() =>
        (window as unknown as { __sent: Sent[] }).__sent.some((m) => m.type === "ready"),
      );
      await host({ type: "state", state: baseState() });
    });

    it("sends a message with Enter and keeps Shift+Enter as newline", async () => {
      await page.click("textarea");
      await page.keyboard.type("line one");
      await page.keyboard.down("Shift");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Shift");
      await page.keyboard.type("line two");
      await page.keyboard.press("Enter");
      assert.deepEqual(await lastSent("send"), { type: "send", text: "line one\nline two" });
      assert.equal(await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).value), "");
    });

    it("Copy sits under a completed message, sends the item id and shows ✓ Copied, then resets", async () => {
      const items: TranscriptItem[] = [{ kind: "assistant", id: "text:m:0", text: REPORT, streaming: false }];
      await host({ type: "transcript", items });
      const order = await page.$eval('[data-testid="assistant"]', (el) => {
        const body = el.querySelector(".msg-body")!;
        const footer = el.querySelector(".msg-footer")!;
        return body.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING
          ? "footer-below"
          : "footer-above";
      });
      assert.equal(order, "footer-below");
      assert.equal(
        await page.$eval('[data-testid="copy-message"]', (b) => b.getAttribute("aria-label")),
        "Copy message",
      );
      await page.click('[data-testid="copy-message"]');
      const req = await lastSent("copyMessage");
      assert.equal(req?.itemId, "text:m:0");
      await host({ type: "copyResult", requestId: String(req?.requestId), ok: true });
      assert.equal(await text('[data-testid="copy-message"]'), "✓ Copied");
      await new Promise((r) => setTimeout(r, 2000));
      assert.equal(await text('[data-testid="copy-message"]'), "Copy");
    });

    it("shows a non-blocking error when the clipboard write fails", async () => {
      await host({
        type: "transcript",
        items: [{ kind: "assistant", id: "text:m:0", text: "hi", streaming: false }],
      });
      await page.click('[data-testid="copy-message"]');
      const req = await lastSent("copyMessage");
      await host({ type: "copyResult", requestId: String(req?.requestId), ok: false });
      assert.equal(await text(".copy-error"), "Copy failed");
    });

    it("disables Copy while streaming and enables it after an interruption", async () => {
      await host({ type: "state", state: baseState({ busy: true }) });
      await host({
        type: "transcript",
        items: [{ kind: "assistant", id: "text:m:0", text: "partial", streaming: true }],
      });
      assert.equal(
        await page.$eval('[data-testid="copy-message"]', (b) => (b as HTMLButtonElement).disabled),
        true,
      );
      await host({ type: "events", events: [{ type: "session.idle", outcome: "interrupted" }] });
      await host({ type: "state", state: baseState({ busy: false }) });
      assert.equal(
        await page.$eval('[data-testid="copy-message"]', (b) => (b as HTMLButtonElement).disabled),
        false,
      );
    });

    it("Copy code copies only that code block's exact text", async () => {
      await host({
        type: "transcript",
        items: [{ kind: "assistant", id: "text:m:0", text: REPORT, streaming: false }],
      });
      await page.click('[data-testid="copy-code"]');
      const req = await lastSent("copy");
      assert.equal(req?.text, "const x = 1;");
      await host({ type: "copyResult", requestId: String(req?.requestId), ok: true });
      assert.equal(await text('[data-testid="copy-code"]'), "✓ Copied");
      assert.equal(await text('[data-testid="copy-message"]'), "Copy", "message copy unaffected");
    });

    it("is keyboard accessible: Tab to Copy and press Enter", async () => {
      await host({
        type: "transcript",
        items: [{ kind: "assistant", id: "text:m:0", text: "plain", streaming: false }],
      });
      await page.focus('[data-testid="copy-message"]');
      await page.keyboard.press("Enter");
      assert.ok(await lastSent("copyMessage"));
      const req = await lastSent("copyMessage");
      await host({ type: "copyResult", requestId: String(req?.requestId), ok: true });
      assert.equal(
        await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.testid),
        "copy-message",
        "focus kept after re-render",
      );
    });

    it("shows Arabic copy feedback for an Arabic UI", async () => {
      await host({ type: "state", state: baseState({ locale: "ar" }) });
      await host({
        type: "transcript",
        items: [{ kind: "assistant", id: "text:m:0", text: "مرحبا", streaming: false }],
      });
      await page.click('[data-testid="copy-message"]');
      const req = await lastSent("copyMessage");
      await host({ type: "copyResult", requestId: String(req?.requestId), ok: true });
      assert.equal(await text('[data-testid="copy-message"]'), "✓ تم النسخ");
    });

    it("switches model, agent, variant and budget", async () => {
      await page.select("#model-select", "opencode-go/qwen3.7-plus");
      assert.deepEqual(await lastSent("selectModel"), {
        type: "selectModel",
        key: "opencode-go/qwen3.7-plus",
      });
      assert.equal(await page.$("#variant-select"), null, "no variant selector for a model without variants");
      await host({ type: "state", state: baseState({ selectedModel: "opencode-go/qwen3.7-plus" }) });
      const variants = await page.$$eval("#variant-select option", (o) =>
        o.map((x) => (x as HTMLOptionElement).value),
      );
      assert.deepEqual(variants, ["", "none", "high", "max"], "only OpenCode-listed variants");
      await page.select("#variant-select", "high");
      assert.deepEqual(await lastSent("selectVariant"), { type: "selectVariant", variant: "high" });
      await page.select("#agent-select", "plan");
      assert.deepEqual(await lastSent("selectAgent"), { type: "selectAgent", id: "plan" });
      await page.select("#budget-select", "small");
      assert.deepEqual(await lastSent("selectBudget"), { type: "selectBudget", level: "small" });
    });

    it("groups models by provider", async () => {
      const groups = await page.$$eval("#model-select optgroup", (g) =>
        g.map((x) => [(x as HTMLOptGroupElement).label, x.children.length]),
      );
      assert.deepEqual(groups, [
        ["OpenCode Go", 2],
        ["Personal / OpenCode", 1],
      ]);
    });

    it("shows compact session metrics and the task meter", async () => {
      await host({
        type: "state",
        state: baseState({ busy: true, budget: { ...baseState().budget, active: true } }),
      });
      assert.match(await text(".usage"), /Context: 42k \/ 262k\s+·\s+Cost: \$0\.08\s+·\s+Steps: 14/);
      assert.match(await text('[data-testid="task-meter"]'), /Task: \$0\.03 \/ \$0\.30 · 5 \/ 50 steps/);
    });

    it("answers a permission request", async () => {
      await host({
        type: "transcript",
        items: [
          {
            kind: "permission",
            id: "perm:p1",
            status: "pending",
            sensitive: [],
            request: {
              id: "p1",
              sessionID: "ses_1",
              action: "read",
              resources: ["a.txt"],
              canAlways: true,
              message: null,
              toolId: null,
            },
          },
        ],
      });
      await page.click('[data-testid="perm-once"]');
      assert.deepEqual(await lastSent("respondPermission"), {
        type: "respondPermission",
        requestId: "p1",
        decision: "once",
      });
    });

    it("renders an OpenCode question and submits the chosen option", async () => {
      await host({
        type: "transcript",
        items: [
          {
            kind: "form",
            id: "form:frm_1",
            status: "pending",
            answer: null,
            form: {
              id: "frm_1",
              sessionID: "ses_1",
              title: "Questions",
              toolId: null,
              fields: [
                {
                  key: "q0",
                  type: "string",
                  title: "Preferred color",
                  description: "Which color?",
                  options: [
                    { value: "Red", label: "Red" },
                    { value: "Blue", label: "Blue" },
                  ],
                  custom: true,
                },
              ],
            },
          },
        ],
      });
      assert.match(await text('[data-testid="form-card"]'), /Preferred color/);
      const radios = await page.$$('[data-testid="form-option"]');
      await radios[1].click();
      await page.click('[data-testid="form-submit"]');
      assert.deepEqual(await lastSent("answerForm"), {
        type: "answerForm",
        formId: "frm_1",
        answer: { q0: "Blue" },
      });
      await host({ type: "formError", formId: "frm_1", error: "“Preferred color” is required." });
      assert.match(await text('[data-testid="form-card"]'), /is required/);
      await host({
        type: "events",
        events: [{ type: "form.resolved", formId: "frm_1", status: "expired", answer: null }],
      });
      assert.match(await text('[data-testid="form-card"]'), /Question expired/);
      assert.equal(await page.$('[data-testid="form-submit"]'), null);
    });

    it("Stop button and Esc both stop a running task", async () => {
      await host({ type: "state", state: baseState({ busy: true }) });
      await page.click('[data-testid="stop"]');
      assert.ok(await lastSent("stop"));
      await clearSent();
      await page.focus("textarea");
      await page.keyboard.press("Escape");
      assert.ok(await lastSent("stop"));
    });

    it("steers or queues follow-ups while running and shows pending messages with Edit/Remove", async () => {
      await host({ type: "state", state: baseState({ busy: true }) });
      assert.equal(await text('[data-testid="send"]'), "Steer");
      await page.click('[data-testid="mode-queue"]');
      assert.equal(await text('[data-testid="send"]'), "Queue");
      await page.type("textarea", "Run only the targeted test after this.");
      await page.click('[data-testid="send"]');
      assert.deepEqual(await lastSent("send"), {
        type: "send",
        text: "Run only the targeted test after this.",
        delivery: "queue",
      });
      await host({
        type: "state",
        state: baseState({
          busy: true,
          pending: [
            {
              id: "msg_q",
              text: "Run only the targeted test after this.",
              attachments: [],
              delivery: "queue",
            },
          ],
        }),
      });
      assert.match(await text('[data-testid="pending-item"]'), /Queued/);
      const buttons = await page.$$('[data-testid="pending-item"] button');
      await buttons[0].click();
      assert.deepEqual(await lastSent("editPending"), { type: "editPending", id: "msg_q" });
      await buttons[1].click();
      assert.deepEqual(await lastSent("removePending"), { type: "removePending", id: "msg_q" });
      await host({ type: "restoreInput", text: "edited text" });
      assert.equal(await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).value), "edited text");
    });

    it("View Agent Changes and per-file Diff use the agent diff; workspace changes are separate", async () => {
      await host({
        type: "state",
        state: baseState({
          agentChanges: {
            status: "ok",
            files: [{ path: "a.txt", additions: 3, deletions: 1, status: "modified" }],
          },
        }),
      });
      assert.match(await text(".changes"), /Agent changes · 1 file/);
      assert.match(await text(".changes"), /Workspace changes: 2 files/);
      await page.click('[data-testid="view-agent-changes"]');
      assert.ok(await lastSent("openAgentDiffAll"));
      await page.click('[data-testid="agent-changes-toggle"]');
      await page.click('[data-testid="file-diff"]');
      assert.deepEqual(await lastSent("openAgentDiff"), { type: "openAgentDiff", path: "a.txt" });
      await page.click('[data-testid="view-workspace-changes"]');
      assert.ok(await lastSent("openWorkspaceDiffAll"));
    });

    it("says when agent-only diff is unavailable", async () => {
      await host({
        type: "state",
        state: baseState({
          agentChanges: {
            status: "unavailable",
            reason: "OpenCode could not provide the session's snapshot diff.",
          },
        }),
      });
      assert.match(await text('[data-testid="agent-diff-unavailable"]'), /Agent-only diff unavailable/);
    });

    it("attaches the current file and the selection", async () => {
      const buttons = await page.$$(".context-buttons button");
      await buttons[1].click();
      assert.ok(await lastSent("addCurrentFile"));
      await buttons[2].click();
      assert.ok(await lastSent("addSelection"));
      await host({
        type: "state",
        state: baseState({
          attachments: [{ id: "a1", label: "app.ts:3-9", detail: "src/app.ts lines 3-9" }],
        }),
      });
      await page.click(".chip-x");
      assert.deepEqual(await lastSent("removeAttachment"), { type: "removeAttachment", id: "a1" });
    });

    it("budget stopped card offers Continue once / Increase budget / Start new session", async () => {
      await host({
        type: "transcript",
        items: [
          {
            kind: "budget",
            id: "budget:1",
            state: "stopped",
            text: "Task budget reached. The agent was stopped.",
            resolved: null,
          },
        ],
      });
      await page.click('[data-testid="budget-continue"]');
      assert.deepEqual(await lastSent("budgetAction"), {
        type: "budgetAction",
        itemId: "budget:1",
        action: "continue",
      });
      await page.click('[data-testid="budget-increase"]');
      assert.equal((await lastSent("budgetAction"))?.action, "increase");
      await page.click('[data-testid="budget-new"]');
      assert.equal((await lastSent("budgetAction"))?.action, "newSession");
    });

    it("error card offers Change model (focuses the picker) and Retry", async () => {
      await host({
        type: "transcript",
        items: [
          {
            kind: "error",
            id: "error:1",
            title: "MiniMax M3 (OpenCode Go) reported insufficient funds.",
            detail: "Upstream request failed: Insufficient account funds",
            actions: ["changeModel", "retry"],
          },
        ],
      });
      const buttons = await page.$$('[data-testid="error-card"] button');
      await buttons[0].click();
      assert.ok(await lastSent("focusModelPicker"));
      await host({ type: "focusModel" });
      assert.equal(await page.evaluate(() => document.activeElement?.id), "model-select");
      await buttons[1].click();
      assert.ok(await lastSent("retryLast"));
    });

    it("stays responsive with a large history and a long streaming report", async () => {
      const md = "## Section\n\n- a\n- b\n\n| x | y |\n|--|--|\n| 1 | 2 |\n\n```ts\nconst a = 1;\n```\n";
      const many: TranscriptItem[] = Array.from({ length: 400 }, (_, i) => ({
        kind: "assistant",
        id: `text:m${i}:0`,
        text: md + i,
        streaming: false,
      }));
      const t0 = Date.now();
      await host({ type: "transcript", items: many });
      const historyMs = Date.now() - t0;
      assert.equal(await page.$$eval('[data-testid="assistant"]', (n) => n.length), 400);
      assert.ok(historyMs < 4000, `400-message history rendered in ${historyMs}ms`);
      await host({ type: "state", state: baseState({ busy: true }) });
      const t1 = Date.now();
      for (let batch = 0; batch < 40; batch++) {
        const events = Array.from({ length: 50 }, (_, i) => ({
          type: "assistant.delta" as const,
          partId: "live:0",
          delta: `word${batch * 50 + i} ` + (i % 10 === 0 ? "\n" : ""),
        }));
        await page.evaluate((m) => window.postMessage(m, "*"), {
          type: "events",
          events,
        } as unknown as Record<string, unknown>);
      }
      await host({
        type: "events",
        events: [{ type: "assistant.completed", partId: "live:0", text: "done" }],
      });
      const streamMs = Date.now() - t1;
      assert.ok(streamMs < 4000, `2000 streamed deltas handled in ${streamMs}ms`);
      assert.equal(
        await page.$eval('[data-id="text:live:0"] .msg-body', (n) => (n as HTMLElement).innerText.trim()),
        "done",
      );
    });

    it("is usable in a high-contrast theme without horizontal overflow", async () => {
      await page.evaluate(() => {
        document.body.classList.add("vscode-high-contrast");
        const s = document.documentElement.style;
        for (const [k, v] of Object.entries({
          "--vscode-foreground": "#ffffff",
          "--vscode-sideBar-background": "#000000",
          "--vscode-contrastBorder": "#6fc3df",
          "--vscode-contrastActiveBorder": "#f38518",
          "--vscode-focusBorder": "#f38518",
          "--vscode-button-background": "#000000",
          "--vscode-button-foreground": "#ffffff",
          "--vscode-input-background": "#000000",
          "--vscode-input-foreground": "#ffffff",
        }))
          s.setProperty(k, v);
        document.body.style.background = "#000";
      });
      await host({
        type: "transcript",
        items: [
          { kind: "assistant", id: "text:m:0", text: REPORT, streaming: false },
          {
            kind: "budget",
            id: "budget:1",
            state: "warning",
            text: "Task budget is nearly exhausted.",
            resolved: null,
          },
        ],
      });
      await host({
        type: "state",
        state: baseState({ busy: true, budget: { ...baseState().budget, active: true, state: "warning" } }),
      });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
      const border = await page.$eval(".btn", (b) => getComputedStyle(b).borderTopWidth);
      assert.equal(border, "1px", "buttons have visible borders in high contrast");
      await page.focus('[data-testid="copy-message"]');
      const outline = await page.$eval(
        '[data-testid="copy-message"]',
        (b) => getComputedStyle(b).outlineWidth,
      );
      assert.equal(outline, "2px", "strong focus indicator");
      fs.mkdirSync(path.join(ROOT, "out-test", "screens"), { recursive: true });
      await page.screenshot({
        path: path.join(ROOT, "out-test", "screens", "high-contrast.png"),
        fullPage: true,
      });
    });
  },
);
