// Sidebar webview. Renders state pushed by the extension host and sends user
// intents back as typed messages. All text is inserted with textContent; no
// innerHTML, no eval.

import type {
  BudgetLevel,
  CheckState,
  OnboardingStage,
  FileChange,
  FormAnswer,
  FormField,
  InboxDelivery,
  TranscriptItem,
} from "../shared/model";
import type { HostMessage, OfficialLink, ViewState, WebviewMessage } from "../shared/protocol";
import { Transcript } from "../shared/transcript";
import { translate, type StringKey } from "./i18n";
import { parseMarkdown, type Block, type Inline } from "./markdown";

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const send = (m: WebviewMessage) => vscode.postMessage(m);

type Attrs = Record<string, string | boolean | number | undefined | ((ev: Event) => void)>;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v);
    else if (k === "className") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

const nonNull = (nodes: Array<Node | null | undefined | false>): Node[] =>
  nodes.filter((n): n is Node => !!n);

// ------------------------------------------------------------------ state

let state: ViewState | null = null;
const transcript = new Transcript();
const openDetails = new Set<string>();
const itemEls = new Map<string, HTMLElement>();
let sessionsOpen = false;
let changesOpen = false;
let draft = "";
let delivery: InboxDelivery = "steer";
/** Copy feedback per button key ("msg:<itemId>" or "code:<itemId>:<n>"). */
const copyFeedback = new Map<string, "copied" | "failed">();
const copyRequests = new Map<string, { key: string; itemId: string }>();
const formErrors = new Map<string, string>();
/** In-progress (unsent) form answers, so re-renders do not lose user input. */
const formDrafts = new Map<string, FormAnswer>();
let requestSeq = 0;
let taskExpanded = false;
let taskExpandedId: string | null = null;
let taskPrompt: { id: string; text: string } | null = null;
const TASK_KEY = "__task";

const persisted = vscode.getState() as { draft?: string; delivery?: InboxDelivery } | undefined;
if (persisted?.draft) draft = persisted.draft;
if (persisted?.delivery === "queue") delivery = "queue";

const t = (key: StringKey) => translate(state?.locale ?? "en", key);

function persist() {
  vscode.setState({ draft, delivery });
}

// ------------------------------------------------------------------ layout

const app = document.getElementById("app")!;
const headerEl = h("header", { className: "header" });
const taskEl = h("section", { className: "task-bar", "aria-label": "Current task", hidden: true });
const bannerEl = h("div", { className: "banners" });
const sessionsEl = h("section", { className: "sessions", "aria-label": "Recent sessions", hidden: true });
const statusLive = h("div", { className: "sr-only", "aria-live": "polite", role: "status" });
const scroller = h("main", { className: "conversation", "aria-label": "Conversation", tabindex: "-1" });
const emptyEl = h("div", { className: "empty" });
const listEl = h("div", {
  className: "items",
  role: "log",
  "aria-live": "polite",
  "aria-relevant": "additions",
});
scroller.append(emptyEl, listEl);
const changesEl = h("section", { className: "changes", "aria-label": "Changed files" });
const pendingEl = h("section", { className: "pending", "aria-label": "Pending messages" });
const composerEl = h("footer", { className: "composer" });
app.append(headerEl, taskEl, bannerEl, sessionsEl, scroller, changesEl, pendingEl, composerEl, statusLive);

// Composer is built once so focus/caret survive state updates.
const chipsEl = h("div", { className: "chips", "aria-label": "Attached context" });
const input = h("textarea", {
  className: "input",
  rows: 2,
  dir: "auto",
  placeholder: "Ask anything…  (Enter to send, Shift+Enter for newline)",
  "aria-label": "Message OpenCode",
}) as HTMLTextAreaElement;
input.value = draft;
const contextBtn = h(
  "button",
  {
    className: "btn subtle",
    title: "Attach context (current file, selection or a workspace file)",
    onclick: () => send({ type: "pickFile" }),
  },
  "+ Context",
);
const currentFileBtn = h(
  "button",
  {
    className: "btn subtle",
    title: "Attach the file open in the editor",
    onclick: () => send({ type: "addCurrentFile" }),
  },
  "Current File",
);
const selectionBtn = h(
  "button",
  {
    className: "btn subtle",
    title: "Attach the selected lines from the editor",
    onclick: () => send({ type: "addSelection" }),
  },
  "Selection",
);
const sendBtn = h("button", { className: "btn primary send", "data-testid": "send" }, "Send");
sendBtn.addEventListener("click", () => submit());
const stopBtn = h("button", { className: "btn danger send", "data-testid": "stop", hidden: true }, "Stop");
stopBtn.addEventListener("click", () => stop());
const modeGroup = h("div", {
  className: "mode-group",
  role: "radiogroup",
  "aria-label": "While the agent is running",
  hidden: true,
});
const hintEl = h("span", { className: "hint" });
composerEl.append(
  chipsEl,
  input,
  h(
    "div",
    { className: "composer-row" },
    h("div", { className: "context-buttons" }, contextBtn, currentFileBtn, selectionBtn),
    hintEl,
    stopBtn,
    sendBtn,
  ),
  modeGroup,
);

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    submit();
  } else if (e.key === "Escape" && state?.busy) {
    e.preventDefault();
    stop();
  }
});
input.addEventListener("input", () => {
  draft = input.value;
  persist();
  autosize();
});

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 240) + "px";
}

function submit() {
  if (!state || state.connection.kind !== "connected") return;
  const text = input.value;
  if (!text.trim()) return;
  if (state.busy) send({ type: "send", text, delivery });
  else send({ type: "send", text });
  input.value = "";
  draft = "";
  persist();
  autosize();
  stickToBottom = true;
}

function stop() {
  send({ type: "stop" });
}

function copy(
  key: string,
  itemId: string,
  msg: { kind: "message" } | { kind: "code"; text: string } | { kind: "prompt" },
) {
  const requestId = `c${++requestSeq}`;
  copyRequests.set(requestId, { key, itemId });
  if (msg.kind === "message") send({ type: "copyMessage", itemId, requestId });
  else if (msg.kind === "prompt") send({ type: "copyTaskPrompt", requestId });
  else send({ type: "copy", text: msg.text, requestId });
}

// --------------------------------------------------------------- scrolling

let stickToBottom = true;
scroller.addEventListener("scroll", () => {
  stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
});
function maybeScroll() {
  if (stickToBottom) scroller.scrollTop = scroller.scrollHeight;
}

// -------------------------------------------------------------- formatting

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n >= 10_000 ? 0 : 1) + "k";
  return String(n);
}

function formatCost(c: number): string {
  return `$${c < 0.01 && c > 0 ? c.toFixed(4) : c.toFixed(2)}`;
}

function relativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

function changeCounts(files: FileChange[]) {
  return files.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), {
    add: 0,
    del: 0,
  });
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function budgetLabel(level: BudgetLevel, s: ViewState): string {
  if (level === "off") return "Off";
  const l = s.budgetPresets[level];
  const parts = [
    l.maxCost !== null ? formatCost(l.maxCost) : null,
    l.maxSteps !== null ? `${l.maxSteps} steps` : null,
  ].filter(Boolean);
  return `${capitalize(level)}${parts.length ? ` (${parts.join(" · ")})` : ""}`;
}

// ------------------------------------------------------------------ header

function select(
  id: string,
  label: string,
  options: Array<{ value: string; text: string; title?: string; group?: string }>,
  selected: string | null,
  disabled: boolean,
  onChange: (v: string) => void,
  emptyText: string,
): HTMLSelectElement {
  const sel = h("select", {
    className: "select",
    id,
    "aria-label": label,
    disabled: disabled || options.length === 0,
    onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value),
  });
  if (options.length === 0) sel.append(h("option", {}, emptyText));
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const o of options) {
    const opt = h("option", { value: o.value, title: o.title }, o.text);
    if (o.value === selected) opt.selected = true;
    if (o.group) {
      let g = groups.get(o.group);
      if (!g) {
        g = h("optgroup", { label: o.group });
        groups.set(o.group, g);
        sel.append(g);
      }
      g.append(opt);
    } else sel.append(opt);
  }
  return sel;
}

