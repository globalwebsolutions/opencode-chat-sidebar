// Sidebar webview. Renders state pushed by the extension host and sends user
// intents back as typed messages. All text is inserted with textContent; no
// innerHTML, no eval.

import type { FileChange, TranscriptItem } from "../shared/model";
import type { HostMessage, ViewState, WebviewMessage } from "../shared/protocol";
import { Transcript } from "../shared/transcript";
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

// ------------------------------------------------------------------ state

let state: ViewState | null = null;
const transcript = new Transcript();
const openDetails = new Set<string>();
const itemEls = new Map<string, HTMLElement>();
let sessionsOpen = false;
let changesOpen = false;
let draft = "";

const persisted = vscode.getState() as { draft?: string } | undefined;
if (persisted?.draft) draft = persisted.draft;

// ------------------------------------------------------------------ layout

const app = document.getElementById("app")!;
const headerEl = h("header", { className: "header" });
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
const composerEl = h("footer", { className: "composer" });
app.append(headerEl, bannerEl, sessionsEl, scroller, changesEl, composerEl, statusLive);

// Composer is built once so focus/caret survive state updates.
const chipsEl = h("div", { className: "chips", "aria-label": "Attached context" });
const input = h("textarea", {
  className: "input",
  rows: 2,
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
const sendBtn = h("button", { className: "btn primary send" }, "Send");
sendBtn.addEventListener("click", () => (state?.busy ? stop() : submit()));
const hintEl = h("span", { className: "hint" });
composerEl.append(
  chipsEl,
  input,
  h(
    "div",
    { className: "composer-row" },
    h("div", { className: "context-buttons" }, contextBtn, currentFileBtn, selectionBtn),
    hintEl,
    sendBtn,
  ),
);

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    if (!state?.busy) submit();
  } else if (e.key === "Escape" && state?.busy) {
    e.preventDefault();
    stop();
  }
});
input.addEventListener("input", () => {
  draft = input.value;
  vscode.setState({ draft });
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
  send({ type: "send", text });
  input.value = "";
  draft = "";
  vscode.setState({ draft });
  autosize();
  stickToBottom = true;
}

function stop() {
  send({ type: "stop" });
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

// ------------------------------------------------------------------ header

function renderHeader(s: ViewState) {
  const conn = s.connection;
  const statusText =
    conn.kind === "connected"
      ? "Connected"
      : conn.kind === "connecting"
        ? "Connecting…"
        : conn.kind === "not-running"
          ? "Not running"
          : conn.kind === "cli-not-found"
            ? "CLI not found"
            : "Error";
  const statusTitle = conn.kind === "connected" ? `OpenCode ${conn.version} at ${conn.url}` : statusText;

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
      ? (() => {
          const sel = h("select", {
            className: "select",
            "aria-label": "Active workspace folder",
            onchange: (e: Event) => send({ type: "selectRoot", path: (e.target as HTMLSelectElement).value }),
          });
          for (const f of ws.folders) {
            const opt = h("option", { value: f.path, title: f.path }, f.name);
            if (f.path === ws.active?.path) opt.selected = true;
            sel.append(opt);
          }
          return sel;
        })()
      : h(
          "span",
          { className: "ws-name", title: ws.active?.path ?? "" },
          ws.active?.name ?? "No folder open",
        );

  const models = s.models;
  const modelSel = h("select", {
    className: "select",
    id: "model-select",
    disabled: !models || models.length === 0 || s.connection.kind !== "connected",
    onchange: (e: Event) => send({ type: "selectModel", key: (e.target as HTMLSelectElement).value }),
  });
  if (!models || models.length === 0) {
    modelSel.append(
      h(
        "option",
        {},
        s.connection.kind !== "connected" ? "—" : models ? "No models configured" : "Models unavailable",
      ),
    );
  } else {
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const m of models) {
      let g = groups.get(m.providerName);
      if (!g) {
        g = h("optgroup", { label: m.providerName });
        groups.set(m.providerName, g);
        modelSel.append(g);
      }
      const opt = h("option", { value: m.key, title: m.key }, m.name);
      if (m.key === s.selectedModel) opt.selected = true;
      g.append(opt);
    }
  }

  const agents = s.agents;
  const agentSel = h("select", {
    className: "select",
    id: "agent-select",
    disabled: !agents || agents.length === 0 || s.connection.kind !== "connected",
    onchange: (e: Event) => send({ type: "selectAgent", id: (e.target as HTMLSelectElement).value }),
  });
  if (!agents || agents.length === 0)
    agentSel.append(h("option", {}, s.connection.kind !== "connected" ? "—" : "Agents unavailable"));
  else
    for (const a of agents) {
      const opt = h("option", { value: a.id }, a.name);
      if (a.id === s.selectedAgent) opt.selected = true;
      agentSel.append(opt);
    }

  const usage = s.usage;
  const usageParts: string[] = [];
  if (usage?.contextTokens != null) {
    usageParts.push(
      `Context: ${formatTokens(usage.contextTokens)}${usage.contextLimit ? ` / ${formatTokens(usage.contextLimit)}` : ""}`,
    );
  }
  if (usage?.cost != null && usage.cost > 0)
    usageParts.push(`$${usage.cost < 0.01 ? usage.cost.toFixed(4) : usage.cost.toFixed(2)}`);

  const headerChildren: Array<Node | null> = [
    h(
      "div",
      { className: "row title-row" },
      h(
        "span",
        { className: "session-title", title: s.currentSession?.title ?? "New session" },
        s.currentSession?.title ?? "New session",
      ),
      h(
        "span",
        { className: `status status-${conn.kind}`, title: statusTitle, role: "status" },
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
          disabled: conn.kind !== "connected",
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
          disabled: conn.kind !== "connected",
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
        { className: "selector", for: "model-select" },
        h("span", { className: "selector-label" }, "Model"),
        modelSel,
      ),
      h(
        "label",
        { className: "selector", for: "agent-select" },
        h("span", { className: "selector-label" }, "Agent"),
        agentSel,
      ),
    ),
    usageParts.length
      ? h(
          "div",
          { className: "row usage", title: "Reported by OpenCode for this session" },
          usageParts.join("  ·  "),
        )
      : null,
  ];
  headerEl.replaceChildren(...headerChildren.filter((n): n is Node => n !== null));

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
  bannerEl.replaceChildren(...banners);
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
          h("span", { className: "session-item-title" }, sess.title),
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
  const conn = s.connection;
  let content: Array<Node | null> = [];
  if (conn.kind === "connecting") content = [h("p", {}, "Connecting to OpenCode…")];
  else if (conn.kind === "cli-not-found") {
    content = [
      h("h2", {}, "OpenCode CLI not found"),
      h("p", {}, "Install OpenCode, or set “OpenCode Sidebar: Executable Path” in Settings."),
      h(
        "details",
        {},
        h("summary", {}, "Locations searched"),
        h(
          "ul",
          { className: "small" },
          ...conn.searched.slice(0, 30).map((p) => h("li", {}, h("code", {}, p))),
        ),
      ),
      h(
        "div",
        { className: "actions" },
        h(
          "button",
          { className: "btn primary", onclick: () => send({ type: "configurePath" }) },
          "Configure Path",
        ),
        h("button", { className: "btn", onclick: () => send({ type: "retry" }) }, "Retry"),
      ),
    ];
  } else if (conn.kind === "not-running") {
    content = [
      h("h2", {}, "OpenCode is not running"),
      h("p", {}, conn.detail),
      h(
        "div",
        { className: "actions" },
        conn.canStart
          ? h(
              "button",
              { className: "btn primary", onclick: () => send({ type: "startOpenCode" }) },
              "Start OpenCode",
            )
          : null,
        h("button", { className: "btn", onclick: () => send({ type: "retry" }) }, "Retry"),
      ),
    ];
  } else if (conn.kind === "error") {
    content = [
      h("h2", {}, "Could not connect to OpenCode"),
      h("p", {}, conn.message),
      h(
        "div",
        { className: "actions" },
        h("button", { className: "btn primary", onclick: () => send({ type: "retry" }) }, "Retry"),
        h("button", { className: "btn", onclick: () => send({ type: "showLogs" }) }, "Show Logs"),
      ),
    ];
  } else if (!s.workspace.active) {
    content = [h("h2", {}, "No folder open"), h("p", {}, "Open a folder to work with OpenCode.")];
  } else if (transcript.items.length === 0) {
    content = [
      h("h2", {}, "Ask OpenCode anything"),
      h(
        "p",
        { className: "muted" },
        "Context is explicit: only the files and selections you attach are sent along with your message.",
      ),
    ];
  }
  emptyEl.replaceChildren(...content.filter((n): n is Node => n !== null));
  emptyEl.hidden = content.length === 0;
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

function renderBlocks(blocks: Block[]): Node[] {
  return blocks.map((b) => {
    switch (b.t) {
      case "p":
        return h("p", {}, ...renderInline(b.c));
      case "h": {
        const level = Math.min(6, b.level + 2) as 3 | 4 | 5 | 6;
        return h(`h${level}` as "h3", {}, ...renderInline(b.c));
      }
      case "hr":
        return h("hr");
      case "quote":
        return h("blockquote", {}, ...renderBlocks(b.c));
      case "list": {
        const el = b.ordered ? h("ol", b.start !== 1 ? { start: b.start } : {}) : h("ul");
        for (const item of b.items) el.append(h("li", {}, ...renderBlocks(item)));
        return el;
      }
      case "table": {
        const table = h("table");
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
      case "code":
        return h(
          "div",
          { className: "codeblock" },
          h(
            "div",
            { className: "codeblock-bar" },
            h("span", { className: "muted small" }, b.lang || "code"),
            h(
              "button",
              {
                className: "btn subtle small",
                "aria-label": "Copy code",
                onclick: () => send({ type: "copy", text: b.text }),
              },
              "Copy",
            ),
          ),
          h("pre", {}, h("code", {}, b.text)),
        );
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

function fileList(files: FileChange[], withDiff: boolean): HTMLElement {
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
        withDiff
          ? h(
              "button",
              {
                className: "btn subtle small",
                "aria-label": `View diff of ${f.path}`,
                onclick: () => send({ type: "openDiff", path: f.path }),
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

function renderItem(item: TranscriptItem): HTMLElement {
  switch (item.kind) {
    case "user":
      return h(
        "div",
        { className: "msg user" },
        h("div", { className: "user-text" }, item.text),
        item.attachments.length
          ? h(
              "div",
              { className: "chips" },
              ...item.attachments.map((a) => h("span", { className: "chip static" }, a)),
            )
          : null,
      );
    case "assistant":
      return h(
        "div",
        { className: "msg assistant" + (item.streaming ? " streaming" : "") },
        ...renderBlocks(parseMarkdown(item.text)),
      );
    case "reasoning":
      return details(
        item.id,
        [
          h("span", { className: "icon muted" }, "∴"),
          h("span", { className: "muted" }, item.streaming ? "Thinking…" : "Thought"),
        ],
        [h("div", { className: "reasoning" }, item.text)],
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
      if (d.files.length) body.push(fileList(d.files, false));
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
              h("button", { className: "btn primary", onclick: () => respond("once") }, "Allow once"),
              r.canAlways
                ? h("button", { className: "btn", onclick: () => respond("always") }, "Always allow")
                : null,
              h("button", { className: "btn danger", onclick: () => respond("reject") }, "Deny"),
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
        fileList(item.files, true),
      );
    }
    case "notice":
      return h(
        "div",
        { className: `notice ${item.level}`, role: item.level === "error" ? "alert" : undefined },
        item.text,
      );
  }
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function renderItemById(id: string) {
  const item = transcript.get(id);
  if (!item) return;
  const el = renderItem(item);
  el.dataset.id = id;
  const prev = itemEls.get(id);
  if (prev) prev.replaceWith(el);
  else listEl.append(el);
  itemEls.set(id, el);
}

function renderAllItems() {
  listEl.replaceChildren();
  itemEls.clear();
  for (const item of transcript.items) renderItemById(item.id);
}

// ---------------------------------------------------------- changes panel

function renderChanges(s: ViewState) {
  if (!s.changes.length) {
    changesEl.replaceChildren();
    changesEl.hidden = true;
    return;
  }
  changesEl.hidden = false;
  const c = changeCounts(s.changes);
  const parts: Array<Node | null> = [
    h(
      "div",
      { className: "row" },
      h(
        "button",
        {
          className: "link-btn changes-toggle",
          "aria-expanded": String(changesOpen),
          onclick: () => {
            changesOpen = !changesOpen;
            render();
          },
        },
        `${changesOpen ? "▾" : "▸"} ${s.changes.length} file${s.changes.length === 1 ? "" : "s"} changed`,
      ),
      h("span", { className: "adds" }, `+${c.add}`),
      h("span", { className: "dels" }, `−${c.del}`),
      h(
        "button",
        {
          className: "btn subtle small",
          onclick: () => send({ type: "openAllDiffs" }),
          title: "Open changes in VS Code's diff editor (HEAD ↔ working tree)",
        },
        "View Diff",
      ),
    ),
    changesOpen ? fileList(s.changes, true) : null,
  ];
  changesEl.replaceChildren(...parts.filter((n): n is Node => n !== null));
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
  const connected = s.connection.kind === "connected" && !!s.workspace.active;
  input.disabled = !connected;
  for (const b of [contextBtn, currentFileBtn, selectionBtn]) b.disabled = !connected;
  if (s.busy) {
    sendBtn.textContent = s.stopping ? "Stopping…" : "Stop";
    sendBtn.disabled = s.stopping;
    sendBtn.className = "btn danger send";
    sendBtn.setAttribute("aria-label", "Stop the running OpenCode task");
    hintEl.textContent = s.stopping ? "" : "Esc to stop";
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
function render() {
  if (!state) return;
  renderHeader(state);
  renderSessions(state);
  renderEmpty(state);
  renderChanges(state);
  renderComposer(state);
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
      for (const id of changed) renderItemById(id);
      if (changed.size && state) renderEmpty(state);
      maybeScroll();
      break;
    }
    case "focusInput":
      input.focus();
      break;
  }
});

autosize();
send({ type: "ready" });
