import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));
const keys = Object.keys(pkg.contributes.configuration.properties as Record<string, unknown>);
const commands = (pkg.contributes.commands as Array<{ command: string; title: string }>).map(
  (c) => c.command,
);

describe("extension manifest", () => {
  it("keeps the release identity", () => {
    assert.deepEqual(
      [pkg.name, pkg.publisher, pkg.displayName, pkg.version],
      ["opencode-chat-sidebar", "GlobalWebSolutions", "OpenCode Chat Sidebar GWS", "0.3.1"],
    );
  });

  it("uses a single settings namespace (opencodeSidebar.*)", () => {
    assert.deepEqual(
      keys.filter((k) => !k.startsWith("opencodeSidebar.")),
      [],
    );
  });

  it("declares the four notification settings, all on by default", () => {
    for (const k of ["taskComplete", "needsInput", "taskFailed", "budgetStopped"]) {
      const p = pkg.contributes.configuration.properties[`opencodeSidebar.notifications.${k}`];
      assert.ok(p, k);
      assert.equal(p.type, "boolean");
      assert.equal(p.default, true);
    }
  });

  it("contributes one Activity Bar container with one chat view (no duplicates)", () => {
    const containers = pkg.contributes.viewsContainers.activitybar as Array<{ id: string; title: string }>;
    assert.deepEqual(
      containers.map((c) => [c.id, c.title]),
      [["opencodeSidebar", "OpenCode"]],
    );
    assert.equal(Object.keys(pkg.contributes.views).length, 1);
    assert.deepEqual(
      pkg.contributes.views.opencodeSidebar.map((v: { id: string }) => v.id),
      ["opencodeSidebar.chat"],
    );
  });

  it("contributes Focus Chat, Refresh Connection and Sign in commands", () => {
    for (const c of [
      "opencodeSidebar.focusChat",
      "opencodeSidebar.refreshConnection",
      "opencodeSidebar.signIn",
    ])
      assert.ok(commands.includes(c), c);
    assert.equal(new Set(commands).size, commands.length, "no duplicate commands");
  });

  it("binds only Focus Chat by default, on macOS only (Cmd+Alt+O is unbound in VS Code)", () => {
    assert.deepEqual(pkg.contributes.keybindings, [
      { command: "opencodeSidebar.focusChat", key: "cmd+alt+o", when: "isMac" },
    ]);
  });

  it("activates after startup (for the Status Bar item) without a startup-blocking event", () => {
    assert.deepEqual(pkg.activationEvents, ["onStartupFinished"]);
    const p = pkg.contributes.configuration.properties["opencodeSidebar.showStatusBarItem"];
    assert.equal(p.type, "boolean");
    assert.equal(p.default, true);
  });

  it("v0.3.1: the visible chat title is the short 'OpenCode'; branding and IDs are unchanged", () => {
    const container = pkg.contributes.viewsContainers.activitybar[0];
    // Activity Bar tooltip and side bar header.
    assert.equal(container.title, "OpenCode");
    assert.equal(container.id, "opencodeSidebar");
    assert.equal(container.icon, "media/activity.svg");
    const view = pkg.contributes.views.opencodeSidebar[0];
    assert.deepEqual([view.id, view.type, view.name], ["opencodeSidebar.chat", "webview", "Chat"]);
    // Everything else keeps the full name.
    assert.equal(pkg.displayName, "OpenCode Chat Sidebar GWS");
    assert.equal(pkg.contributes.configuration.title, "OpenCode Chat Sidebar");
    for (const c of pkg.contributes.commands as Array<{ category: string }>)
      assert.equal(c.category, "OpenCode Chat Sidebar");
  });
});