function renderHeader(s: ViewState) {
  const conn = s.connection;
  const connected = conn.kind === "connected";
  const stage = s.onboarding.stage;
  // "Connected" only when the chat is usable.
  const statusText = STAGE_STATUS[stage];
  const statusTitle =
    conn.kind === "connected" ? `${statusText} — OpenCode ${conn.version} at ${conn.url}` : statusText;
  const loading =
    stage === "loading" ||
    (connected && s.models === null && !!s.workspace.active && stage !== "catalog-error");

  const ws = s.workspace;
  const repoLabel =
    ws.repoKind === "local"
      ? "Local Repository"
      : ws.repoKind === "worktree"
        ? "Git Worktree"
        : ws.repoKind === "not-git"
          ? "Not a Git repository"
          : "Unknown";
  const branch =
    ws.branch ??
    (ws.detachedAt ? `detached @ ${ws.detachedAt}` : ws.repoKind === "not-git" ? "" : "unknown branch");

  const folderControl =
    ws.folders.length > 1
      ? select(
          "root-select",
          "Active workspace folder",
          ws.folders.map((f) => ({ value: f.path, text: f.name, title: f.path })),
          ws.active?.path ?? null,
          false,
          (v) => send({ type: "selectRoot", path: v }),
          "",
        )
      : h(
          "span",
          { className: "ws-name", title: ws.active?.path ?? "" },
          ws.active?.name ?? "No folder open",
        );

  // Models grouped by provider, providers in the order OpenCode reports them.
  const models = s.models ?? [];
  const modelSel = select(
    "model-select",
    "Model",
    models.map((m) => ({
      value: m.key,
      text: m.name,
      title: `${m.providerName} · ${m.key}`,
      group: m.providerName,
    })),
    s.selectedModel,
    !connected,
    (v) => send({ type: "selectModel", key: v }),
    !connected
      ? "—"
      : !s.workspace.active
        ? "Open a folder first"
        : loading
          ? "Loading models…"
          : s.models
            ? "No models — connect a provider"
            : "Models could not be loaded",
  );
  const model = models.find((m) => m.key === s.selectedModel);
  const variantSel =
    model && model.variants.length
      ? select(
          "variant-select",
          "Model variant",
          [{ value: "", text: "Default" }, ...model.variants.map((v) => ({ value: v, text: capitalize(v) }))],
          s.selectedVariant ?? "",
          !connected,
          (v) => send({ type: "selectVariant", variant: v }),
          "",
        )
      : null;

  const agents = s.agents ?? [];
  const agentSel = select(
    "agent-select",
    "Agent",
    agents.map((a) => ({ value: a.id, text: a.name })),
    s.selectedAgent,
    !connected,
    (v) => send({ type: "selectAgent", id: v }),
    !connected
      ? "—"
      : !s.workspace.active
        ? "Open a folder first"
        : loading
          ? "Loading agents…"
          : s.agents
            ? "No agents available"
            : "Agents could not be loaded",
  );

  const levels: BudgetLevel[] = ["off", "small", "medium", "large", "custom"];
  const budgetSel = select(
    "budget-select",
    "Task budget",
    levels.map((l) => ({ value: l, text: l === "off" ? "Off" : capitalize(l), title: budgetLabel(l, s) })),
    s.budget.level,
    !connected,
    (v) => send({ type: "selectBudget", level: v as BudgetLevel }),
    "",
  );

  const usage = s.usage;
  const usageParts: string[] = [];
  if (usage?.contextTokens != null) {
    usageParts.push(
      `Context: ${formatTokens(usage.contextTokens)}${usage.contextLimit ? ` / ${formatTokens(usage.contextLimit)}` : ""}`,
    );
  }
  if (usage?.cost != null) usageParts.push(`Cost: ${formatCost(usage.cost)}`);
  if (s.steps > 0 && s.usage) usageParts.push(`Steps: ${s.steps}`);

  const b = s.budget;
  let taskMeter: HTMLElement | null = null;
  if (b.level !== "off" && (b.active || b.taskSteps > 0)) {
    const parts: string[] = [];
    if (b.limits.maxCost !== null)
      parts.push(
        `${b.taskCost !== null ? formatCost(b.taskCost) : "cost n/a"} / ${formatCost(b.limits.maxCost * b.allowance)}`,
      );
    if (b.limits.maxSteps !== null) parts.push(`${b.taskSteps} / ${b.limits.maxSteps * b.allowance} steps`);
    taskMeter = h(
      "div",
      {
        className: `row task-meter budget-${b.state}`,
        title: "Local task budget (current or last agent run)",
        "data-testid": "task-meter",
      },
      `Task: ${parts.join(" · ")}`,
    );
  }

  headerEl.replaceChildren(
    ...nonNull([
      h(
        "div",
        { className: "row title-row" },
        h(
          "span",
          { className: "session-title", title: s.currentSession?.title ?? "New session", dir: "auto" },
          s.currentSession?.title ?? "New session",
        ),
        h(
          "span",
          {
            className: `status status-${conn.kind} stage-${stage}`,
            title: statusTitle,
            role: "status",
            "data-testid": "connection-status",
          },
          h("span", { className: "dot", "aria-hidden": "true" }),
          statusText,
        ),
        h(
          "button",
          {
            className: "icon-btn",
            title: "Recent sessions",
            "aria-label": "Recent sessions",
            "aria-expanded": String(sessionsOpen),
            disabled: !connected,
            onclick: () => {
              sessionsOpen = !sessionsOpen;
              if (sessionsOpen) send({ type: "refreshSessions" });
              render();
            },
          },
          "☰",
        ),
        h(
          "button",
          {
            className: "icon-btn",
            title: "New session",
            "aria-label": "New session",
            disabled: !connected,
            onclick: () => send({ type: "newSession" }),
          },
          "+",
        ),
      ),
      h(
        "div",
        { className: "row ws-row" },
        folderControl,
        branch
          ? h(
              "span",
              { className: "branch", title: ws.repoRoot ? `Repository: ${ws.repoRoot}` : "" },
              "⎇ ",
              branch,
            )
          : null,
        h(
          "span",
          { className: `badge repo-${ws.repoKind}`, title: ws.repoRoot ?? ws.active?.path ?? "" },
          repoLabel,
        ),
      ),
      h(
        "div",
        { className: "row selectors" },
        h(
          "label",
          { className: "selector grow", for: "model-select" },
          h("span", { className: "selector-label" }, "Model"),
          modelSel,
        ),
        variantSel
          ? h(
              "label",
              { className: "selector", for: "variant-select" },
              h("span", { className: "selector-label" }, "Variant"),
              variantSel,
            )
          : null,
      ),
      model
        ? h(
            "div",
            { className: "row model-caption muted small" },
            `${model.providerName}${model.contextLimit ? ` · ${formatTokens(model.contextLimit)} context` : ""}`,
          )
        : null,
      h(
        "div",
        { className: "row selectors" },
        h(
          "label",
          { className: "selector", for: "agent-select" },
          h("span", { className: "selector-label" }, "Agent"),
          agentSel,
        ),
        h(
          "label",
          { className: "selector", for: "budget-select" },
          h("span", { className: "selector-label" }, t("budget")),
          budgetSel,
        ),
      ),
      usageParts.length
        ? h(
            "div",
            { className: "row usage", title: "Reported by OpenCode for this session" },
            usageParts.join("  ·  "),
          )
        : null,
      taskMeter,
    ]),
  );

  const banners: HTMLElement[] = [];
  if (ws.repoKind === "worktree") {
    banners.push(
      h(
        "div",
        { className: "banner warn", role: "note" },
        h("strong", {}, "⚠ Working in a separate Git worktree"),
        h(
          "div",
          { className: "muted" },
          ws.mainWorktree ? `Main working tree: ${ws.mainWorktree}` : "This folder is a secondary worktree.",
        ),
      ),
    );
  }
  if (ws.folders.length > 1) {
    banners.push(
      h(
        "div",
        { className: "banner info" },
        `Multi-root workspace — OpenCode works in “${ws.active?.name ?? "?"}”.`,
      ),
    );
  }
  const ob = s.onboarding;
  if (ob.stage === "ready" && ob.hint) {
    const expired = ob.hint === "sign-in-expired";
    banners.push(
      h(
        "div",
        {
          className: `banner ${expired ? "warn" : "info"} hint-banner`,
          role: "note",
          "data-testid": "sign-in-hint",
        },
        h(
          "span",
          {},
          ob.signIn === "waiting"
            ? "Waiting for sign-in — finish it in the OpenCode terminal and your browser."
            : expired
              ? "OpenCode reports that your OpenCode account sign-in needs to be renewed."
              : "No OpenCode account is connected. Sign in for more models.",
        ),
        h(
          "span",
          { className: "hint-actions" },
          ob.signIn === "waiting"
            ? null
            : h("button", { className: "btn small", onclick: () => send({ type: "signIn" }) }, "Sign in"),
          expired
            ? null
            : h(
                "button",
                {
                  className: "btn subtle small",
                  "aria-label": "Dismiss sign-in note",
                  onclick: () => send({ type: "dismissSignInHint" }),
                },
                "Dismiss",
              ),
        ),
      ),
    );
  }
  if (s.showPlacementHint && connected) {
    banners.push(
      h(
        "div",
        { className: "banner info hint-banner", role: "note" },
        h(
          "span",
          {},
          "Tip: drag the OpenCode icon to the Secondary Side Bar (right) to keep chat beside your editor.",
        ),
        h(
          "button",
          {
            className: "btn subtle small",
            "aria-label": "Dismiss tip",
            onclick: () => send({ type: "dismissHint" }),
          },
          "Dismiss",
        ),
      ),
    );
  }
  bannerEl.replaceChildren(...banners);
}

