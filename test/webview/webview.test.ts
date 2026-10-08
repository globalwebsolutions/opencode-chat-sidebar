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
    task: null,
    onboarding: {
      stage: "ready",
      checklist: { installed: "done", connected: "done", account: "done", models: "done" },
      hint: null,
      signIn: "idle",
    },
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

    // ------------------------------------------------------------ current task

    const TASK = {
      id: "u2",
      label: "current" as const,
      summary: "Release Closure Verification",
      status: "running" as const,
      steer: null,
      next: null,
      chars: 0,
      lines: 0,
    };

    it("hides the task bar for an empty session and keeps the session title separate", async () => {
      assert.equal(await page.$eval(".task-bar", (e) => (e as HTMLElement).hidden), true);
      await host({
        type: "state",
        state: baseState({ currentSession: { id: "ses_1", title: "Project M16" }, task: TASK }),
      });
      assert.equal(await page.$eval(".task-bar", (e) => (e as HTMLElement).hidden), false);
      assert.equal(await text(".session-title"), "Project M16");
      assert.equal(await text('[data-testid="task-summary"]'), "Release Closure Verification");
      assert.match(await text(".task-label"), /CURRENT TASK/);
      assert.equal(await text('[data-testid="task-status"]'), "Running");
    });

    it("labels a finished task as Last Task with its status", async () => {
      await host({
        type: "state",
        state: baseState({ task: { ...TASK, label: "last", status: "budget-stopped" } }),
      });
      assert.match(await text(".task-label"), /LAST TASK/);
      assert.equal(await text('[data-testid="task-status"]'), "Stopped — budget reached");
    });

    it("expands on click, shows the exact full prompt in a scrollable area, and copies it", async () => {
      const prompt = [
        "Close the release checklist only.",
        "",
        "Repository:",
        "/projects/x",
        "",
        "```ts",
        "const a = 1;",
        "```",
        ...Array.from({ length: 800 }, (_, i) => `- line ${i}`),
      ].join("\n");
      await host({
        type: "state",
        state: baseState({ task: { ...TASK, chars: prompt.length, lines: prompt.split("\n").length } }),
      });
      assert.equal(await page.$('[data-testid="task-prompt"]'), null, "collapsed by default");
      await page.click('[data-testid="task-toggle"]');
      assert.ok(await lastSent("getTaskPrompt"), "full prompt fetched on demand only");
      assert.equal(
        await page.$eval('[data-testid="task-toggle"]', (b) => b.getAttribute("aria-expanded")),
        "true",
      );
      await host({ type: "taskPrompt", id: "u2", text: prompt });
      assert.equal(
        await page.$eval('[data-testid="task-prompt"]', (p) => (p as HTMLElement).textContent),
        prompt,
      );
      const box = await page.$eval('[data-testid="task-prompt"]', (p) => ({
        client: p.clientHeight,
        scroll: p.scrollHeight,
        vh: window.innerHeight,
      }));
      assert.ok(
        box.scroll > box.client && box.client <= box.vh * 0.4,
        `scrollable, bounded height ${JSON.stringify(box)}`,
      );
      // Keeps the scroll position across state pushes while the agent runs.
      await page.$eval('[data-testid="task-prompt"]', (p) => ((p as HTMLElement).scrollTop = 500));
      await host({
        type: "state",
        state: baseState({
          task: { ...TASK, chars: prompt.length, lines: prompt.split("\n").length },
          steps: 15,
        }),
      });
      assert.equal(await page.$eval('[data-testid="task-prompt"]', (p) => (p as HTMLElement).scrollTop), 500);
      await page.click('[data-testid="copy-prompt"]');
      const req = await lastSent("copyTaskPrompt");
      assert.ok(req, "copies the canonical prompt from the host (not the DOM)");
      await host({ type: "copyResult", requestId: String(req?.requestId), ok: true });
      assert.equal(await text('[data-testid="copy-prompt"]'), "✓ Copied");
      await page.click('[data-testid="task-toggle"]');
      assert.equal(await page.$('[data-testid="task-prompt"]'), null, "collapses again");
    });

    it("shows the latest steer subtly and the next queued message with a count", async () => {
      await host({
        type: "state",
        state: baseState({
          task: {
            ...TASK,
            steer: "Do not touch Finance yet.",
            next: { summary: "Run the targeted PostgreSQL tests", more: 2 },
          },
        }),
      });
      assert.equal(await text('[data-testid="task-steer"]'), "Latest steer: “Do not touch Finance yet.”");
      assert.equal(
        await text('[data-testid="task-next"]'),
        "Next: Run the targeted PostgreSQL tests +2 queued",
      );
      assert.equal(
        await text('[data-testid="task-summary"]'),
        "Release Closure Verification",
        "steer does not replace the task",
      );
    });

    it("renders Arabic task summaries right-to-left and stays within the sidebar width", async () => {
      await host({
        type: "state",
        state: baseState({ locale: "ar", task: { ...TASK, summary: "أغلق المرحلة ب/ج فقط ".repeat(6) } }),
      });
      assert.equal(
        await page.$eval('[data-testid="task-summary"]', (e) => getComputedStyle(e).direction),
        "rtl",
      );
      assert.match(await text(".task-label"), /المهمة الحالية/);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert.ok(overflow <= 0, `overflow ${overflow}`);
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
        state: baseState({
          busy: true,
          budget: { ...baseState().budget, active: true, state: "warning" },
          task: {
            id: "u",
            label: "current",
            summary: "Release Closure Verification",
            status: "running",
            steer: "Do not touch Finance yet.",
            next: { summary: "Run tests", more: 1 },
            chars: 10,
            lines: 1,
          },
        }),
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
    // ------------------------------------------------------------ v0.3 onboarding

    const onb = (
      stage: ViewState["onboarding"]["stage"],
      over: Partial<ViewState["onboarding"]> = {},
    ): ViewState["onboarding"] => ({
      stage,
      checklist: { installed: "done", connected: "done", account: "unknown", models: "unknown" },
      hint: null,
      signIn: "idle",
      ...over,
    });
    const status = () => text('[data-testid="connection-status"]');
    const checks = () =>
      page.$$eval("[data-check]", (els) => els.map((e) => (e as HTMLElement).getAttribute("aria-label")));

    it("onboarding A: OpenCode not installed → Install (official page) / Check again, chat disabled", async () => {
      await host({
        type: "state",
        state: baseState({
          connection: { kind: "cli-not-found", searched: ["/usr/local/bin/opencode"] },
          models: null,
          agents: null,
          currentSession: null,
          onboarding: onb("not-installed", {
            checklist: { installed: "todo", connected: "todo", account: "unknown", models: "unknown" },
          }),
        }),
      });
      const card = await text('[data-testid="onboarding"]');
      assert.match(card, /OpenCode is required/);
      assert.match(
        card,
        /OpenCode Chat Sidebar is a UI for OpenCode and requires OpenCode to be installed\./,
      );
      assert.equal(await status(), "OpenCode not installed");
      assert.deepEqual(await checks(), [
        "Extension installed: done",
        "OpenCode installed: not yet",
        "OpenCode connected: not yet",
        "Account signed in: not checked yet",
        "Models available: not checked yet",
      ]);
      await clearSent();
      await page.click('[data-testid="onb-install"]');
      await page.click('[data-testid="onb-check"]');
      assert.deepEqual(
        (await sent()).map((m) => m),
        [{ type: "openOfficial", link: "install" }, { type: "retry" }],
      );
      assert.equal(await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).disabled), true);
    });

    it("onboarding B: service stopped → Start OpenCode", async () => {
      await host({
        type: "state",
        state: baseState({
          connection: { kind: "not-running", canStart: true, detail: "not running" },
          onboarding: onb("stopped", {
            checklist: { installed: "done", connected: "todo", account: "unknown", models: "unknown" },
          }),
        }),
      });
      assert.match(await text('[data-testid="onboarding"]'), /OpenCode is installed/);
      assert.equal(await status(), "OpenCode stopped");
      await clearSent();
      await page.click('[data-testid="onb-start"]');
      assert.deepEqual(await lastSent("startOpenCode"), { type: "startOpenCode" });
    });

    it("onboarding C: sign-in uses OpenCode's flow, states the privacy promise, asks for no credentials", async () => {
      await host({
        type: "state",
        state: baseState({
          models: [],
          selectedModel: null,
          onboarding: onb("sign-in", {
            checklist: { installed: "done", connected: "done", account: "todo", models: "todo" },
          }),
        }),
      });
      const card = await text('[data-testid="onboarding"]');
      assert.match(card, /Sign in using OpenCode\. This extension never sees or stores your password\./);
      assert.equal(await status(), "Sign-in required");
      assert.equal(await page.$$eval('[data-testid="onboarding"] input', (els) => els.length), 0);
      assert.equal(await page.$$eval('input[type="password"]', (els) => els.length), 0);
      await clearSent();
      await page.click('[data-testid="onb-sign-in"]');
      await page.click('[data-link="account"]');
      await page.click('[data-testid="onb-provider"]');
      assert.deepEqual(await sent(), [
        { type: "signIn" },
        { type: "openOfficial", link: "account" },
        { type: "connectProvider" },
      ]);
      assert.equal(await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).disabled), true);
    });

    it("onboarding: waiting / cancelled / failed sign-in feedback", async () => {
      const st = (signIn: ViewState["onboarding"]["signIn"]) =>
        baseState({ models: [], onboarding: onb("sign-in", { signIn }) });
      await host({ type: "state", state: st("waiting") });
      assert.match(await text('[data-testid="sign-in-waiting"]'), /finish it in the OpenCode terminal/);
      assert.equal(await page.$('[data-testid="onb-sign-in"]'), null, "no second sign-in while waiting");
      await host({ type: "state", state: st("cancelled") });
      assert.match(await text('[data-testid="onboarding"]'), /Sign-in was not completed/);
      await host({ type: "state", state: st("failed") });
      assert.match(await text('[data-testid="onboarding"]'), /could not complete the sign-in/);
    });

    it("onboarding D: no models → exact guidance, Configure models / Refresh, docs links", async () => {
      await host({
        type: "state",
        state: baseState({
          models: [],
          selectedModel: null,
          onboarding: onb("no-models", {
            checklist: { installed: "done", connected: "done", account: "done", models: "todo" },
          }),
        }),
      });
      const card = await text('[data-testid="onboarding"]');
      assert.match(card, /No models are available yet\./);
      assert.match(card, /Configure a provider in OpenCode or use an OpenCode Go model\./);
      assert.equal(await status(), "No models");
      assert.equal(await text("#model-select"), "No models — connect a provider");
      await clearSent();
      await page.click('[data-testid="onb-provider"]');
      await page.click('[data-testid="onb-refresh"]');
      await page.click('[data-link="providers"]');
      await page.click('[data-link="go"]');
      assert.deepEqual(await sent(), [
        { type: "connectProvider" },
        { type: "refreshConnection" },
        { type: "openOfficial", link: "providers" },
        { type: "openOfficial", link: "go" },
      ]);
    });

    it("onboarding F: no folder → Open Folder; selectors explain why they are empty", async () => {
      await host({
        type: "state",
        state: baseState({
          workspace: { ...baseState().workspace, active: null, folders: [] },
          models: null,
          agents: null,
          onboarding: onb("no-folder"),
        }),
      });
      assert.match(await text('[data-testid="onboarding"]'), /Open a project to start coding/);
      assert.equal(await status(), "No folder open");
      assert.equal(await text("#model-select"), "Open a folder first");
      assert.equal(await text("#agent-select"), "Open a folder first");
      await clearSent();
      await page.click('[data-testid="onb-open-folder"]');
      assert.deepEqual(await sent(), [{ type: "openFolder" }]);
    });

    it("onboarding E: ready hides onboarding; header says Connected only then", async () => {
      assert.equal(await page.$('[data-testid="onboarding"]'), null);
      assert.equal(await page.$('[data-testid="sign-in-hint"]'), null);
      assert.equal(await status(), "Connected");
      assert.equal(await page.$eval("textarea", (t) => (t as HTMLTextAreaElement).disabled), false);
      await host({ type: "state", state: baseState({ models: null, onboarding: onb("loading") }) });
      assert.equal(await status(), "Checking…");
      assert.equal(await text("#model-select"), "Loading models…");
      await host({
        type: "state",
        state: baseState({ models: null, agents: null, onboarding: onb("catalog-error") }),
      });
      assert.equal(await status(), "Models unavailable");
      assert.equal(await text("#agent-select"), "Agents could not be loaded");
      await host({ type: "state", state: baseState({ agents: [] }) });
      assert.equal(await text("#agent-select"), "No agents available");
    });

    it("onboarding: optional sign-in note while using free models, dismissible; renewal note", async () => {
      await host({
        type: "state",
        state: baseState({ onboarding: onb("ready", { hint: "sign-in-optional" }) }),
      });
      assert.match(await text('[data-testid="sign-in-hint"]'), /No OpenCode account is connected/);
      assert.equal(await page.$('[data-testid="onboarding"]'), null, "never blocks a usable chat");
      await clearSent();
      await page.click('[data-testid="sign-in-hint"] .btn.subtle');
      await page.click('[data-testid="sign-in-hint"] .btn:not(.subtle)');
      assert.deepEqual(await sent(), [{ type: "dismissSignInHint" }, { type: "signIn" }]);
      await host({
        type: "state",
        state: baseState({ onboarding: onb("ready", { hint: "sign-in-expired" }) }),
      });
      assert.match(await text('[data-testid="sign-in-hint"]'), /needs to be renewed/);
      assert.equal(await page.$('[data-testid="sign-in-hint"] .btn.subtle'), null);
    });

    it("onboarding: setup guide link and a compact card without horizontal overflow at 260px", async () => {
      await page.setViewport({ width: 260, height: 700 });
      await host({
        type: "state",
        state: baseState({ models: [], onboarding: onb("sign-in") }),
      });
      assert.match(await text('[data-testid="onboarding"]'), /Need help\? View setup guide/);
      await clearSent();
      await page.click('[data-link="setupGuide"]');
      assert.deepEqual(await sent(), [{ type: "openOfficial", link: "setupGuide" }]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
    });
  },
);
