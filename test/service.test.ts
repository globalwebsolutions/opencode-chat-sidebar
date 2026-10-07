import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  basicAuth,
  discoverServer,
  isLoopbackUrl,
  parseRegistration,
  serviceFilePath,
} from "../src/opencode/service";

const REG = JSON.stringify({
  id: "x",
  version: "2.0.24",
  url: "http://127.0.0.1:49374",
  pid: 1640,
  password: "pw",
});

function deps(file: string | undefined, info: { status: number; body?: unknown } | Error) {
  const seen: Array<{ url: string; auth?: string }> = [];
  return {
    seen,
    deps: {
      readFile: async () => file,
      env: {} as NodeJS.ProcessEnv,
      home: "/home/u",
      fetch: (async (input: string | URL, init?: RequestInit) => {
        seen.push({ url: String(input), auth: (init?.headers as Record<string, string>)?.authorization });
        if (info instanceof Error) throw info;
        return new Response(JSON.stringify(info.body ?? {}), { status: info.status });
      }) as typeof fetch,
    },
  };
}

describe("server discovery", () => {
  it("resolves the service registration file like the official client", () => {
    assert.equal(serviceFilePath({}, "/home/u"), "/home/u/.local/state/opencode/service.json");
    assert.equal(serviceFilePath({ XDG_STATE_HOME: "/xdg" }, "/home/u"), "/xdg/opencode/service.json");
    assert.equal(
      serviceFilePath({ XDG_STATE_HOME: "relative" }, "/home/u"),
      "/home/u/.local/state/opencode/service.json",
    );
  });

  it("parses registrations defensively", () => {
    assert.equal(parseRegistration(undefined), undefined);
    assert.equal(parseRegistration("{bad"), undefined);
    assert.equal(parseRegistration('{"pid":1}'), undefined);
    assert.equal(parseRegistration(REG)?.url, "http://127.0.0.1:49374");
  });

  it("connects to the registered background service with basic auth after verifying the pid", async () => {
    const d = deps(REG, { status: 200, body: { version: "2.0.24", pid: 1640 } });
    const r = await discoverServer({ serverUrl: "", allowRemote: false }, d.deps);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.endpoint.url, "http://127.0.0.1:49374");
      assert.equal(r.endpoint.authorization, basicAuth("pw"));
      assert.equal(r.version, "2.0.24");
    }
    assert.equal(d.seen[0].url, "http://127.0.0.1:49374/api/info");
    assert.equal(d.seen[0].auth, "Basic " + Buffer.from("opencode:pw").toString("base64"));
  });

  it("reports not-registered when no service is running", async () => {
    const r = await discoverServer(
      { serverUrl: "", allowRemote: false },
      deps(undefined, { status: 200 }).deps,
    );
    assert.ok(!r.ok && r.reason === "not-registered");
  });

  it("reports a stale registration (nothing listening or another pid)", async () => {
    const r1 = await discoverServer(
      { serverUrl: "", allowRemote: false },
      deps(REG, new TypeError("ECONNREFUSED")).deps,
    );
    assert.ok(!r1.ok && r1.reason === "not-responding");
    const r2 = await discoverServer(
      { serverUrl: "", allowRemote: false },
      deps(REG, { status: 200, body: { version: "2.0.24", pid: 999 } }).deps,
    );
    assert.ok(!r2.ok && r2.reason === "not-responding");
  });

  it("reports rejected credentials", async () => {
    const r = await discoverServer({ serverUrl: "", allowRemote: false }, deps(REG, { status: 401 }).deps);
    assert.ok(!r.ok && r.reason === "unauthorized");
  });

  it("refuses a non-loopback registered service", async () => {
    const reg = JSON.stringify({ url: "http://10.0.0.5:4096", password: "pw" });
    const d = deps(reg, { status: 200, body: {} });
    const r = await discoverServer({ serverUrl: "", allowRemote: false }, d.deps);
    assert.ok(!r.ok && r.reason === "invalid-setting");
    assert.equal(d.seen.length, 0, "never contacted");
  });

  it("refuses a remote configured server URL unless explicitly allowed", async () => {
    const d = deps(REG, { status: 200, body: { version: "x", pid: 1 } });
    const r = await discoverServer({ serverUrl: "http://192.168.1.20:4096", allowRemote: false }, d.deps);
    assert.ok(!r.ok && r.reason === "invalid-setting");
    assert.equal(d.seen.length, 0);
    const r2 = await discoverServer({ serverUrl: "http://192.168.1.20:4096", allowRemote: true }, d.deps);
    assert.ok(
      r2.ok && r2.source === "setting" && r2.endpoint.authorization === undefined,
      "service password is not sent to a different origin",
    );
  });

  it("uses the service password only for the matching configured origin", async () => {
    const d = deps(REG, { status: 200, body: { version: "x", pid: 1 } });
    const r = await discoverServer({ serverUrl: "http://127.0.0.1:49374/", allowRemote: false }, d.deps);
    assert.ok(r.ok && r.endpoint.authorization === basicAuth("pw"));
  });

  it("recognizes loopback URLs", () => {
    for (const u of ["http://127.0.0.1:1", "http://localhost:4096", "http://[::1]:8080", "http://127.1.2.3"])
      assert.ok(isLoopbackUrl(u), u);
    for (const u of [
      "http://0.0.0.0:1",
      "http://192.168.0.1",
      "http://example.com",
      "ftp://127.0.0.1",
      "nonsense",
    ])
      assert.ok(!isLoopbackUrl(u), u);
  });
});
