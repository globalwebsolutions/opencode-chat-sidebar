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

## v0.2 endpoints and events

| Purpose                 | Endpoint / event                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steer / queue a message | `POST /api/session/{id}/prompt` with `delivery: "steer" \| "queue"` (verified: steer is injected at the next step boundary; queue is delivered after the current task, within the same execution) |
| Pending messages        | `GET /api/session/{id}/inbox`, `DELETE /api/session/{id}/inbox/{inboxID}`; events `session.inbox.enqueued/delivered/cancelled/delivery.changed`                                                   |
| Questions / forms       | events `form.created` (session id inside `form`), `form.replied`, `form.cancelled`; `GET /api/session/{id}/form`, `POST …/form/{formID}/reply { answer }`, `DELETE …/form/{formID}`               |
| Model variants          | `Model.variants[].id`; `variant` on `Model.Ref` for `POST /api/session` and `POST /api/session/{id}/model`                                                                                        |
| Agent-only changes      | `GET /api/session/{id}/diff?from=<first user msg>&to=<last user msg>`, with `context` omitted to get full-file patches                                                                            |
| Error details           | `session.execution.failed.error { type, message, status?, response.body? }`; the model comes from the preceding `session.step.started`                                                            |

Field types supported in forms are exactly those in `@opencode/schema` `Form.Field`: `string` (with `options`/`custom`, `format`, length and `pattern`), `number`, `integer`, `boolean`, `multiselect`, and `external` (a link). Fields marked `hidden` use their default, and `when` conditions are applied while the user answers. Unknown field types are dropped, never invented.

**Agent-only attribution.** OpenCode snapshots the whole working tree at step boundaries. The session diff compares the first snapshot of the range with the last. Changes that existed before the session (including the user's dirty files) are part of the baseline and are not attributed to the agent. The extension rebuilds both file versions from the full-file patch (`src/core/patch.ts`) and refuses partial or binary patches. If the diff request fails, or the agent's edit tools reported changes the snapshots do not contain, the UI says **Agent-only diff unavailable** and falls back to the workspace diff.

**Budget metrics actually used.** `session.usage.updated.cost` (cumulative session USD) and `session.step.ended` / `session.step.failed` (one per completed agent step). No provider quota endpoint exists, so none is shown.

## v0.3 onboarding: account and provider state

| Purpose                     | Mechanism                                                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account / provider evidence | `GET /api/integration?location[directory]=…`, reduced to `{ opencode: connected \| needs-auth \| none, otherProviders }`                                                |
| Sign in to OpenCode         | `opencode auth login opencode --method device` in a VS Code terminal (`--server <url>` when `serverUrl` is set)                                                         |
| Connect another provider    | `opencode auth login` (OpenCode's interactive provider picker) in a VS Code terminal                                                                                    |
| Re-check after sign-in      | `integration.updated`, `provider.updated`, `model.updated`, `models-dev.refreshed` events (debounced), terminal exit, and a 3 s poll while the sign-in terminal is open |

- The integration `opencode` is the OpenCode Console account (methods: API key, `OPENCODE_API_KEY`, and the `device` OAuth flow "OpenCode Console account"). Providers `opencode` (Zen) and `opencode-go` use it.
- Only `id`, `connections[].type` and `connections[].status.status` (`needs_auth`) are read. Connection labels (which can be personal), ids and methods are ignored. `GET /api/credential` returns credential values and is **never** called.
- OpenCode 2.0.24 serves some free `opencode/*-free` models without an account, so "no account" alone does not block the chat. Without any connection and without models, the sidebar asks the user to sign in.
- A fresh OpenCode location can briefly list no models; the catalog is retried before "No models" is shown.