// ------------------------------------------------------------- current task

const STATUS_KEYS = {
  running: "statusRunning",
  waiting: "statusWaiting",
  completed: "statusCompleted",
  stopped: "statusStopped",
  "budget-stopped": "statusBudget",
  failed: "statusFailed",
} as const;

let taskSignature = "";

function renderTask(s: ViewState) {
  const task = s.task;
  // Skip identical re-renders (state is pushed often while the agent runs) so the
  // expanded prompt keeps its scroll position and focus.
  const signature = JSON.stringify([
    task,
    taskExpanded,
    taskPrompt?.id,
    taskPrompt?.text.length,
    copyFeedback.get(TASK_KEY),
    s.locale,
  ]);
  if (signature === taskSignature) return;
  taskSignature = signature;
  const active = document.activeElement;
  const focusKey = active instanceof HTMLElement && taskEl.contains(active) ? active.dataset.key : undefined;
  const prevScroll = (taskEl.querySelector(".task-prompt") as HTMLElement | null)?.scrollTop ?? 0;
  taskEl.hidden = !task;
  if (!task) {
    taskEl.replaceChildren();
    taskExpanded = false;
    return;
  }
  if (taskExpandedId !== task.id) {
    // A new task starts collapsed.
    taskExpanded = false;
    taskExpandedId = task.id;
  }
  const label = task.label === "current" ? t("currentTask") : t("lastTask");
  const status = task.status ? t(STATUS_KEYS[task.status]) : null;
  const toggle = h(
    "button",
    {
      className: "task-toggle",
      "aria-expanded": String(taskExpanded),
      "aria-controls": "task-prompt",
      "data-testid": "task-toggle",
      "data-key": "task-toggle",
      title: taskExpanded ? "Hide the full prompt" : "Show the full prompt",
      onclick: () => {
        taskExpanded = !taskExpanded;
        if (taskExpanded && taskPrompt?.id !== task.id) send({ type: "getTaskPrompt" });
        renderTask(s);
      },
    },
    h(
      "span",
      { className: "task-head" },
      h("span", { className: "task-label" }, label.toUpperCase()),
      status
        ? h("span", { className: `task-status task-${task.status}`, "data-testid": "task-status" }, status)
        : null,
    ),
    h(
      "span",
      { className: "task-line" },
      h("span", { className: "task-summary", dir: "auto", "data-testid": "task-summary" }, task.summary),
      h("span", { className: "task-caret", "aria-hidden": "true" }, taskExpanded ? "▴" : "▾"),
    ),
  );
  const parts: Array<Node | null> = [toggle];
  if (task.steer) {
    parts.push(
      h(
        "div",
        { className: "task-sub", dir: "auto", "data-testid": "task-steer" },
        `${t("latestSteer")}: “${task.steer}”`,
      ),
    );
  }
  if (task.next) {
    parts.push(
      h(
        "div",
        { className: "task-sub", dir: "auto", "data-testid": "task-next" },
        `${t("next")}: ${task.next.summary}`,
        task.next.more > 0 ? h("span", { className: "task-more" }, ` +${task.next.more} queued`) : null,
      ),
    );
  }
  if (taskExpanded) {
    const text = taskPrompt?.id === task.id ? taskPrompt.text : null;
    parts.push(
      h(
        "div",
        { className: "task-details", id: "task-prompt" },
        h(
          "div",
          { className: "row task-details-head" },
          h("span", { className: "selector-label" }, t("currentPrompt")),
          h(
            "span",
            { className: "muted small" },
            `${task.lines} line${task.lines === 1 ? "" : "s"} · ${task.chars.toLocaleString()} chars`,
          ),
          copyButton(
            TASK_KEY,
            t("copyPrompt"),
            t("copyPrompt"),
            text === null,
            () => copy(TASK_KEY, TASK_KEY, { kind: "prompt" }),
            "copy-prompt",
          ),
        ),
        h(
          "pre",
          { className: "task-prompt", dir: "auto", tabindex: "0", "data-testid": "task-prompt" },
          text ?? "Loading…",
        ),
      ),
    );
  }
  taskEl.replaceChildren(...nonNull(parts));
  const pre = taskEl.querySelector(".task-prompt") as HTMLElement | null;
  if (pre) pre.scrollTop = prevScroll;
  if (focusKey)
    Array.from(taskEl.querySelectorAll<HTMLElement>("[data-key]"))
      .find((n) => n.dataset.key === focusKey)
      ?.focus();
}

// ---------------------------------------------------------------- sessions

function renderSessions(s: ViewState) {
  sessionsEl.hidden = !sessionsOpen;
  if (!sessionsOpen) return;
  const list = h("ul", { className: "session-list", role: "list" });
  if (s.sessions.length === 0)
    list.append(h("li", { className: "muted" }, "No sessions in this workspace yet."));
  for (const sess of s.sessions) {
    const current = sess.id === s.currentSession?.id;
    const meta = [relativeTime(sess.updated), sess.modelKey?.split("/").pop(), sess.agent]
      .filter(Boolean)
      .join(" · ");
    list.append(
      h(
        "li",
        {},
        h(
          "button",
          {
            className: "session-item" + (current ? " current" : ""),
            "aria-current": current ? "true" : undefined,
            title: `Created ${new Date(sess.created).toLocaleString()}`,
            onclick: () => {
              sessionsOpen = false;
              send({ type: "selectSession", id: sess.id });
              render();
            },
          },
          h("span", { className: "session-item-title", dir: "auto" }, sess.title),
          h("span", { className: "muted small" }, meta),
        ),
      ),
    );
  }
  sessionsEl.replaceChildren(
    h(
      "div",
      { className: "row" },
      h("strong", {}, "Recent sessions"),
      h(
        "button",
        {
          className: "btn subtle",
          onclick: () => {
            sessionsOpen = false;
            send({ type: "newSession" });
            render();
          },
        },
        "New Session",
      ),
    ),
    list,
  );
}

// ------------------------------------------------------------- empty state

