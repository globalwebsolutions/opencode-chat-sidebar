# Security

OpenCode Chat Sidebar is a user interface for a locally running OpenCode service. This document describes how the extension handles connections, permissions, secrets and diffs.

## Local service discovery

- By default the extension uses the OpenCode 2 background service registered on this machine in OpenCode's own `service.json` (under `$XDG_STATE_HOME/opencode/` or `~/.local/state/opencode/`). It checks the service with `GET /api/info` and verifies the reported process id.
- A registered service that is **not on a loopback address** (`127.0.0.0/8`, `localhost`, `::1`) is refused.
- A custom `opencodeSidebar.serverUrl` must also be loopback unless you explicitly enable `opencodeSidebar.allowRemoteServer`. The service password is sent only to the registered service's own origin.
- The extension never changes how OpenCode binds. **Start OpenCode** runs `opencode service start`, and OpenCode decides the address.

## Workspace trust

The extension declares `untrustedWorkspaces: { supported: false }`, so it is disabled in Restricted Mode. OpenCode can read files and run commands, so only trusted workspaces should be used.

## Permissions

- Every OpenCode permission request appears as a card in the sidebar. Nothing is approved automatically.
- **Always allow** is offered only when OpenCode supports it for that request, and OpenCode stores the resulting rule.
- **Sensitive path warnings** are added for `.env` files (templates such as `.env.example` excluded), SSH directories and keys, GnuPG, private keys and certificates (`.pem`, `.key`, …), keystores (`.jks`, `.p12`, …) and common credential files (`.npmrc`, `.netrc`, cloud CLI credentials, …). Attaching such a file yourself asks for confirmation first.

## Credentials and logging

- The extension stores no provider credentials and no OpenCode password. The service password is held in memory only and used in the `Authorization` header to the local service.
- Sign-in is OpenCode's own: **Sign in to OpenCode** runs `opencode auth login` in a VS Code terminal, and OpenCode stores the result. The extension has no login form, never asks for passwords, emails, API keys or tokens, and never reads browser cookies.
- Account state is read from OpenCode's integration list as connection states only. Connection labels and ids are discarded, and the credential API (`/api/credential`, which returns credential values) is never called.
- Model records from OpenCode can include provider headers or request bodies. These are dropped as soon as they arrive and never reach the UI or the logs.
- Logs (output channel **OpenCode Chat Sidebar**) leave out prompts, file contents and tool payloads. Authorization headers, passwords, tokens, API-key patterns and URL credentials are redacted. Provider errors are logged with type, HTTP status, provider, model and a redacted, length-limited message.

## Webview

- The sidebar runs with a strict Content Security Policy: no remote content, nonce-only scripts, no inline styles, no `eval`.
- Model output is rendered from a parsed Markdown tree using DOM text APIs, never as HTML. Links with unsafe schemes are dropped, and link clicks are handled by the extension (only `http(s)` opens externally).
- Every message from the webview to the extension is validated against a strict schema (known type, field types, size limits, no extra keys).

## Diffs

- Agent changes are rebuilt from OpenCode's full-file session patches and shown as read-only virtual documents in VS Code's native diff editor. Nothing is written to disk.
- Partial, binary or inconsistent patches are rejected and reported as unavailable instead of guessed.
- Diff and changed-file actions resolve paths only inside the active workspace folder. Links to absolute file paths in chat open that existing file in the editor; nothing is executed.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting:

https://github.com/globalwebsolutions/opencode-chat-sidebar/security/advisories/new

Please do not open a public issue for security problems, and never include secrets or credentials in reports. For everything else, use the issue tracker: https://github.com/globalwebsolutions/opencode-chat-sidebar/issues
