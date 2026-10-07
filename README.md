# OpenCode Sidebar (Unofficial)

**Unofficial VS Code interface for OpenCode.** This project is not affiliated with or endorsed by the OpenCode project.

OpenCode Sidebar adds a chat panel to VS Code's Activity Bar for the [OpenCode](https://opencode.ai) coding agent that is already installed on your machine. OpenCode still does all the work: models, agents, tools, permissions and sessions. The extension is only the user interface.

## Features (v0.1)

- **Sidebar chat** with streaming Markdown answers, code blocks with copy buttons, links and tables. Enter sends; Shift+Enter adds a new line.
- **Sessions**: start new sessions and continue recent sessions for the current workspace. Session history comes from OpenCode.
- **Model and agent selectors**, filled from whatever your OpenCode configuration provides (for example Build and Plan).
- **Workspace header** showing the folder name, Git branch and repository type (Local Repository / Git Worktree). A warning appears when you are working in a secondary Git worktree.
- **Explicit context**: attach the current file, a selection (only the selected lines are sent, with their path and line range) or any file found with the **+ Context** search. Attached context appears as removable chips.
- **Tool activity**: compact, expandable rows for reads, searches, shell commands (command, working directory, waiting/running/passed/failed, collapsible output) and edits (+/− per file).
- **Permission prompts** rendered in the sidebar: _Allow once_, _Always allow_ (only when OpenCode offers it) and _Deny_. Requests that touch `.env` files, SSH keys, credentials, keystores or private keys get an extra warning.
- **Changed files**: a per-turn summary and a session-wide panel. **View Diff** opens VS Code's native diff editor.
- **Stop** cancels the running task through OpenCode's interrupt API. Running commands are terminated, not just hidden.
- **Context and cost display**: context-window usage and session cost, when OpenCode reports them.
- **Connection status**: Connected / Connecting… / Not running, with a **Start OpenCode** action.

## Requirements

- VS Code 1.95 or newer.
- **OpenCode 2.x**, installed and signed in to at least one provider (`opencode auth`). The extension uses the OpenCode 2 background service (`opencode service`); OpenCode 1.x is not supported.

## Getting started

1. Install the extension from the `.vsix` file: **Extensions → … → Install from VSIX…**
2. Open a folder and click the **OpenCode** icon in the Activity Bar.
3. If the OpenCode background service is running, the sidebar connects immediately. If it is not, click **Start OpenCode**. This runs `opencode service start`.
4. Pick a model and an agent, then type a message.

If the `opencode` executable cannot be found, the sidebar shows **OpenCode CLI not found** with **Configure Path** and **Retry**. The extension never installs OpenCode.

## Commands

| Command                            | What it does                             |
| ---------------------------------- | ---------------------------------------- |
| OpenCode Sidebar: Focus Chat       | Reveal the sidebar and focus the input   |
| OpenCode Sidebar: New Session      | Start a fresh conversation               |
| OpenCode Sidebar: Add Current File | Attach the active editor's file          |
| OpenCode Sidebar: Add Selection    | Attach the selected lines (path + range) |
| OpenCode Sidebar: Stop             | Cancel the running task                  |

The extension adds no default keyboard shortcuts, so it never overrides editor bindings. To add your own, use **Preferences: Open Keyboard Shortcuts**. Suggested bindings:

```jsonc
// keybindings.json
{ "key": "ctrl+alt+o", "command": "opencodeSidebar.focusChat" },
{ "key": "ctrl+alt+l", "command": "opencodeSidebar.addSelection", "when": "editorHasSelection" }
```

## Settings

| Setting                             | Default | Description                                                                                          |
| ----------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `opencodeSidebar.executablePath`    | empty   | Path to `opencode`. Empty means search `PATH` and common install locations (e.g. `~/.opencode/bin`). |
| `opencodeSidebar.serverUrl`         | empty   | Use a specific OpenCode server instead of the discovered background service.                         |
| `opencodeSidebar.allowRemoteServer` | `false` | Allow `serverUrl` to point at a non-loopback host.                                                   |
| `opencodeSidebar.defaultModel`      | empty   | `providerID/modelID` to preselect when the workspace has no remembered choice.                       |
| `opencodeSidebar.defaultAgent`      | empty   | Agent id to preselect (e.g. `build`, `plan`).                                                        |
| `opencodeSidebar.autoStart`         | `false` | Start the background service automatically when the sidebar opens.                                   |
| `opencodeSidebar.showUsage`         | `true`  | Show context and cost figures reported by OpenCode.                                                  |

## Privacy and security

- **No telemetry.** The extension sends nothing to any service of its own.
- **Your code goes only where OpenCode sends it.** The extension talks only to the local OpenCode server, by default on `127.0.0.1`. OpenCode decides what reaches your model provider, exactly as it does in the terminal.
- **Explicit context.** Nothing is attached automatically: no open editors, repository scans, Git history or project documents. Only the files and selections you attach are sent with your message.
- **No credential storage.** Provider credentials stay in OpenCode. The extension reads the local OpenCode service's connection password from OpenCode's own registration file and keeps it in memory only. It is never written to settings, extension storage or logs.
- **No auto-approval.** Every permission request waits for your decision. _Always allow_ is offered only when OpenCode supports it for that request, and OpenCode stores the rule.
- **Logs** go to the **OpenCode Sidebar** output channel. Prompts, file contents and tool payloads are not logged, and credential-looking values are redacted.
- **Loopback only by default.** A non-local `serverUrl` is refused unless you explicitly enable `allowRemoteServer`. The extension never changes how OpenCode binds.

## Known limitations (v0.1)

- Requires OpenCode 2.x and its background service.
- Disabled in untrusted (Restricted Mode) workspaces, because OpenCode can read files and run commands there.
- **View Diff** compares `HEAD` with the working tree, so it also shows uncommitted changes that existed before the agent ran. The +/− counts in the panel come from OpenCode's own session diff.
- OpenCode reads attached files from disk, so unsaved editor changes are not included (the sidebar warns you).
- You cannot queue a new message while a task is running; stop it or wait.
- Interactive questions/forms that an agent may raise are not rendered yet. Use the OpenCode TUI for those, or press **Stop**.
- Model variants (for example reasoning effort) are not shown; the model's default variant is used.
- Provider quota figures (for example rolling or weekly limits) are not exposed by OpenCode and are not shown.
- Only the most recent 400 messages of a session are loaded when continuing it.

## License

A license has not been chosen yet. Until one is added, all rights are reserved by the author.
