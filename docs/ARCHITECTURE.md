# Architecture

OpenCode Sidebar is a thin user interface. OpenCode remains the agent engine: it owns reasoning, tools, model providers, credentials, permissions and session storage.

```
┌────────────────────────── VS Code ──────────────────────────┐
│ Webview (sidebar)            Extension host                 │
│  src/webview/main.ts  ◀──▶  src/host/chatView.ts            │
│  rendering, input,  typed     connection, VS Code APIs,     │
│  markdown           messages  context, diff, links          │
│                                    │                        │
│                         src/core/sessionController.ts       │
│                         sessions, prompts, permissions,     │
│                         cancellation, changes, usage        │
│                                    │                        │
│                         src/opencode/  (adapter)            │
│                         OpenCodeClient ─ HttpOpenCodeClient │
└────────────────────────────────────┼────────────────────────┘
                                     │ HTTP + SSE, 127.0.0.1
                          OpenCode 2.x background service
                                     │
                        models · agents · tools · permissions
```

## Layers

| Layer            | Files                                                                                                       | Depends on VS Code? |
| ---------------- | ----------------------------------------------------------------------------------------------------------- | ------------------- |
| Shared model     | `src/shared/model.ts`, `protocol.ts`, `transcript.ts`, `tools.ts`, `userText.ts`                            | no                  |
| Core logic       | `src/core/*` (context, CLI discovery, repository detection, sensitive paths, redaction, session controller) | no                  |
| OpenCode adapter | `src/opencode/*` (client, service discovery, SSE, event normalization)                                      | no                  |
| Host integration | `src/host/*`, `src/extension.ts`                                                                            | yes                 |
| Webview UI       | `src/webview/*`                                                                                             | browser only        |

Everything except `src/host` and `src/extension.ts` runs in plain Node, so most behaviour is unit-tested without a VS Code instance.

## Integration adapter

`OpenCodeClient` (`src/opencode/client.ts`) is the only interface the UI uses to talk to OpenCode: `info`, `listModels`, `defaultModel`, `listAgents`, `listSessions`, `getSession`, `createSession`, `listMessages`, `prompt`, `switchModel`, `switchAgent`, `activeSessions`, `interrupt`, `listPermissions`, `replyPermission`, `sessionDiff` and `subscribe`. `HttpOpenCodeClient` implements it on top of the OpenCode v2 HTTP API. Another transport (for example ACP or stdio) could replace it without touching the UI. See [OPENCODE_INTEGRATION.md](OPENCODE_INTEGRATION.md).

## Event model

OpenCode emits one global event stream. `EventNormalizer` (`src/opencode/events.ts`) turns raw envelopes into the internal `UiEvent` union (`assistant.delta`, `assistant.completed`, `tool.started`, `tool.completed`, `tool.failed`, `permission.requested`, `permission.resolved`, `files.changed`, `session.idle`, `session.error`, `usage.*`, …). Raw transport objects never reach the controller or the webview. Stored history (`GET /api/session/{id}/message`) is replayed through the same `UiEvent` model by `historyToEvents`, so live and resumed sessions render identically.

`Transcript` (`src/shared/transcript.ts`) is the reducer that applies `UiEvent`s to a list of transcript items. The host keeps the canonical copy so a hidden or reloaded webview is restored instantly. The webview runs the same reducer on incremental event batches and re-renders only the items that changed.

## Webview communication

- Host → webview: `state` (header, selectors, sessions, attachments, changes, usage), `transcript` (full reset), `events` (batched `UiEvent`s, flushed every 30 ms) and `focusInput`.
- Webview → host: a closed set of intents (`send`, `stop`, `selectModel`, `respondPermission`, `openDiff`, …). `parseWebviewMessage` validates every message strictly: the type must be known, field types must match, sizes are bounded and extra keys are rejected. Invalid messages are dropped and logged.
- The webview has a strict CSP (`default-src 'none'`, nonce-only scripts, no inline styles), uses no `eval`, and builds the DOM with `textContent`/`createElement` only. Markdown is parsed into an AST and rendered without `innerHTML`; links with unsafe schemes are dropped, and link clicks are routed to the host.
- Styling uses VS Code theme variables only, so dark, light and high-contrast themes are inherited.

