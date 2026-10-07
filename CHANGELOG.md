# Changelog

## 0.2.1

Marketplace readiness release. No new features.

- New display name: **OpenCode Chat Sidebar** (extension identifier `globalwebsolutions.opencode-sidebar`; setting keys and command IDs unchanged).
- Marketplace metadata: publisher, description, categories, keywords and MIT license.
- Rewritten README for the Marketplace, with an unofficial-extension disclaimer and Privacy section; new SECURITY.md.
- User-facing labels (command category, settings title, output channel) now read "OpenCode Chat Sidebar".
- Packaging validated: lean VSIX with no tests, sources or development files.
- Fix (found during release validation): a Git status refresh while models were still loading reloaded the catalog and could reset the selected model to OpenCode's default. Branch and Git status updates no longer reload the catalog; only switching to a different folder does.

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