function renderEmpty(s: ViewState) {
  const stage = s.onboarding.stage;
  let content: Array<Node | null> = [];
  if (stage === "connecting") content = [h("p", { className: "muted" }, "Connecting to OpenCode…")];
  else if (stage === "loading") {
    if (transcript.items.length === 0)
      content = [h("p", { className: "muted" }, "Checking OpenCode models and account…")];
  } else if (stage === "ready") {
    if (transcript.items.length === 0)
      content = [
        h("h2", {}, "Ask OpenCode anything"),
        h(
          "p",
          { className: "muted" },
          "Context is explicit: only the files and selections you attach are sent along with your message.",
        ),
      ];
  } else content = [renderOnboarding(s)];
  emptyEl.replaceChildren(...nonNull(content));
  emptyEl.hidden = content.length === 0;
}

// -------------------------------------------------------------- onboarding

const STAGE_STATUS: Record<OnboardingStage, string> = {
  connecting: "Connecting…",
  "not-installed": "OpenCode not installed",
  stopped: "OpenCode stopped",
  error: "Not connected",
  "no-folder": "No folder open",
  loading: "Checking…",
  "sign-in": "Sign-in required",
  "sign-in-expired": "Sign-in required",
  "no-models": "No models",
  "catalog-error": "Models unavailable",
  ready: "Connected",
};

const CHECK_MARK: Record<CheckState, string> = {
  done: "✓",
  todo: "○",
  optional: "–",
  expired: "!",
  unknown: "…",
};
const CHECK_TEXT: Record<CheckState, string> = {
  done: "done",
  todo: "not yet",
  optional: "optional",
  expired: "needs renewal",
  unknown: "not checked yet",
};

function checklist(s: ViewState): HTMLElement {
  const c = s.onboarding.checklist;
  const row = (label: string, state: CheckState, note?: string) =>
    h(
      "li",
      {
        className: `setup-check setup-${state}`,
        "data-check": state,
        "aria-label": `${label}: ${CHECK_TEXT[state]}`,
      },
      h("span", { className: "setup-mark", "aria-hidden": "true" }, CHECK_MARK[state]),
      h("span", {}, label),
      note ? h("span", { className: "muted small" }, ` ${note}`) : null,
    );
  return h(
    "ul",
    { className: "checklist", "aria-label": "Setup checklist", "data-testid": "onboarding-checklist" },
    row("Extension installed", "done"),
    row("OpenCode installed", c.installed),
    row("OpenCode connected", c.connected),
    row("Account signed in", c.account, c.account === "optional" ? "(optional)" : undefined),
    row("Models available", c.models),
  );
}

function actionBtn(label: string, msg: WebviewMessage, primary = false, testid?: string): HTMLElement {
  return h(
    "button",
    { className: primary ? "btn primary" : "btn", onclick: () => send(msg), "data-testid": testid },
    label,
  );
}

function linkBtn(label: string, link: OfficialLink): HTMLElement {
  return h(
    "button",
    { className: "link-btn", onclick: () => send({ type: "openOfficial", link }), "data-link": link },
    label,
  );
}

function renderOnboarding(s: ViewState): HTMLElement {
  const ob = s.onboarding;
  const conn = s.connection;
  const signInButtons = (primary: boolean) =>
    ob.signIn === "waiting"
      ? [actionBtn("Check again", { type: "refreshConnection" }, primary, "onb-refresh")]
      : [
          actionBtn("Sign in to OpenCode", { type: "signIn" }, primary, "onb-sign-in"),
          actionBtn("Refresh", { type: "refreshConnection" }, false, "onb-refresh"),
        ];
  let title = "";
  let body: Array<Node | string> = [];
  let actions: HTMLElement[] = [];
  let extra: Array<Node | null> = [];
  switch (ob.stage) {
    case "not-installed":
      title = "OpenCode is required";
      body = ["OpenCode Chat Sidebar is a UI for OpenCode and requires OpenCode to be installed."];
      actions = [
        actionBtn("Install OpenCode", { type: "openOfficial", link: "install" }, true, "onb-install"),
        actionBtn("Check again", { type: "retry" }, false, "onb-check"),
        actionBtn("Set Path…", { type: "configurePath" }),
      ];
      if (conn.kind === "cli-not-found")
        extra = [
          h(
            "details",
            {},
            h("summary", { className: "small" }, "Locations searched"),
            h(
              "ul",
              { className: "small" },
              ...conn.searched.slice(0, 30).map((p) => h("li", {}, h("code", {}, p))),
            ),
          ),
        ];
      break;
    case "stopped": {
      const canStart = conn.kind === "not-running" && conn.canStart;
      title = "OpenCode is installed";
      body = [
        canStart
          ? "Its background service is not running. Start it to continue."
          : conn.kind === "not-running"
            ? conn.detail
            : "",
      ];
      actions = [
        canStart ? actionBtn("Start OpenCode", { type: "startOpenCode" }, true, "onb-start") : null,
        actionBtn("Check again", { type: "retry" }, !canStart, "onb-check"),
      ].filter((x): x is HTMLElement => !!x);
      break;
    }
    case "error":
      title = "Could not connect to OpenCode";
      body = [conn.kind === "error" ? conn.message : "OpenCode did not respond."];
      actions = [
        actionBtn("Retry", { type: "retry" }, true, "onb-check"),
        actionBtn("Show Logs", { type: "showLogs" }),
      ];
      break;
    case "no-folder":
      title = "Open a project to start coding";
      body = ["OpenCode works inside a folder. Open one to start a session."];
      actions = [actionBtn("Open Folder", { type: "openFolder" }, true, "onb-open-folder")];
      break;
    case "sign-in":
    case "sign-in-expired":
      title = ob.stage === "sign-in" ? "Sign in to OpenCode" : "Sign-in needs to be renewed";
      body = [
        ob.stage === "sign-in"
          ? "No models are available yet. Sign in to your OpenCode account, or connect another provider in OpenCode."
          : "OpenCode reports that your OpenCode account sign-in has expired, and no models are available.",
      ];
      actions = [
        ...signInButtons(true),
        actionBtn("Connect another provider", { type: "connectProvider" }, false, "onb-provider"),
      ];
      extra = [
        h(
          "p",
          { className: "muted small privacy-note" },
          "Sign in using OpenCode. This extension never sees or stores your password.",
        ),
        h("p", { className: "small" }, linkBtn("Create or manage your OpenCode account", "account")),
      ];
      break;
    case "no-models":
      title = "No models are available yet.";
      body = ["Configure a provider in OpenCode or use an OpenCode Go model."];
      actions = [
        actionBtn("Configure models", { type: "connectProvider" }, true, "onb-provider"),
        actionBtn("Refresh", { type: "refreshConnection" }, false, "onb-refresh"),
      ];
      extra = [
        h(
          "p",
          { className: "small links" },
          linkBtn("Providers guide", "providers"),
          " · ",
          linkBtn("OpenCode Go", "go"),
        ),
      ];
      break;
    case "catalog-error":
      title = "Models could not be loaded";
      body = [
        "OpenCode did not return its model list. It may still be starting, or a provider may be unreachable.",
      ];
      actions = [
        actionBtn("Refresh", { type: "refreshConnection" }, true, "onb-refresh"),
        actionBtn("Show Logs", { type: "showLogs" }),
      ];
      break;
    default:
      break;
  }
  const signInNote =
    ob.signIn === "waiting"
      ? h(
          "p",
          { className: "banner info", role: "status", "data-testid": "sign-in-waiting" },
          "Waiting for sign-in — finish it in the OpenCode terminal and your browser. This view updates automatically.",
        )
      : ob.signIn === "cancelled"
        ? h(
            "p",
            { className: "banner warn", role: "status" },
            "Sign-in was not completed. You can try again.",
          )
        : ob.signIn === "failed"
          ? h(
              "p",
              { className: "banner warn", role: "status" },
              "OpenCode could not complete the sign-in. Check the terminal for details, then try again.",
            )
          : null;
  return h(
    "div",
    { className: "onboarding", "data-stage": ob.stage, "data-testid": "onboarding" },
    h("h2", {}, title),
    ...body.map((b) => h("p", {}, b)),
    signInNote,
    h("div", { className: "actions" }, ...actions),
    ...nonNull(extra),
    checklist(s),
    h("p", { className: "small muted help" }, "Need help? ", linkBtn("View setup guide", "setupGuide")),
  );
}

