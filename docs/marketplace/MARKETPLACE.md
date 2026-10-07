# Marketplace release notes (internal)

This folder is not shipped in the VSIX.

## Identity

| Field        | Value                                                     |
| ------------ | --------------------------------------------------------- |
| Display name | OpenCode Chat Sidebar                                     |
| Publisher ID | `globalwebsolutions` (display name: Global Web Solutions) |
| Package name | `opencode-sidebar`, unchanged since 0.1.0                 |
| Identifier   | `globalwebsolutions.opencode-sidebar`                     |
| License      | MIT                                                       |

Do not rename `name` or `publisher` after the first upload: together they form the extension ID that installs and updates track. Setting keys (`opencodeSidebar.*`), command IDs and the view ID are part of users' saved state and must stay stable too.

## Screenshots

Generated from the real webview bundle with generic demo data (`npm run build && node scripts/screenshots.mjs`). They are 800×1720 px (2× DPR) PNGs, VS Code Dark Modern colors:

| File                               | Caption                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `screenshots/1-chat.png`           | Chat beside your code: model (grouped by provider), variant, agent, Budget Guard, selection context, tool activity, Copy / Copy code |
| `screenshots/2-budget.png`         | Budget Guard: warning, then the agent is stopped with Continue once / Increase budget / Start new session                            |
| `screenshots/3-agent-changes.png`  | Agent changes (from OpenCode session snapshots) kept separate from workspace changes                                                 |
| `screenshots/4-question-steer.png` | Answer the agent's questions in place; steer or queue instructions while it works                                                    |

**They are not referenced from README.md yet.** Marketplace README images must use public HTTPS URLs, and there is no public repository yet. After one exists, add for example:

```md
![Chat](https://raw.githubusercontent.com/<org>/<repo>/main/docs/marketplace/screenshots/1-chat.png)
```

Then set `repository`, `bugs` and `homepage` in package.json and remove `--allow-missing-repository` from the `package` script.

## Manual upload steps (not automated)

1. Sign in at https://marketplace.visualstudio.com/manage and confirm the publisher `globalwebsolutions` exists and is owned by you.
2. Build: `npm ci && npm run package` → `dist-vsix/opencode-sidebar-0.2.1.vsix`.
3. Upload with **New extension → Visual Studio Code** in the web portal and choose the `.vsix` file. This needs no personal access token. (Alternatively `vsce publish --packagePath <file>` with a PAT you create yourself; this project never creates one.)
4. Check the listing: name, icon, README rendering, categories (AI, Chat, Other), license.
5. Install from the Marketplace in a clean VS Code profile and run the smoke test (connect, models, agents, one prompt, Copy, Stop).
