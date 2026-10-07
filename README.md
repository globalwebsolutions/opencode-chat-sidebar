# OpenCode Sidebar (Unofficial)

**Unofficial VS Code interface for OpenCode.** This project is not affiliated with or endorsed by the OpenCode project.

OpenCode Sidebar adds a chat panel to VS Code's Activity Bar for the [OpenCode](https://opencode.ai) coding agent that is already installed on your machine. OpenCode still does all the work: models, agents, tools, permissions and sessions. The extension is only the user interface.

## Features

- **Sidebar chat** with streaming Markdown answers, links and tables. Enter sends; Shift+Enter adds a new line.
- **Copy**: every completed answer has a **Copy** button underneath it. It copies the original Markdown exactly as OpenCode produced it (headings, lists, tables, code fences, links), and nothing else. Code blocks have their own **Copy code** button. Copy stays disabled while an answer is streaming; a stopped answer's partial text can still be copied.
- **Sessions**: start new sessions and continue recent sessions for the current workspace. Session history comes from OpenCode.
- **Model, variant and agent selectors**, filled from whatever your OpenCode configuration provides. Models are grouped by provider (for example _OpenCode Go_ and _Personal / OpenCode_). When OpenCode lists variants for a model (such as reasoning effort), a **Variant** selector appears. It is remembered per workspace and model.
- **Task budget guard** (Off / Small / Medium / Large / Custom): a local safety limit for each agent run, based on the cost and step counts OpenCode reports. It warns at 80% and, at the limit, really interrupts the run. You then choose **Continue once**, **Increase budget** or **Start new session**.
- **Questions and forms**: when the agent asks you something through OpenCode, it appears as a card in the conversation with the options OpenCode provides. Pending questions come back when you reopen the session.
- **Steer or queue while the agent works**: send a follow-up that OpenCode either injects at the agent's next step (**Steer**) or runs after the current task (**Queue**). Pending messages are listed with **Edit** and **Remove** until OpenCode delivers them.
- **Workspace header** showing the folder name, Git branch and repository type (Local Repository / Git Worktree). A warning appears when you are working in a secondary Git worktree.
- **Explicit context**: attach the current file, a selection (only the selected lines are sent, with their path and line range) or any file found with the **+ Context** search. Attached context appears as removable chips.
- **Tool activity**: compact, expandable rows for reads, searches, shell commands (command, working directory, waiting/running/passed/failed, collapsible output) and edits (+/− per file).
- **Permission prompts** rendered in the sidebar: _Allow once_, _Always allow_ (only when OpenCode offers it) and _Deny_. Requests that touch `.env` files, SSH keys, credentials, keystores or private keys get an extra warning.
- **Agent changes vs workspace changes**: **Agent changes** lists only what the agent changed in this session, using OpenCode's own snapshots, and **View Agent Changes** opens the native diff editor. Your pre-existing uncommitted edits are never attributed to the agent. **Workspace changes** (HEAD ↔ working tree) are shown separately. When OpenCode cannot attribute changes reliably, the sidebar says **Agent-only diff unavailable** and offers the workspace diff instead.
- **Stop** cancels the running task through OpenCode's interrupt API. Running commands are terminated, not just hidden.
- **Session metrics**: context-window usage, session cost and step count, plus a task meter for the budget. Only figures OpenCode reports are shown.
- **Readable errors**: provider errors such as insufficient funds, rate limits or unknown models get a plain-language message with **Change model** and **Retry**. Full technical details stay in the output channel.
- **Connection status**: Connected / Connecting… / Not running, with a **Start OpenCode** action.

## Requirements

- VS Code 1.95 or newer.
- **OpenCode 2.x**, installed and signed in to at least one provider (`opencode auth`). The extension uses the OpenCode 2 background service (`opencode service`); OpenCode 1.x is not supported.

## Getting started

> **Recommended:** move OpenCode to the **Secondary Side Bar** (right side) by dragging its icon there, or right-click the icon and choose **Move To → Secondary Side Bar**. Chat then sits beside your editor and the file Explorer stays on the left. The extension works in any location; the sidebar shows this tip once.

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