// -------------------------------------------------------------- transcript

function renderInline(nodes: Inline[]): Node[] {
  return nodes.map((n) => {
    switch (n.t) {
      case "text":
        return document.createTextNode(n.v);
      case "code":
        return h("code", {}, n.v);
      case "strong":
        return h("strong", {}, ...renderInline(n.c));
      case "em":
        return h("em", {}, ...renderInline(n.c));
      case "del":
        return h("del", {}, ...renderInline(n.c));
      case "br":
        return h("br");
      case "link":
        return h(
          "a",
          {
            href: n.href,
            title: n.href,
            onclick: (e: Event) => {
              e.preventDefault();
              send({ type: "openLink", href: n.href });
            },
          },
          ...renderInline(n.c),
        );
    }
  });
}

function copyButton(
  key: string,
  label: string,
  ariaLabel: string,
  disabled: boolean,
  onClick: () => void,
  testid: string,
): HTMLElement {
  const fb = copyFeedback.get(key);
  return h(
    "span",
    { className: "copy-wrap" },
    h(
      "button",
      {
        className: "btn subtle small copy-btn" + (fb === "copied" ? " copied" : ""),
        "aria-label": ariaLabel,
        "data-testid": testid,
        "data-key": key,
        disabled,
        onclick: onClick,
      },
      fb === "copied" ? t("copied") : label,
    ),
    fb === "failed" ? h("span", { className: "copy-error small", role: "alert" }, t("copyFailed")) : null,
  );
}

function renderBlocks(blocks: Block[], itemId: string, counter = { n: 0 }): Node[] {
  return blocks.map((b) => {
    switch (b.t) {
      case "p":
        return h("p", { dir: "auto" }, ...renderInline(b.c));
      case "h": {
        const level = Math.min(6, b.level + 2) as 3 | 4 | 5 | 6;
        return h(`h${level}` as "h3", { dir: "auto" }, ...renderInline(b.c));
      }
      case "hr":
        return h("hr");
      case "quote":
        return h("blockquote", {}, ...renderBlocks(b.c, itemId, counter));
      case "list": {
        const el = b.ordered
          ? h("ol", b.start !== 1 ? { start: b.start, dir: "auto" } : { dir: "auto" })
          : h("ul", { dir: "auto" });
        for (const item of b.items) el.append(h("li", {}, ...renderBlocks(item, itemId, counter)));
        return el;
      }
      case "table": {
        const table = h("table", { dir: "auto" });
        const headRow = h("tr");
        b.head.forEach((cell, i) =>
          headRow.append(
            h("th", b.align[i] ? { className: `align-${b.align[i]}` } : {}, ...renderInline(cell)),
          ),
        );
        table.append(h("thead", {}, headRow));
        const body = h("tbody");
        for (const row of b.rows) {
          const tr = h("tr");
          row.forEach((cell, i) =>
            tr.append(h("td", b.align[i] ? { className: `align-${b.align[i]}` } : {}, ...renderInline(cell))),
          );
          body.append(tr);
        }
        table.append(body);
        return h("div", { className: "table-wrap" }, table);
      }
      case "code": {
        const key = `code:${itemId}:${counter.n++}`;
        const text = b.text;
        return h(
          "div",
          { className: "codeblock" },
          h(
            "div",
            { className: "codeblock-bar" },
            h("span", { className: "muted small" }, b.lang || "code"),
            copyButton(
              key,
              t("copyCode"),
              t("copyCode"),
              false,
              () => copy(key, itemId, { kind: "code", text }),
              "copy-code",
            ),
          ),
          h("pre", { dir: "ltr" }, h("code", {}, b.text)),
        );
      }
    }
  });
}

function details(id: string, summary: Node[], body: Node[], extraClass = ""): HTMLDetailsElement {
  const el = h("details", { className: "activity " + extraClass, open: openDetails.has(id) });
  el.addEventListener("toggle", () => {
    if (el.open) openDetails.add(id);
    else openDetails.delete(id);
  });
  el.append(h("summary", {}, ...summary), h("div", { className: "activity-body" }, ...body));
  return el;
}

function fileList(files: FileChange[], diffAction: "openDiff" | "openAgentDiff" | null): HTMLElement {
  return h(
    "ul",
    { className: "file-list" },
    ...files.map((f) =>
      h(
        "li",
        {},
        h(
          "button",
          {
            className: "link-btn",
            title: `Open ${f.path}`,
            onclick: () => send({ type: "openFile", path: f.path }),
          },
          f.path,
        ),
        h("span", { className: "adds" }, `+${f.additions}`),
        h("span", { className: "dels" }, `−${f.deletions}`),
        f.status !== "modified" ? h("span", { className: "muted small" }, f.status) : null,
        diffAction
          ? h(
              "button",
              {
                className: "btn subtle small",
                "aria-label": `View diff of ${f.path}`,
                "data-testid": "file-diff",
                onclick: () => send({ type: diffAction, path: f.path }),
              },
              "Diff",
            )
          : null,
      ),
    ),
  );
}

const STATUS_ICON = { pending: "○", running: "●", completed: "✓", failed: "✕" } as const;

function shellState(item: Extract<TranscriptItem, { kind: "tool" }>): string {
  if (item.status === "pending") return "waiting";
  if (item.status === "running") return "running";
  if (item.status === "failed")
    return item.detail.exitCode !== null ? `failed (exit ${item.detail.exitCode})` : "failed";
  return "passed";
}

// ----------------------------------------------------------------- forms

function fieldValue(field: FormField, draftAnswer: FormAnswer) {
  if (field.type === "external") return undefined;
  return draftAnswer[field.key] ?? field.default;
}

function fieldActive(field: FormField, answers: FormAnswer): boolean {
  if (field.type === "external") return true;
  return (field.when ?? []).every((c) => {
    const v = answers[c.key];
    if (v === undefined || v === "") return false;
    const eq = Array.isArray(v) ? v.includes(String(c.value)) : v === c.value;
    return c.op === "eq" ? eq : !eq;
  });
}

