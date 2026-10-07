# OpenCode integration

Target: **OpenCode 2.x** (verified with 2.0.24). The extension uses the OpenCode v2 HTTP API, the same surface used by the official `opencode` CLI (`opencode api …`) and the generated `@opencode/client` package. The running server publishes its OpenAPI document at `GET /openapi.json`.

## Server discovery

OpenCode 2 runs one shared **background service** per user (`opencode service start|status|stop`). It registers itself in:

```
$XDG_STATE_HOME/opencode/service.json      (default ~/.local/state/opencode/service.json)
{ "id": "…", "version": "2.0.24", "url": "http://127.0.0.1:<port>", "pid": 1234, "password": "…" }
```

The extension discovers it the same way the official client does (`@opencode/client/service` → `discover`):

1. Read `service.json`.
2. Refuse to continue if `url` is not a loopback address.
3. Probe `GET /api/info` with HTTP Basic auth `opencode:<password>`, and check that the reported `pid` matches the registration (this catches stale files).

The password stays in memory and is used only in the `Authorization` header to that loopback URL. It is never persisted or logged.

If `opencodeSidebar.serverUrl` is set, that URL is used instead. It must be loopback unless `allowRemoteServer` is enabled. The service password is sent only when the configured URL has the same origin as the registered service; otherwise `OPENCODE_SERVER_PASSWORD` from the environment is used if present.

**Starting**: when no service is registered, the sidebar offers **Start OpenCode**, which runs `opencode service start` with the discovered executable and then polls discovery. OpenCode binds the service to `127.0.0.1` and keeps a single instance. The extension never kills it, because other OpenCode clients may be using it.

**Executable discovery** (`src/core/cliDiscovery.ts`): the `opencodeSidebar.executablePath` setting first (an invalid configured path is reported, never silently replaced), then absolute `PATH` entries, then known install locations (`~/.opencode/bin`, `~/.local/bin`, `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`; Windows equivalents).

## Endpoints used

All paths are under the discovered base URL. Workspace-scoped calls pass the opened folder as `location[directory]` (or `directory` for session listing).

| Purpose              | Endpoint                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Health / version     | `GET /api/info`                                                                                                                          |
| Models               | `GET /api/model`, `GET /api/provider` (display names), `GET /api/model/default`                                                          |
| Agents / modes       | `GET /api/agent` (primary, non-hidden agents only)                                                                                       |
| Sessions             | `GET /api/session?directory=…&parentID=null&order=desc`, `GET /api/session/{id}`, `POST /api/session`                                    |
| History              | `GET /api/session/{id}/message` (newest first, cursor paging; `order` must not be combined with `cursor`)                                |
| Prompt               | `POST /api/session/{id}/prompt` `{ text, files?: [{ uri, name }] }`                                                                      |
| Switch model / agent | `POST /api/session/{id}/model`, `POST /api/session/{id}/agent`                                                                           |
| Running state        | `GET /api/session/active`                                                                                                                |
| Cancel               | `POST /api/session/{id}/interrupt` → `{ interrupted }`                                                                                   |
| Permissions          | `GET /api/session/{id}/permission`, `POST /api/session/{id}/permission/{requestID}/reply` `{ decision: "once" \| "always" \| "reject" }` |
| Changed files        | `GET /api/session/{id}/diff`                                                                                                             |
| Events               | `GET /api/event` (Server-Sent Events, global for all locations)                                                                          |

Model records include provider `headers`/`body`/`settings`. The adapter drops these immediately (`toModelOption`) because they can contain secrets.

## Events

The event stream is global, so the controller filters by `sessionID`. Event payload schemas come from `@opencode/schema` (`session-event.js`, `permission.js`, `session-status-event.js`). The events used:

| OpenCode event                                   | Internal `UiEvent`                             |
| ------------------------------------------------ | ---------------------------------------------- |
| `session.inbox.enqueued` (user item)             | `user.message`                                 |
| `session.execution.started`                      | `session.busy`                                 |
| `session.execution.succeeded/failed/interrupted` | `session.idle` (+ `session.error` on failure)  |
| `session.text.delta` / `.ended`                  | `assistant.delta` / `assistant.completed`      |
| `session.reasoning.delta` / `.ended`             | `reasoning.delta` / `reasoning.completed`      |
| `session.tool.input.started`                     | `tool.started`                                 |
| `session.tool.called`                            | `tool.input`                                   |
| `session.tool.progress` + `shell.created`        | `tool.shell` (command + working directory)     |
| `session.tool.success` / `.failed`               | `tool.completed` / `tool.failed`               |
| `permission.asked` / `permission.replied`        | `permission.requested` / `permission.resolved` |
| `session.step.ended` (`files`, `tokens`)         | `files.changed`, `usage.step`                  |
| `session.usage.updated`                          | `usage.session`                                |
| `session.retry.scheduled`                        | `session.retry`                                |
| `session.created/deleted/renamed`                | session list refresh, `session.renamed`        |

## Capability mapping

| UI capability         | OpenCode mechanism                                                             | Notes                                                                                         |
| --------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Allow once / Deny     | reply `once` / `reject`                                                        |                                                                                               |
| Always allow          | reply `always`                                                                 | Shown only when the request carries `save` patterns; OpenCode persists the rule.              |
| Stop                  | `interrupt`                                                                    | Verified: running shell processes are terminated and `session.execution.interrupted` follows. |
| Context usage         | last step `tokens` (input + cache read/write + output) ÷ model `limit.context` | Real figures; hidden when absent.                                                             |
| Cost                  | `session.usage.updated.cost`, `Session.cost`                                   |                                                                                               |
| Rolling/weekly quota  | —                                                                              | Not exposed by OpenCode; not shown.                                                           |
| Model variants/effort | `Model.variants`                                                               | Not exposed in v0.1 UI.                                                                       |
| Forms / questions     | `form.*`                                                                       | Not rendered in v0.1.                                                                         |

## Compatibility notes

- A location OpenCode has not loaded yet can briefly return an empty model list. The controller retries once.
- The agent's default model can differ from `GET /api/model/default`, so new sessions are always created with an explicit model.