| Setting                                                           | Default                                         | Description                                                                                           |
| ----------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `opencodeSidebar.executablePath`                                  | empty                                           | Path to `opencode`. Empty means search `PATH` and common install locations (e.g. `~/.opencode/bin`).  |
| `opencodeSidebar.serverUrl`                                       | empty                                           | Use a specific OpenCode server instead of the discovered background service.                          |
| `opencodeSidebar.allowRemoteServer`                               | `false`                                         | Allow `serverUrl` to point at a non-loopback host.                                                    |
| `opencodeSidebar.defaultModel`                                    | empty                                           | `providerID/modelID` to preselect when the workspace has no remembered choice.                        |
| `opencodeSidebar.defaultAgent`                                    | empty                                           | Agent id to preselect (e.g. `build`, `plan`).                                                         |
| `opencodeSidebar.autoStart`                                       | `false`                                         | Start the background service automatically when the sidebar opens.                                    |
| `opencodeSidebar.showUsage`                                       | `true`                                          | Show context and cost figures reported by OpenCode.                                                   |
| `opencodeSidebar.budget.default`                                  | `medium`                                        | Task budget for workspaces without a remembered choice (`off`, `small`, `medium`, `large`, `custom`). |
| `opencodeSidebar.budget.small` / `.medium` / `.large` / `.custom` | `$0.10/20`, `$0.30/50`, `$1.00/120`, `$0.50/80` | `{ "maxCost": USD, "maxSteps": n }` per task. Set either value to `0` to disable that metric.         |
| `opencodeSidebar.budget.warnPercent`                              | `80`                                            | Warn when a task reaches this share of its budget.                                                    |
| `opencodeSidebar.budget.contextWarnPercent`                       | `80`                                            | Warn (never stop) when the context window is this full. `0` disables the warning.                     |

## Privacy and security

- **No telemetry.** The extension sends nothing to any service of its own.
- **Your code goes only where OpenCode sends it.** The extension talks only to the local OpenCode server, by default on `127.0.0.1`. OpenCode decides what reaches your model provider, exactly as it does in the terminal.
- **Explicit context.** Nothing is attached automatically: no open editors, repository scans, Git history or project documents. Only the files and selections you attach are sent with your message.
- **No credential storage.** Provider credentials stay in OpenCode. The extension reads the local OpenCode service's connection password from OpenCode's own registration file and keeps it in memory only. It is never written to settings, extension storage or logs.
- **No auto-approval.** Every permission request waits for your decision. _Always allow_ is offered only when OpenCode supports it for that request, and OpenCode stores the rule.
- **Logs** go to the **OpenCode Sidebar** output channel. Prompts, file contents and tool payloads are not logged, and credential-looking values are redacted.
- **Loopback only by default.** A non-local `serverUrl` is refused unless you explicitly enable `allowRemoteServer`. The extension never changes how OpenCode binds.

## Task budget

The budget is a **local** safety net against runaway agent loops. It does not reflect provider quotas.

- A **task** is one agent run: from your message until OpenCode reports the agent is idle (steered and queued follow-ups count toward the same task).
- **Cost** is the increase in the session cost OpenCode reports during the task. **Steps** are completed agent steps (model calls / tool cycles). If OpenCode reports no cost, only steps are enforced.
- At the warning threshold you see “Task budget is nearly exhausted.” At the limit, the extension calls OpenCode's interrupt API (the same as **Stop**) and shows “Task budget reached. The agent was stopped.”
- **Continue once** sends a continuation and allows one more budget's worth for the same task, without changing your workspace setting. **Increase budget** moves the workspace to the next level and continues.
- Context-window usage only produces a warning; it never stops the agent.

## Known limitations

- Requires OpenCode 2.x and its background service.
- Disabled in untrusted (Restricted Mode) workspaces, because OpenCode can read files and run commands there.
- Agent changes come from OpenCode's session snapshots, which cover the whole working tree between the agent's steps. A file you edit _while_ the agent is mid-step can therefore be included. Binary files have no agent-only diff.
- OpenCode reads attached files from disk, so unsaved editor changes are not included (the sidebar warns you).
- Editing a queued message removes it from OpenCode's queue and puts the text back in the input; OpenCode does not support changing a queued message in place.
- Provider quota figures (for example rolling or weekly limits) are not exposed by OpenCode and are not shown.
- Only the most recent 400 messages of a session are loaded when continuing it. For longer sessions, agent changes cover the loaded range.
- Arabic is used for a few new UI strings when VS Code's display language is Arabic; the rest of the UI is English.

## License

A license has not been chosen yet. Until one is added, all rights are reserved by the author.