function renderForm(item: Extract<TranscriptItem, { kind: "form" }>): HTMLElement {
  const form = item.form;
  const pending = item.status === "pending";
  const answers: FormAnswer = { ...(formDrafts.get(form.id) ?? {}) };
  const update = (key: string, v: FormAnswer[string] | undefined) => {
    const d = { ...(formDrafts.get(form.id) ?? {}) };
    if (v === undefined) delete d[key];
    else d[key] = v;
    formDrafts.set(form.id, d);
    renderItemById(item.id);
  };
  const fields: Node[] = [];
  form.fields.forEach((field, idx) => {
    if (field.type !== "external" && field.hidden) return;
    if (!fieldActive(field, answers)) return;
    const fid = `f-${form.id}-${idx}`;
    const title = field.title ?? field.key;
    const desc = field.description
      ? h("div", { className: "small muted", id: `${fid}-d` }, field.description)
      : null;
    const required =
      field.type !== "external" && field.required
        ? h("span", { className: "required", "aria-hidden": "true" }, " *")
        : null;
    const current = fieldValue(field, answers);
    if (current !== undefined && answers[field.key] === undefined && field.type !== "external")
      answers[field.key] = current;
    let control: Node;
    switch (field.type) {
      case "external":
        control = h(
          "button",
          { className: "btn", onclick: () => send({ type: "openLink", href: field.url }) },
          `Open ${field.title ?? "link"}`,
        );
        break;
      case "boolean": {
        const cb = h("input", {
          type: "checkbox",
          id: fid,
          "data-key": fid,
          disabled: !pending,
          "aria-describedby": desc ? `${fid}-d` : undefined,
        }) as HTMLInputElement;
        cb.checked = current === true;
        cb.addEventListener("change", () => update(field.key, cb.checked));
        control = h("label", { className: "check" }, cb, ` ${title}`);
        fields.push(h("div", { className: "form-field" }, control, desc));
        return;
      }
      case "multiselect": {
        const chosen = new Set(Array.isArray(current) ? current : []);
        const box = h("div", { role: "group", "aria-label": title, className: "choices" });
        for (const o of field.options) {
          const cb = h("input", {
            type: "checkbox",
            value: o.value,
            disabled: !pending,
            "data-key": `${fid}:${o.value}`,
          }) as HTMLInputElement;
          cb.checked = chosen.has(o.value);
          cb.addEventListener("change", () => {
            const next = new Set(Array.isArray(answers[field.key]) ? (answers[field.key] as string[]) : []);
            if (cb.checked) next.add(o.value);
            else next.delete(o.value);
            update(field.key, [...next]);
          });
          box.append(
            h(
              "label",
              { className: "choice", title: o.description ?? "" },
              cb,
              ` ${o.label}`,
              o.description ? h("span", { className: "muted small" }, ` — ${o.description}`) : null,
            ),
          );
        }
        control = box;
        break;
      }
      case "string": {
        if (field.options?.length) {
          const box = h("div", { role: "radiogroup", "aria-label": title, className: "choices" });
          const isCustom =
            typeof current === "string" && current !== "" && !field.options.some((o) => o.value === current);
          for (const o of field.options) {
            const rb = h("input", {
              type: "radio",
              name: fid,
              value: o.value,
              disabled: !pending,
              "data-testid": "form-option",
              "data-key": `${fid}:${o.value}`,
            }) as HTMLInputElement;
            rb.checked = current === o.value;
            rb.addEventListener("change", () => update(field.key, o.value));
            box.append(
              h(
                "label",
                { className: "choice" },
                rb,
                ` ${o.label}`,
                o.description ? h("span", { className: "muted small" }, ` — ${o.description}`) : null,
              ),
            );
          }
          if (field.custom) {
            const other = h("input", {
              type: "text",
              className: "text-input",
              placeholder: "Other…",
              "aria-label": `${title}: other answer`,
              disabled: !pending,
            }) as HTMLInputElement;
            if (isCustom) other.value = String(current);
            other.addEventListener("change", () => update(field.key, other.value || undefined));
            box.append(other);
          }
          control = box;
        } else {
          const type =
            field.format === "email"
              ? "email"
              : field.format === "uri"
                ? "url"
                : field.format === "date"
                  ? "date"
                  : field.format === "date-time"
                    ? "datetime-local"
                    : "text";
          const inp = h("input", {
            type,
            id: fid,
            className: "text-input",
            placeholder: field.placeholder,
            maxlength: field.maxLength,
            minlength: field.minLength,
            disabled: !pending,
            "aria-describedby": desc ? `${fid}-d` : undefined,
          }) as HTMLInputElement;
          if (typeof current === "string") inp.value = current;
          inp.addEventListener("change", () => update(field.key, inp.value === "" ? undefined : inp.value));
          control = inp;
        }
        break;
      }
      case "number":
      case "integer": {
        const inp = h("input", {
          type: "number",
          id: fid,
          className: "text-input",
          min: field.minimum,
          max: field.maximum,
          step: field.type === "integer" ? 1 : "any",
          disabled: !pending,
        }) as HTMLInputElement;
        if (typeof current === "number") inp.value = String(current);
        inp.addEventListener("change", () =>
          update(field.key, inp.value === "" ? undefined : Number(inp.value)),
        );
        control = inp;
        break;
      }
    }
    fields.push(
      h(
        "div",
        { className: "form-field" },
        h("label", { className: "form-label", for: fid }, title, required),
        desc,
        control,
      ),
    );
  });

  const statusText =
    item.status === "answered"
      ? "Answered"
      : item.status === "cancelled"
        ? "Cancelled"
        : item.status === "expired"
          ? "Question expired"
          : item.status === "sending"
            ? "Sending…"
            : "";
  const answerSummary =
    item.status === "answered" && item.answer
      ? h(
          "div",
          { className: "small" },
          ...form.fields
            .filter((f) => f.type !== "external" && item.answer && item.answer[f.key] !== undefined)
            .map((f) => {
              const v = item.answer![f.key];
              return h(
                "div",
                {},
                `${f.title ?? f.key}: ${Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v)}`,
              );
            }),
        )
      : null;
  const error = formErrors.get(form.id);
  return h(
    "div",
    {
      className: "form-card" + (pending ? " pending" : ""),
      role: pending ? "group" : undefined,
      "aria-label": form.title,
      "data-testid": "form-card",
    },
    h("div", { className: "permission-title" }, pending ? `❓ ${form.title}` : form.title),
    ...fields,
    error ? h("div", { className: "error-text small", role: "alert" }, error) : null,
    pending
      ? h(
          "div",
          { className: "actions" },
          h(
            "button",
            {
              className: "btn primary",
              "data-testid": "form-submit",
              onclick: () => {
                formErrors.delete(form.id);
                send({ type: "answerForm", formId: form.id, answer: answers });
              },
            },
            t("submit"),
          ),
          h(
            "button",
            {
              className: "btn",
              "data-testid": "form-cancel",
              onclick: () => send({ type: "cancelForm", formId: form.id }),
            },
            t("cancel"),
          ),
        )
      : h("div", { className: "small muted" }, statusText),
    answerSummary,
  );
}

// ------------------------------------------------------------- item views

