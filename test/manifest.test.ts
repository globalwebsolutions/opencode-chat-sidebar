import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));
const keys = Object.keys(pkg.contributes.configuration.properties as Record<string, unknown>);

describe("extension manifest", () => {
  it("keeps the release identity", () => {
    assert.deepEqual(
      [pkg.name, pkg.publisher, pkg.displayName, pkg.version],
      ["opencode-sidebar", "globalwebsolutions", "OpenCode Chat Sidebar", "0.2.1"],
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
});
