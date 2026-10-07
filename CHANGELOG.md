# Changelog

## 0.2.3

Packaging-only release. No functional changes.

- Marketplace package name changed to **`opencode-chat-sidebar`** because `opencode-sidebar` is already taken on the Visual Studio Marketplace. The extension ID is now **`GlobalWebSolutions.opencode-chat-sidebar`**, and the VSIX is `opencode-chat-sidebar-0.2.3.vsix`.
- Display name, publisher, commands, settings keys (`opencodeSidebar.*`), view IDs, repository URLs and license are unchanged.
- 0.2.2 (`GlobalWebSolutions.opencode-sidebar`) is superseded by this release; it was never published to the Marketplace.

## 0.2.2

Packaging-only release. No functional changes.

- Marketplace publisher ID corrected to **`GlobalWebSolutions`** (exact casing of the registered publisher). The extension ID is now `GlobalWebSolutions.opencode-sidebar`. Name, display name, commands, settings keys, view IDs and repository URLs are unchanged.
- 0.2.1 was packaged with the publisher `globalwebsolutions` and is superseded by this release; it was never published to the Marketplace.

## 0.2.1

**First public release of OpenCode Chat Sidebar**, an unofficial VS Code chat interface for OpenCode agents. Source: https://github.com/globalwebsolutions/opencode-chat-sidebar

Highlights (including everything developed in 0.1.0 and 0.2.0):

- **Chat and sessions**: streaming chat with Markdown, new and recent sessions from OpenCode, models grouped by provider, model variants (such as reasoning effort) when OpenCode lists them, and agent selection.
- **Current Task** bar under the session title. It shows the prompt the agent is working on (summarized locally, no model call), its status (Running, Waiting for you, Completed, Stopped, Stopped — budget reached, Failed), the latest steer and the next queued message. Expand it for the full prompt and **Copy Prompt** to copy the exact original text.
- **Copy** the full assistant response (exact stored Markdown) and **Copy code** per code block.
- **Notifications** (VS Code native) when a task completes, needs input, fails or is stopped by Budget Guard, with **Open Chat**. Settings: `opencodeSidebar.notifications.*`.
- **Budget Guard** (Off / Small / Medium / Large / Custom): a local per-task limit on cost and steps reported by OpenCode, with a warning near the limit, a real stop at the limit, and Continue once / Increase budget / Start new session.
- **Questions and forms** from OpenCode answered in the sidebar.
- **Steer** a running task or **Queue** the next instruction, with Edit / Remove for pending messages.
- **Agent changes** from OpenCode session snapshots kept separate from **Workspace changes**, both in VS Code's native diff editor.
- Tool activity, permission prompts with sensitive-path warnings, context / cost / step figures, Git branch and worktree awareness, and readable provider errors.
- Explicit context only: current file, selected lines, or files you pick.

Release and packaging:

- Display name **OpenCode Chat Sidebar**, publisher `globalwebsolutions`, extension ID `globalwebsolutions.opencode-sidebar`, MIT license.
- Public repository, issue tracker and private vulnerability reporting on GitHub; README screenshots; SECURITY.md.
- All settings use the `opencodeSidebar.*` namespace.
- Lean VSIX: runtime bundles, CSS, icons, README, CHANGELOG, LICENSE and SECURITY only.
- Fix (found during release validation): a Git status refresh while models were still loading could reset the selected model to OpenCode's default. Branch and Git status updates no longer reload the model catalog.

Releases 0.1.0 and 0.2.0 below were local, unpublished builds under the working name "OpenCode Sidebar".

## 0.2.0 — unreleased

Daily-use improvements on top of 0.1.0 (same architecture).

- **Copy** under every completed answer copies the original Markdown exactly (from OpenCode's message text, not the rendered page), with ✓ Copied feedback. Code blocks keep a separate **Copy code**.
- **Task budget guard** (Off/Small/Medium/Large/Custom) based on OpenCode-reported cost and steps. It warns at 80%, interrupts at the limit, and offers Continue once / Increase budget / Start new session. Context-window warning added.
- **Questions/forms** from OpenCode render as cards (text, choices, custom answers, yes/no, numbers, multi-select) and come back when a session is reopened.
- **Agent-only changes** from OpenCode session snapshots (whole session, full-file patches) in the native diff editor, separate from **Workspace changes**. When attribution isn't reliable, the sidebar says “Agent-only diff unavailable”.
- **Steer / Queue** follow-ups while the agent runs, using OpenCode's inbox delivery, with pending items you can Edit or Remove.
- **Model variants** (e.g. reasoning effort) when OpenCode lists them, remembered per workspace and model. Models are grouped by provider, with a provider and context caption.
- **Readable provider errors** (insufficient funds, quota, rate limit, auth, unknown model, context length, overload, network) with Change model / Retry. Full details are logged.
- **Session titles**: broken generated titles are replaced with a short title from the first message.
- Session metrics: context, cost, steps and the task meter.
- High-contrast styling and Arabic copy/budget strings; `dir="auto"` for right-to-left text.
- One-time tip recommending the Secondary Side Bar.
- Fix: the changed-files panel now covers the whole session (0.1.0 showed only the latest turn).
- Tests: browser click-through tests of the webview, plus more unit and acceptance coverage. CI workflow added (no publishing).

## 0.1.0 — unreleased

First local preview.

- Sidebar chat for a local OpenCode 2.x installation, with streaming Markdown output.
- New and continued sessions for the current workspace (OpenCode owns session storage).
- Model and agent selectors loaded from OpenCode, remembered per workspace.
- Workspace header with Git branch and Local Repository / Git Worktree indicator, plus a warning for secondary worktrees.
- Explicit context: current file, selected lines (path + range) and workspace file search.
- Tool activity rows for reads, searches, shell commands and edits.
- Permission cards (Allow once / Always allow / Deny) with warnings for sensitive paths.
- Per-turn edit summary, session changed-files panel and native VS Code diff.
- Stop through OpenCode's interrupt API.
- Context-window and cost display when OpenCode reports them.
- Connection status, CLI discovery, and a Start OpenCode action (`opencode service start`).
