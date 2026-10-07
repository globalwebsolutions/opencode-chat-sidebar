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

## Webview interaction tests

`test/webview/webview.test.ts` loads `dist/webview.js` and `media/main.css` into headless Chrome through `puppeteer-core`. It uses the installed Chrome and downloads no browser. The VS Code API is stubbed, so the test records what the webview posts and delivers host messages with `window.postMessage`, as VS Code does. It covers sending, Copy/Copy code (including feedback, failure, keyboard use and Arabic), model/variant/agent/budget selection, provider grouping, permissions, question forms, Stop and Esc, steer/queue with Edit/Remove, agent vs workspace diff actions, attachments, budget and error cards, high-contrast rendering, and a performance check with 400 messages plus 2,000 streamed deltas. A high-contrast screenshot is written to `out-test/screens/`.

## CI

`.github/workflows/ci.yml` runs `npm ci`, typecheck, lint, format check, unit tests, build, the webview tests (Chrome is preinstalled on `ubuntu-latest`) and `npm run package`. The VSIX is uploaded as a workflow artifact. Nothing is published.

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

v0.2 adds these scenarios on top of the v0.1 ones:

- **Fixture:** full-report Copy compared with OpenCode's stored message, an agent-only diff on an already-dirty repository (same file and another file) that survives a session restart, steer/queue/remove, a question form that survives reopen, a budget that interrupts the real run and then Continue once, and model variants.
- **Real repository:** grouping, budget UI, full-report Copy, a question form, Stop, and session titles.

The real-repository scenario is read-only by construction: it uses OpenCode's `plan` agent (OpenCode denies all edits for it), asks only for `git status` and an explanation, and triggers a harmless permission prompt by reading this extension's own `package.json` from outside the workspace. The harness fingerprints the repository's git state (HEAD, status, staged and unstaged diff, stash) before and after and fails if anything changed. It also scans every temporary directory it created for the OpenCode service password, to prove the extension never persisted it. Because another agent may be working in the same repository, the scenario also proves it changed nothing directly: OpenCode's snapshot diff of every session it used must be empty. It disables VS Code's Git extension in the test window and runs git without optional index locks, so it never contends for `index.lock`.

Scenarios use real model calls, so they cost a small number of tokens with your configured provider.

## Marketplace screenshots

`node scripts/screenshots.mjs` (after `npm run build`) renders the screenshots in `docs/marketplace/screenshots/` from the real webview bundle with generic demo data. See `docs/marketplace/MARKETPLACE.md`.

## Packaging

`npm run package` runs the production build and `vsce package --allow-missing-repository` (the flag goes once a public repository URL exists). `.vscodeignore` ships only the two bundles, the CSS and icons, `README.md`, `CHANGELOG.md`, `LICENSE`, `SECURITY.md` and `package.json`. Nothing is published. The publisher is `globalwebsolutions`; uploading is a manual step (see `docs/marketplace/MARKETPLACE.md`).

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