function renderItem(item: TranscriptItem): HTMLElement {
  switch (item.kind) {
    case "user":
      return h(
        "div",
        { className: "msg user" },
        h("div", { className: "user-text", dir: "auto" }, item.text),
        item.attachments.length
          ? h(
              "div",
              { className: "chips" },
              ...item.attachments.map((a) => h("span", { className: "chip static" }, a)),
            )
          : null,
      );
    case "assistant": {
      const key = `msg:${item.id}`;
      const live = item.streaming && !!state?.busy;
      return h(
        "div",
        { className: "msg assistant" + (item.streaming ? " streaming" : ""), "data-testid": "assistant" },
        h("div", { className: "msg-body" }, ...renderBlocks(parseMarkdown(item.text), item.id)),
        // Footer sits underneath the response; Copy is disabled while the text is still streaming.
        item.text.trim()
          ? h(
              "div",
              { className: "msg-footer" },
              copyButton(
                key,
                t("copy"),
                t("copyMessage"),
                live,
                () => copy(key, item.id, { kind: "message" }),
                "copy-message",
              ),
            )
          : null,
      );
    }
    case "reasoning":
      return details(
        item.id,
        [
          h("span", { className: "icon muted" }, "∴"),
          h("span", { className: "muted" }, item.streaming ? "Thinking…" : "Thought"),
        ],
        [h("div", { className: "reasoning", dir: "auto" }, item.text)],
        "reasoning-row",
      );
    case "tool": {
      const d = item.detail;
      const isShell = item.category === "shell";
      const summary: Node[] = [
        h(
          "span",
          { className: `icon tool-${item.status}`, "aria-label": item.status },
          STATUS_ICON[item.status],
        ),
        h(
          "span",
          { className: "tool-title" + (isShell ? " mono" : "") },
          isShell && d.command ? `$ ${item.title}` : item.title,
        ),
      ];
      if (isShell)
        summary.push(h("span", { className: `muted small state-${item.status}` }, shellState(item)));
      if (d.files.length) {
        const c = changeCounts(d.files);
        summary.push(
          h("span", { className: "adds" }, `+${c.add}`),
          h("span", { className: "dels" }, `−${c.del}`),
        );
      }
      const body: Node[] = [];
      if (isShell && d.command) body.push(h("pre", { className: "command" }, d.command));
      if (d.cwd) body.push(h("div", { className: "small muted" }, "cwd: ", h("code", {}, d.cwd)));
      const facts = d.facts.filter(([k]) => !(isShell && k === "command"));
      if (facts.length)
        body.push(
          h("dl", { className: "facts" }, ...facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
        );
      if (d.files.length) body.push(fileList(d.files, null));
      if (d.error) body.push(h("div", { className: "error-text" }, d.error));
      if (d.output) {
        body.push(h("pre", { className: "output" }, d.output));
        if (d.outputTruncated) body.push(h("div", { className: "small muted" }, "Output truncated."));
      }
      if (!body.length)
        body.push(
          h("div", { className: "small muted" }, item.status === "running" ? "Running…" : "No details."),
        );
      return details(item.id, summary, body, `tool-row tool-${item.category}`);
    }
    case "permission": {
      const r = item.request;
      const pending = item.status === "pending";
      const resolvedText =
        item.status === "once"
          ? "Allowed once"
          : item.status === "always"
            ? "Always allowed"
            : item.status === "reject"
              ? "Denied"
              : item.status === "expired"
                ? "Request expired"
                : item.status === "sending"
                  ? "Sending…"
                  : "";
      const respond = (decision: "once" | "always" | "reject") =>
        send({ type: "respondPermission", requestId: r.id, decision });
      return h(
        "div",
        {
          className: "permission" + (pending ? " pending" : ""),
          role: pending ? "alertdialog" : "group",
          "aria-label": "Permission required",
        },
        h("div", { className: "permission-title" }, pending ? "Permission required" : "Permission"),
        h("div", { className: "permission-action" }, h("strong", {}, capitalize(r.action) + ":")),
        r.resources.length
          ? h("ul", { className: "resources" }, ...r.resources.map((res) => h("li", {}, h("code", {}, res))))
          : null,
        r.message ? h("div", { className: "small" }, r.message) : null,
        item.sensitive.length
          ? h(
              "div",
              { className: "sensitive", role: "note" },
              h("strong", {}, "⚠ Sensitive path"),
              h("ul", {}, ...item.sensitive.map((x) => h("li", {}, x))),
            )
          : null,
        pending
          ? h(
              "div",
              { className: "actions" },
              h(
                "button",
                { className: "btn primary", "data-testid": "perm-once", onclick: () => respond("once") },
                "Allow once",
              ),
              r.canAlways
                ? h(
                    "button",
                    { className: "btn", "data-testid": "perm-always", onclick: () => respond("always") },
                    "Always allow",
                  )
                : null,
              h(
                "button",
                { className: "btn danger", "data-testid": "perm-deny", onclick: () => respond("reject") },
                "Deny",
              ),
            )
          : h("div", { className: "small muted" }, resolvedText),
      );
    }
    case "turn-summary": {
      const c = changeCounts(item.files);
      return h(
        "div",
        { className: "turn-summary" },
        h(
          "div",
          {},
          h("strong", {}, `Edited ${item.files.length} file${item.files.length === 1 ? "" : "s"}`),
          " ",
          h("span", { className: "adds" }, `+${c.add}`),
          " / ",
          h("span", { className: "dels" }, `−${c.del}`),
        ),
        fileList(item.files, "openAgentDiff"),
      );
    }
    case "notice":
      return h(
        "div",
        {
          className: `notice ${item.level}`,
          role: item.level === "error" ? "alert" : undefined,
          dir: "auto",
        },
        item.text,
      );
    case "form":
      return renderForm(item);
    case "error":
      return h(
        "div",
        { className: "error-card", role: "alert", "data-testid": "error-card" },
        h("div", { className: "error-title", dir: "auto" }, item.title),
        item.detail
          ? h(
              "div",
              {
                className: "small muted",
                title: "Technical details are in the OpenCode Chat Sidebar output channel",
              },
              item.detail,
            )
          : null,
        item.actions.length
          ? h(
              "div",
              { className: "actions" },
              ...item.actions.map((a) =>
                a === "changeModel"
                  ? h(
                      "button",
                      { className: "btn", onclick: () => send({ type: "focusModelPicker" }) },
                      t("changeModel"),
                    )
                  : h(
                      "button",
                      {
                        className: "btn",
                        disabled: !!state?.busy,
                        onclick: () => send({ type: "retryLast" }),
                      },
                      t("retry"),
                    ),
              ),
            )
          : null,
      );
    case "budget": {
      const stopped = item.state === "stopped";
      const resolvedText =
        item.resolved === "continued"
          ? "Continued once."
          : item.resolved === "increased"
            ? "Budget increased; continued."
            : item.resolved === "new-session"
              ? "Started a new session."
              : null;
      const act = (action: "continue" | "increase" | "newSession") =>
        send({ type: "budgetAction", itemId: item.id, action });
      return h(
        "div",
        {
          className: `budget-card budget-${item.state}`,
          role: stopped ? "alert" : "status",
          "data-testid": `budget-${item.state}`,
        },
        h("div", { dir: "auto" }, h("strong", {}, stopped ? "⛔ " : "⚠ "), item.text),
        stopped && !item.resolved
          ? h(
              "div",
              { className: "actions" },
              h(
                "button",
                {
                  className: "btn primary",
                  "data-testid": "budget-continue",
                  disabled: !!state?.busy,
                  onclick: () => act("continue"),
                },
                t("continueOnce"),
              ),
              h(
                "button",
                {
                  className: "btn",
                  "data-testid": "budget-increase",
                  disabled: !!state?.busy,
                  onclick: () => act("increase"),
                },
                t("increaseBudget"),
              ),
              h(
                "button",
                { className: "btn", "data-testid": "budget-new", onclick: () => act("newSession") },
                t("newSession"),
              ),
            )
          : resolvedText
            ? h("div", { className: "small muted" }, resolvedText)
            : null,
      );
    }
  }
}

function renderItemById(id: string) {
  const item = transcript.get(id);
  if (!item) return;
  const el = renderItem(item);
  el.dataset.id = id;
  const prev = itemEls.get(id);
  // Keep keyboard focus on the equivalent control when an item re-renders.
  const active = document.activeElement;
  const focusKey =
    prev && active instanceof HTMLElement && prev.contains(active) ? active.dataset.key : undefined;
  if (prev) prev.replaceWith(el);
  else listEl.append(el);
  itemEls.set(id, el);
  if (focusKey) {
    const target = Array.from(el.querySelectorAll<HTMLElement>("[data-key]")).find(
      (n) => n.dataset.key === focusKey,
    );
    target?.focus();
  }
}

function renderAllItems() {
  listEl.replaceChildren();
  itemEls.clear();
  for (const item of transcript.items) renderItemById(item.id);
}

// Coalesce item re-renders to one per animation frame (streaming tokens arrive in bursts).
const dirtyItems = new Set<string>();
let frame = 0;
function scheduleItems(ids: Iterable<string>) {
  for (const id of ids) dirtyItems.add(id);
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const ids = [...dirtyItems];
    dirtyItems.clear();
    for (const id of ids) renderItemById(id);
    if (ids.length && state) renderEmpty(state);
    maybeScroll();
  });
}

// ---------------------------------------------------------- changes panel

