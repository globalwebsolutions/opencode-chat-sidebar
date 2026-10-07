import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverExecutable, knownLocations } from "../src/core/cliDiscovery";

const base = { configuredPath: "", pathEnv: "", home: "/home/u", platform: "darwin" as NodeJS.Platform };

describe("CLI discovery", () => {
  it("prefers the configured executable path", () => {
    const r = discoverExecutable({
      ...base,
      configuredPath: "/opt/oc/opencode",
      pathEnv: "/usr/bin",
      isExecutable: () => true,
    });
    assert.deepEqual(r, { found: true, path: "/opt/oc/opencode", source: "setting" });
  });

  it("expands ~ in the configured path", () => {
    const r = discoverExecutable({
      ...base,
      configuredPath: "~/bin/opencode",
      isExecutable: (f) => f === "/home/u/bin/opencode",
    });
    assert.equal(r.found && r.path, "/home/u/bin/opencode");
  });

  it("reports an invalid configured path instead of silently falling back", () => {
    const r = discoverExecutable({
      ...base,
      configuredPath: "/nope/opencode",
      pathEnv: "/usr/bin",
      isExecutable: (f) => f === "/usr/bin/opencode",
    });
    assert.equal(r.found, false);
    assert.equal(!r.found && r.configuredInvalid, true);
  });

  it("rejects a relative configured path", () => {
    const r = discoverExecutable({ ...base, configuredPath: "bin/opencode", isExecutable: () => true });
    assert.equal(r.found, false);
  });

  it("searches PATH in order and ignores relative PATH entries", () => {
    const seen: string[] = [];
    const r = discoverExecutable({
      ...base,
      pathEnv: "relative/dir:/a:/b",
      isExecutable: (f) => {
        seen.push(f);
        return f === "/b/opencode";
      },
    });
    assert.deepEqual(r, { found: true, path: "/b/opencode", source: "PATH" });
    assert.ok(!seen.some((f) => f.startsWith("relative")));
  });

  it("falls back to known install locations such as ~/.opencode/bin", () => {
    const r = discoverExecutable({
      ...base,
      pathEnv: "/usr/sbin",
      isExecutable: (f) => f === "/home/u/.opencode/bin/opencode",
    });
    assert.deepEqual(r, { found: true, path: "/home/u/.opencode/bin/opencode", source: "known-location" });
  });

  it("returns every searched location when not found", () => {
    const r = discoverExecutable({ ...base, pathEnv: "/x", isExecutable: () => false });
    assert.equal(r.found, false);
    if (!r.found) {
      assert.ok(r.searched.includes("/x/opencode"));
      assert.ok(r.searched.includes("/home/u/.opencode/bin/opencode"));
      assert.equal(new Set(r.searched).size, r.searched.length, "no duplicates");
    }
  });

  it("uses Windows executable names and separators", () => {
    const r = discoverExecutable({
      configuredPath: "",
      pathEnv: "C:\\tools;C:\\bin",
      home: "C:\\Users\\u",
      platform: "win32",
      isExecutable: (f) => f.toLowerCase().endsWith("bin\\opencode.cmd") || f === "C:\\bin/opencode.cmd",
    });
    assert.equal(r.found, true);
    assert.ok(knownLocations("C:\\Users\\u", "win32").some((p) => p.endsWith("opencode.exe")));
  });
});
