# Changelog

## 0.1.0 — unreleased

First local preview.

- Sidebar chat for a local OpenCode 2.x installation, with streaming Markdown output.
- New and continued sessions for the current workspace (OpenCode owns session storage).
- Model and agent selectors loaded from OpenCode, remembered per workspace.
- Workspace header with Git branch and Local Repository / Git Worktree indicator, plus a warning for secondary worktrees.
- Explicit context: current file, selected lines (path + range) and workspace file search.
- Tool activity rows for reads, searches, shell commands and edits.
- Permission cards (Allow once / Always allow / Deny) with warnings for sensitive paths.
- Per-turn edit summary, session changed-files panel and native VS Code diff.
- Stop through OpenCode's interrupt API.
- Context-window and cost display when OpenCode reports them.
- Connection status, CLI discovery, and a Start OpenCode action (`opencode service start`).
