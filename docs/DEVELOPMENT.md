# Development

## Setup

```sh
npm install          # local devDependencies only; no global packages
npm run build        # esbuild → dist/extension.js, dist/webview.js
npm run watch        # rebuild on change
```

Press **F5** in VS Code with a launch configuration of type `extensionHost` pointing at this folder, or run the acceptance harness (below), which starts an isolated Extension Development Host.

## Checks

| Command                   | What it runs                                                              |
| ------------------------- | ------------------------------------------------------------------------- |
| `npm run typecheck`       | `tsc` for the host (Node) and webview (DOM) projects                      |
| `npm run lint`            | ESLint (typescript-eslint; `no-eval`, `no-explicit-any`, …)               |
| `npm run format:check`    | Prettier                                                                  |
| `npm test`                | Unit tests (`node:test`) compiled to `out-test/`                          |
| `npm run test:acceptance` | End-to-end scenarios in a real VS Code against the local OpenCode service |
| `npm run package`         | Builds `dist-vsix/opencode-sidebar-<version>.vsix` (never publishes)      |

## Unit tests

Pure modules are tested directly. Behaviour that would otherwise need a live server is tested through `MockClient` (`test/mockClient.ts`), an in-memory `OpenCodeClient`:

- CLI discovery, server discovery, loopback enforcement and the service-registration format
- repository / worktree / branch detection (synthetic, plus a real temporary Git repo with a worktree)
- message schema validation between webview and host
- the HTTP client: request shapes, auth header, paging, error mapping, SSE reconnect
- event normalization and history replay
- the transcript reducer and tool descriptions
- the session controller: lazy session creation, continuation, model/agent switching, permission mapping, cancellation
- context attachment formatting, sensitive-path detection, log redaction, Markdown parsing

## Acceptance harness

`test/acceptance/runAcceptance.ts` launches the installed VS Code (`VSCODE_EXECUTABLE` overrides the path) with temporary user-data and extensions directories and `--disable-extensions`, then runs `test/acceptance/suite.ts` inside the extension host. The suite drives the real extension through the same message handlers the webview uses, against the real OpenCode background service.

```sh
# Fixture repository (edit, changed files, native diff, sensitive-path deny, Stop) + worktree detection:
npm run test:acceptance

# Also a read-only scenario on an existing repository:
ACCEPT_REAL_REPO=/path/to/repo ACCEPT_REAL_FILE=relative/path/to/file.ext ACCEPT_REAL_LINES=20-27 \
  npm run test:acceptance
# ACCEPT_ONLY_REAL=1 skips the fixture scenarios; ACCEPT_MODEL=provider/model picks the model.
```

The real-repository scenario is read-only by construction: it uses OpenCode's `plan` agent (OpenCode denies all edits for it), asks only for `git status` and an explanation, and triggers a harmless permission prompt by reading this extension's own `package.json` from outside the workspace. The harness fingerprints the repository's git state (HEAD, status, staged and unstaged diff, stash) before and after and fails if anything changed. It also scans every temporary directory it created for the OpenCode service password, to prove the extension never persisted it.

Scenarios use real model calls, so they cost a small number of tokens with your configured provider.

## Packaging

`npm run package` runs the production build and `vsce package --skip-license --allow-missing-repository`. `.vscodeignore` ships only `dist/`, `media/`, `README.md`, `CHANGELOG.md` and `package.json`. Nothing is published, and no publisher account is needed: the `publisher` field is the placeholder `local-dev`.

## Project layout

```
src/
  extension.ts           activation (cheap): view, commands, output channel
  host/                  VS Code integration (webview provider, workspace/Git, diff, logging, config)
  core/                  VS Code-free logic (session controller, context, discovery, repository, sensitive paths)
  opencode/              OpenCode adapter (HTTP client, service discovery, SSE, event normalization)
  shared/                types and reducers shared by host and webview
  webview/               sidebar UI (vanilla TypeScript, no framework) and Markdown parser
media/                   CSS and icons
test/                    unit tests, mock client, acceptance harness
docs/                    architecture, development, OpenCode integration
```

## Dependencies

There are no runtime dependencies. The UI uses plain DOM APIs, and the Markdown renderer and SSE parser are small in-repo modules, which avoids pulling a framework or a sanitizer into the webview. Dev dependencies: TypeScript, esbuild, ESLint (+ typescript-eslint), Prettier, `@types/*`, `@vscode/vsce` and `@vscode/test-electron`. `npm audit` reports 0 vulnerabilities.
