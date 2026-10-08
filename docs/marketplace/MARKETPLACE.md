# Marketplace release notes (internal)

This folder is not shipped in the VSIX.

## Identity

| Field        | Value                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| Display name | OpenCode Chat Sidebar GWS (since 0.2.4; "OpenCode Chat Sidebar" was already taken on the Marketplace) |
| Publisher ID | `GlobalWebSolutions` (display name: Global Web Solutions; case-sensitive)                             |
| Package name | `opencode-chat-sidebar` (since 0.2.3; `opencode-sidebar` was already taken on the Marketplace)        |
| Identifier   | `GlobalWebSolutions.opencode-chat-sidebar`                                                            |
| License      | MIT                                                                                                   |

Do not rename `name` or `publisher` after the first Marketplace upload: together they form the extension ID that installs and updates track. Setting keys (`opencodeSidebar.*`), command IDs and the view ID are part of users' saved state and must stay stable too.

## Screenshots

Generated from the real webview bundle with generic demo data (`npm run build && node scripts/screenshots.mjs`). They are 800×1720 px (2× DPR) PNGs, VS Code Dark Modern colors:

| File                               | Caption                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `screenshots/1-chat.png`           | Chat beside your code: model (grouped by provider), variant, agent, Budget Guard, selection context, tool activity, Copy / Copy code |
| `screenshots/2-budget.png`         | Budget Guard: warning, then the agent is stopped with Continue once / Increase budget / Start new session                            |
| `screenshots/3-agent-changes.png`  | Agent changes (from OpenCode session snapshots) kept separate from workspace changes                                                 |
| `screenshots/4-question-steer.png` | Answer the agent's questions in place; steer or queue instructions while it works                                                    |
| `screenshots/5-onboarding.png`     | First run: the setup card with its checklist and Sign in to OpenCode (v0.3.0)                                                        |

They are referenced from README.md with URLs pinned to a release tag (`v0.2.1` for 1–4, `v0.3.0` for 5-onboarding; https://raw.githubusercontent.com/globalwebsolutions/opencode-chat-sidebar/<tag>/docs/marketplace/screenshots/…), which render on GitHub and on the Marketplace. `node scripts/screenshots.mjs 5-onboarding` renders a single screenshot.

## Public URLs

| Item       | URL                                                                                 |
| ---------- | ----------------------------------------------------------------------------------- |
| Repository | https://github.com/globalwebsolutions/opencode-chat-sidebar                         |
| Homepage   | https://github.com/globalwebsolutions/opencode-chat-sidebar#readme                  |
| Issues     | https://github.com/globalwebsolutions/opencode-chat-sidebar/issues                  |
| Security   | https://github.com/globalwebsolutions/opencode-chat-sidebar/security/advisories/new |
| Release    | https://github.com/globalwebsolutions/opencode-chat-sidebar/releases/tag/v0.3.0     |

`package.json` contains `repository`, `homepage` and `bugs`; packaging runs plain `vsce package` (no `--allow-missing-repository`, no `--skip-license`).

## Manual upload steps (not automated)

1. Sign in at https://marketplace.visualstudio.com/manage and confirm the publisher `GlobalWebSolutions` exists and is owned by you.
2. Build: `npm ci && npm run package` → `dist-vsix/opencode-chat-sidebar-0.3.0.vsix` (also attached to the GitHub release v0.3.0). Upload this file.
3. Upload with **New extension → Visual Studio Code** in the web portal and choose the `.vsix` file. This needs no personal access token. (Alternatively `vsce publish --packagePath <file>` with a PAT you create yourself; this project never creates one.)
4. Check the listing: name, icon, README rendering, categories (AI, Chat, Other), license.
5. Install from the Marketplace in a clean VS Code profile and run the smoke test (connect, models, agents, one prompt, Copy, Stop).