## Workspace and Git

`WorkspaceTracker` (`src/host/workspace.ts`):

- The active folder is the opened VS Code workspace folder. In multi-root workspaces it defaults to the first folder; a picker and banner in the header show which folder OpenCode is using. The choice is remembered and never changes silently.
- Branch and change events come from the built-in Git extension API. Without it, the tracker reads `.git/HEAD` directly and refreshes when the window regains focus.
- Repository type comes from the `.git` entry (`src/core/repository.ts`): a directory means **Local Repository**; a file pointing at `<common>/worktrees/<name>` means **Git Worktree** (the main working tree is derived and shown); a submodule counts as local.
- Nothing scans the repository on activation. The only file search happens when the user opens **+ Context → Search Workspace Files…**, and it is capped and honours `files.exclude`.

## Context efficiency

Context is always explicit (`src/core/context.ts`):

- **Current file / picked file** → an OpenCode file attachment (`file://` URI). OpenCode reads it, just as an `@file` mention does in its TUI.
- **Selection** → inlined as a fenced snippet with relative path and line range. The rest of the file is not sent.
- Nothing else is attached automatically. The transcript later shows the attachments as chips (`splitUserText`).

## Lifecycle and performance

- Activation registers the view, commands, an output channel and a content provider, and does nothing else. The OpenCode connection, Git tracking and model loading start only when the sidebar is first shown.
- The extension starts OpenCode only on explicit **Start OpenCode** (or `autoStart`), and only through `opencode service start`. OpenCode guarantees a single shared service, so repeated clicks cannot create duplicate processes; concurrent start requests are also coalesced. The service is shared with other OpenCode clients and is not stopped when VS Code closes.
- The event stream reconnects with backoff. After a reconnect the open session is reloaded from history to close any gap.

## v0.2 additions

The layering is unchanged. New logic lives in VS Code-free core modules:

| Module                | Responsibility                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `src/core/budget.ts`  | `BudgetTracker`: per-task cost/step accounting, warning/exceeded signals, Continue-once allowance |
| `src/core/forms.ts`   | Parses OpenCode `Form.Info`, conditional (`when`) fields, answer validation                       |
| `src/core/patch.ts`   | Rebuilds before/after file contents from OpenCode full-file session patches                       |
| `src/core/errors.ts`  | Classifies provider errors into readable messages and safe log lines                              |
| `src/core/titles.ts`  | Detects broken generated titles and derives a local fallback                                      |
| `src/webview/i18n.ts` | English/Arabic strings for the new controls                                                       |

- **Copy** never reads the DOM. The webview sends `copyMessage { itemId }`; the host looks up the canonical text in its `Transcript` (OpenCode's `session.text.ended` / stored message text) and writes it to the clipboard, so there is no size limit or Markdown round-trip. `copyText()` returns nothing while a message is still streaming. The webview gets `copyResult` back and shows “✓ Copied” for about 1.8 s.
- **Budget**: `SessionController` feeds `usage.step` and `usage.session` into `BudgetTracker` only for live events; replayed history never counts. Signals become `budget` transcript items. Exceeding the limit calls the same `stop()` path as the Stop button. Controller-generated events are deferred until the current batch is applied, so host and webview see the same order.
- **Inbox (steer/queue)**: `inbox.*` events are handled by the controller. Pending items live in `ViewState.pending`; on `inbox.delivered` the controller emits a `user.message`, so the transcript shows messages in the order the agent received them.
- **Agent changes** (`ViewState.agentChanges`) replace v0.1's `changes`. Patches stay in the host. `AgentDocumentProvider` (scheme `opencode-sidebar-agent`) serves the reconstructed sides to `vscode.diff` / `vscode.changes`. **Workspace changes** come from the Git extension (`uncommitted` count, HEAD ↔ working tree).
- **Webview rendering**: item updates are coalesced into one render per animation frame. Focus is restored by `data-key` after an item re-renders, so keyboard users keep their place.