function renderChanges(s: ViewState) {
  const ac = s.agentChanges;
  const ws = s.workspaceChanges;
  const showAgent = ac.status !== "none";
  const showWs = !!ws && ws.count > 0 && s.connection.kind === "connected";
  if (!showAgent && !showWs) {
    changesEl.replaceChildren();
    changesEl.hidden = true;
    return;
  }
  changesEl.hidden = false;
  const parts: Array<Node | null> = [];
  if (ac.status === "ok") {
    const c = changeCounts(ac.files);
    parts.push(
      h(
        "div",
        { className: "row" },
        h(
          "button",
          {
            className: "link-btn changes-toggle",
            "aria-expanded": String(changesOpen),
            "data-testid": "agent-changes-toggle",
            onclick: () => {
              changesOpen = !changesOpen;
              render();
            },
          },
          `${changesOpen ? "▾" : "▸"} ${t("agentChanges")} · ${ac.files.length} file${ac.files.length === 1 ? "" : "s"}`,
        ),
        h("span", { className: "adds" }, `+${c.add}`),
        h("span", { className: "dels" }, `−${c.del}`),
        h(
          "button",
          {
            className: "btn subtle small",
            "data-testid": "view-agent-changes",
            onclick: () => send({ type: "openAgentDiffAll" }),
            title: "Changes recorded by OpenCode's session snapshots, shown in VS Code's diff editor",
          },
          t("viewAgentChanges"),
        ),
      ),
      changesOpen ? fileList(ac.files, "openAgentDiff") : null,
    );
  } else if (ac.status === "unavailable") {
    parts.push(
      h(
        "div",
        { className: "row muted small", "data-testid": "agent-diff-unavailable", title: ac.reason },
        `${t("agentDiffUnavailable")} — ${ac.reason}`,
      ),
    );
  }
  if (showWs && ws) {
    parts.push(
      h(
        "div",
        { className: "row small" },
        h(
          "span",
          { className: "muted" },
          `${t("workspaceChanges")}: ${ws.count} file${ws.count === 1 ? "" : "s"} (HEAD ↔ working tree)`,
        ),
        h(
          "button",
          {
            className: "btn subtle small",
            "data-testid": "view-workspace-changes",
            onclick: () => send({ type: "openWorkspaceDiffAll" }),
          },
          "View",
        ),
      ),
    );
  }
  changesEl.replaceChildren(...nonNull(parts));
}

// ---------------------------------------------------------------- pending

function renderPending(s: ViewState) {
  if (!s.pending.length) {
    pendingEl.replaceChildren();
    pendingEl.hidden = true;
    return;
  }
  pendingEl.hidden = false;
  pendingEl.replaceChildren(
    ...s.pending.map((p) =>
      h(
        "div",
        { className: `pending-item pending-${p.delivery}`, "data-testid": "pending-item" },
        h("span", { className: "badge" }, p.delivery === "queue" ? t("queued") : t("steering")),
        h("span", { className: "pending-text", dir: "auto", title: p.text }, p.text),
        h(
          "button",
          {
            className: "btn subtle small",
            "aria-label": `${t("edit")}: ${p.text.slice(0, 40)}`,
            onclick: () => send({ type: "editPending", id: p.id }),
          },
          t("edit"),
        ),
        h(
          "button",
          {
            className: "btn subtle small",
            "aria-label": `${t("remove")}: ${p.text.slice(0, 40)}`,
            onclick: () => send({ type: "removePending", id: p.id }),
          },
          t("remove"),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- composer

function renderComposer(s: ViewState) {
  chipsEl.replaceChildren(
    ...s.attachments.map((a) =>
      h(
        "span",
        { className: "chip", title: a.detail },
        a.label,
        h(
          "button",
          {
            className: "chip-x",
            "aria-label": `Remove ${a.label}`,
            onclick: () => send({ type: "removeAttachment", id: a.id }),
          },
          "×",
        ),
      ),
    ),
  );
  chipsEl.hidden = s.attachments.length === 0;
  // The composer works only when the chat is usable (connected, folder open, models available).
  const connected = s.connection.kind === "connected" && s.onboarding.stage === "ready";
  input.disabled = !connected;
  input.placeholder = connected
    ? "Ask anything…  (Enter to send, Shift+Enter for newline)"
    : s.onboarding.stage === "connecting" || s.onboarding.stage === "loading"
      ? "Connecting to OpenCode…"
      : "Finish the setup above to start chatting";
  for (const b of [contextBtn, currentFileBtn, selectionBtn]) b.disabled = !connected;
  stopBtn.hidden = !s.busy;
  stopBtn.disabled = s.stopping;
  stopBtn.textContent = s.stopping ? "Stopping…" : "Stop";
  stopBtn.setAttribute("aria-label", "Stop the running OpenCode task");
  modeGroup.hidden = !s.busy;
  if (s.busy) {
    // While running, Send steers or queues (OpenCode inbox delivery), and Stop is separate.
    sendBtn.textContent = delivery === "queue" ? t("queue") : t("steer");
    sendBtn.disabled = !connected || s.stopping;
    sendBtn.className = "btn primary send";
    sendBtn.setAttribute(
      "aria-label",
      delivery === "queue" ? "Queue message until the task finishes" : "Steer the running task",
    );
    hintEl.textContent = s.stopping ? "" : "Esc to stop";
    modeGroup.replaceChildren(
      ...(["steer", "queue"] as const).map((mode) => {
        const rb = h("input", {
          type: "radio",
          name: "delivery",
          value: mode,
          "data-testid": `mode-${mode}`,
        }) as HTMLInputElement;
        rb.checked = delivery === mode;
        rb.addEventListener("change", () => {
          delivery = mode;
          persist();
          render();
        });
        return h(
          "label",
          { className: "mode-option", title: mode === "steer" ? t("steerHint") : t("queueHint") },
          rb,
          ` ${mode === "steer" ? t("steer") : t("queue")}`,
        );
      }),
      h("span", { className: "muted small" }, delivery === "steer" ? t("steerHint") : t("queueHint")),
    );
  } else {
    sendBtn.textContent = "Send";
    sendBtn.disabled = !connected;
    sendBtn.className = "btn primary send";
    sendBtn.setAttribute("aria-label", "Send message");
    hintEl.textContent = "";
  }
}

// ------------------------------------------------------------------ render

let lastAnnounced = "";
let lastBusy: boolean | null = null;
function render() {
  if (!state) return;
  renderHeader(state);
  renderTask(state);
  renderSessions(state);
  renderEmpty(state);
  renderChanges(state);
  renderPending(state);
  renderComposer(state);
  if (lastBusy !== state.busy) {
    // Copy buttons and budget/error actions depend on the running state.
    lastBusy = state.busy;
    for (const item of transcript.items)
      if (item.kind === "assistant" || item.kind === "budget" || item.kind === "error")
        scheduleItems([item.id]);
  }
  const announce = state.busy
    ? "OpenCode is working"
    : state.connection.kind === "connected"
      ? "OpenCode is idle"
      : "";
  if (announce !== lastAnnounced) {
    statusLive.textContent = announce;
    lastAnnounced = announce;
  }
}

window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as HostMessage;
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "state":
      state = msg.state;
      document.documentElement.lang = state.locale;
      render();
      break;
    case "transcript":
      transcript.reset(msg.items);
      renderAllItems();
      if (state) renderEmpty(state);
      stickToBottom = true;
      maybeScroll();
      break;
    case "events": {
      const changed = new Set<string>();
      for (const ev of msg.events) for (const id of transcript.apply(ev)) changed.add(id);
      for (const ev of msg.events)
        if (ev.type === "form.resolved" || ev.type === "form.sending") formErrors.delete(ev.formId);
      scheduleItems(changed);
      break;
    }
    case "focusInput":
      input.focus();
      break;
    case "focusModel":
      document.getElementById("model-select")?.focus();
      break;
    case "restoreInput":
      input.value = input.value ? `${msg.text}\n${input.value}` : msg.text;
      draft = input.value;
      persist();
      autosize();
      input.focus();
      break;
    case "taskPrompt":
      taskPrompt = { id: msg.id, text: msg.text };
      if (state) renderTask(state);
      break;
    case "formError":
      formErrors.set(msg.formId, msg.error);
      scheduleItems([`form:${msg.formId}`]);
      break;
    case "copyResult": {
      const req = copyRequests.get(msg.requestId);
      if (!req) break;
      copyRequests.delete(msg.requestId);
      copyFeedback.set(req.key, msg.ok ? "copied" : "failed");
      const rerender = () => {
        if (req.itemId === TASK_KEY) {
          if (state) renderTask(state);
        } else renderItemById(req.itemId);
      };
      rerender();
      setTimeout(() => {
        copyFeedback.delete(req.key);
        rerender();
      }, 1800);
      break;
    }
  }
});

autosize();
send({ type: "ready" });
