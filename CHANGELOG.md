# Changelog

## 0.3.1

UI label patch.

- The chat's Activity Bar tooltip and side bar title are shortened from "OpenCode Chat Sidebar" to **OpenCode**.
- Unchanged: Marketplace display name (OpenCode Chat Sidebar GWS), publisher, package name, extension ID `GlobalWebSolutions.opencode-chat-sidebar`, command and setting IDs, the Activity Bar icon, and all functionality.

## 0.3.0

**First-run onboarding and one-click access.**

Setup

- **Setup card with a checklist** (Extension installed, OpenCode installed, OpenCode connected, Account signed in, Models available). It detects the actual state and offers one next step:
  - OpenCode not installed: **Install OpenCode** (opens OpenCode's official install guide; nothing is run for you) and **Check again**.
  - Service not running: **Start OpenCode** (`opencode service start`), then the sidebar continues by itself.
  - No account and no models: **Sign in to OpenCode** or **Connect another provider**.
  - Account or provider connected but no models: "No models are available yet." with **Configure models** and **Refresh**.
  - No folder open: **Open Folder**.
  - Ready: the card hides itself. Users who already have OpenCode configured never see it.
- **Sign in to OpenCode** runs OpenCode's own sign-in (`opencode auth login opencode --method device`) in a VS Code terminal. **Connect another provider** opens OpenCode's provider picker (`opencode auth login`). The sidebar re-checks automatically when OpenCode reports the change, and reports a cancelled or failed sign-in. The extension never asks for, sees or stores passwords, keys or tokens.
- Signing in is optional when OpenCode offers models without an account (OpenCode's free models). A small, dismissible note suggests it instead of blocking the chat. An expired OpenCode sign-in is reported when OpenCode says so.
- The account state comes only from OpenCode's integration list (whether a connection exists, and whether it needs sign-in). Credential values are never requested, and account labels are not passed to the chat view. The sidebar never claims you are signed out unless OpenCode shows no connection at all.
- **Refresh Connection** (command, view title button, setup card) re-checks the service, account, providers, models and agents without reloading the window, and keeps your model, variant and agent selection.
- The header says **Connected** only when you can chat. Otherwise it says _Sign-in required_, _No models_, _OpenCode stopped_, _OpenCode not installed_ or _No folder open_. The model and agent pickers explain why they are empty instead of showing "Models unavailable" / "Agents unavailable".
- Links go only to official pages: opencode.ai/docs (install), opencode.ai/auth (account), opencode.ai/docs/providers and opencode.ai/docs/go, plus "Need help? View setup guide" (this README).

Easy open

- **Status Bar item**: _OpenCode Chat_, then _OpenCode: Connected_ / _Sign in required_ / _Stopped_ / _Not installed_ / _No models_. Clicking it opens the chat. Turn it off with `opencodeSidebar.showStatusBarItem`.
- **Cmd+Alt+O** on macOS opens the chat. It is not bound by default on Windows/Linux, where Ctrl+Alt combinations type characters on many keyboard layouts; the README shows how to add your own.
- The Activity Bar entry is now titled **OpenCode Chat Sidebar**.
- The Activity Bar, Status Bar, shortcut, Command Palette and the notifications' **Open Chat** all use one command, **OpenCode Chat Sidebar: Focus Chat**. It reveals the chat wherever it is (Primary or Secondary Side Bar) and focuses the message box, including when the view had not been opened yet.
- New commands: **Refresh Connection** and **Sign in to OpenCode**.
- The extension now activates after VS Code has started (`onStartupFinished`) to show the Status Bar item. It still does not connect to OpenCode or take focus until you open the chat.

Fixes (found during release validation)

- Changing several connection settings in quick succession (for example the executable path and the server URL) could leave the sidebar stuck on "Connecting…". Reconnects are now serialized and always use the latest settings.
- Catalog refreshes that overlap (OpenCode events plus the sign-in check) are coalesced, so the state always updates.

## 0.2.4

Packaging-only release. No functional changes.

- Marketplace display name changed to **OpenCode Chat Sidebar GWS** because "OpenCode Chat Sidebar" is already taken on the Visual Studio Marketplace.
- Package name (`opencode-chat-sidebar`), publisher (`GlobalWebSolutions`), extension ID `GlobalWebSolutions.opencode-chat-sidebar`, commands, settings keys (`opencodeSidebar.*`), view IDs, repository URLs and license are unchanged.
- 0.2.3 is superseded by this release; it was never published to the Marketplace.

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
