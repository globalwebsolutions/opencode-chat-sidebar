// v0.3 first-run onboarding: state derivation, account detection (privacy-safe),
// catalog refresh after sign-in, and the webview message schema.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveOnboarding,
  OPENCODE_LINKS,
  statusBarText,
  type OnboardingInput,
} from "../src/core/onboarding";
import { isCatalogEvent, SessionController } from "../src/core/sessionController";
import { HttpOpenCodeClient, parseAccountStatus } from "../src/opencode/client";
import type { ModelOption } from "../src/shared/model";
import { parseWebviewMessage } from "../src/shared/protocol";
import { MemoryStore, MockClient } from "./mockClient";

const MODEL: ModelOption = {
  key: "opencode/free-model",
  providerID: "opencode",
  id: "free-model",
  name: "Free Model",
  providerName: "OpenCode Zen",
  contextLimit: 1000,
  variants: [],
};

function input(over: Partial<OnboardingInput> = {}): OnboardingInput {
  return {
    connection: { kind: "connected", version: "2.0.24", url: "http://127.0.0.1:1" },
    hasFolder: true,
    catalogLoaded: true,
    catalogLoading: false,
    models: [MODEL],
    account: { opencode: "connected", otherProviders: false },
    signIn: "idle",
    hintDismissed: false,
    ...over,
  };
}

describe("onboarding: state derivation", () => {
  it("A. CLI not installed → not-installed with install/connect to-dos", () => {
    const v = deriveOnboarding(
      input({ connection: { kind: "cli-not-found", searched: ["/usr/bin/opencode"] } }),
    );
    assert.equal(v.stage, "not-installed");
    assert.equal(v.checklist.installed, "todo");
    assert.equal(v.checklist.connected, "todo");
    assert.equal(statusBarText(v.stage), "OpenCode: Not installed");
  });

  it("B. installed but service not running → stopped", () => {
    const v = deriveOnboarding(input({ connection: { kind: "not-running", canStart: true, detail: "x" } }));
    assert.equal(v.stage, "stopped");
    assert.deepEqual([v.checklist.installed, v.checklist.connected], ["done", "todo"]);
    assert.equal(statusBarText(v.stage), "OpenCode: Stopped");
  });

  it("C. connected, no account and no models → sign-in (only when OpenCode proves no connection)", () => {
    const v = deriveOnboarding(input({ models: [], account: { opencode: "none", otherProviders: false } }));
    assert.equal(v.stage, "sign-in");
    assert.equal(v.checklist.account, "todo");
    assert.equal(v.checklist.models, "todo");
    assert.equal(statusBarText(v.stage), "OpenCode: Sign in required");
  });

  it("never claims signed out when the account could not be checked", () => {
    const v = deriveOnboarding(input({ models: [], account: null }));
    assert.equal(v.stage, "no-models");
    assert.equal(v.checklist.account, "unknown");
  });

  it("D. account connected but no models → no-models", () => {
    const v = deriveOnboarding(input({ models: [] }));
    assert.equal(v.stage, "no-models");
    assert.equal(v.checklist.account, "done");
    assert.equal(statusBarText(v.stage), "OpenCode: No models");
  });

  it("another provider connected but no models → no-models, not sign-in", () => {
    const v = deriveOnboarding(input({ models: [], account: { opencode: "none", otherProviders: true } }));
    assert.equal(v.stage, "no-models");
    assert.equal(v.checklist.account, "optional");
  });

  it("an expired OpenCode sign-in with no models → sign-in-expired", () => {
    const v = deriveOnboarding(
      input({ models: [], account: { opencode: "needs-auth", otherProviders: false } }),
    );
    assert.equal(v.stage, "sign-in-expired");
    assert.equal(v.checklist.account, "expired");
  });

  it("E. ready: configured users see no onboarding and no hint", () => {
    const v = deriveOnboarding(input());
    assert.equal(v.stage, "ready");
    assert.equal(v.hint, null);
    assert.deepEqual(v.checklist, { installed: "done", connected: "done", account: "done", models: "done" });
    assert.equal(statusBarText(v.stage), "OpenCode: Connected");
  });

  it("ready with free models and no account → optional, dismissible sign-in hint (not blocking)", () => {
    const anon = input({ account: { opencode: "none", otherProviders: false } });
    const v = deriveOnboarding(anon);
    assert.equal(v.stage, "ready");
    assert.equal(v.hint, "sign-in-optional");
    assert.equal(v.checklist.account, "optional");
    assert.equal(deriveOnboarding({ ...anon, hintDismissed: true }).hint, null);
  });

  it("ready with another provider and no OpenCode account → no hint", () => {
    const v = deriveOnboarding(input({ account: { opencode: "none", otherProviders: true } }));
    assert.equal(v.hint, null);
  });

  it("ready but the OpenCode sign-in expired → renewal hint even when dismissed", () => {
    const v = deriveOnboarding(
      input({ account: { opencode: "needs-auth", otherProviders: false }, hintDismissed: true }),
    );
    assert.equal(v.stage, "ready");
    assert.equal(v.hint, "sign-in-expired");
  });

  it("F. no folder open → no-folder (never 'Connected')", () => {
    const v = deriveOnboarding(input({ hasFolder: false, catalogLoaded: false, models: null }));
    assert.equal(v.stage, "no-folder");
    assert.notEqual(statusBarText(v.stage), "OpenCode: Connected");
  });

  it("models that could not be loaded → catalog-error; before the first load → loading", () => {
    assert.equal(deriveOnboarding(input({ models: null })).stage, "catalog-error");
    assert.equal(deriveOnboarding(input({ catalogLoaded: false, models: null })).stage, "loading");
    assert.equal(statusBarText("loading"), "OpenCode Chat");
  });

  it("connecting and errors map to neutral / not-connected states", () => {
    assert.equal(deriveOnboarding(input({ connection: { kind: "connecting" } })).stage, "connecting");
    assert.equal(statusBarText("connecting"), "OpenCode Chat");
    assert.equal(statusBarText(null), "OpenCode Chat");
    const e = deriveOnboarding(input({ connection: { kind: "error", message: "boom" } }));
    assert.equal(e.stage, "error");
    assert.equal(statusBarText(e.stage), "OpenCode: Not connected");
  });

  it("carries the sign-in progress through every stage", () => {
    for (const signIn of ["idle", "waiting", "cancelled", "failed"] as const)
      assert.equal(deriveOnboarding(input({ models: [], signIn })).signIn, signIn);
  });

  it("links only to official OpenCode pages and the project's own README", () => {
    for (const [k, url] of Object.entries(OPENCODE_LINKS)) {
      const u = new URL(url);
      assert.equal(u.protocol, "https:", k);
      assert.ok(
        u.host === "opencode.ai" ||
          (u.host === "github.com" && u.pathname === "/globalwebsolutions/opencode-chat-sidebar"),
        `${k}: ${url}`,
      );
    }
  });
});

describe("onboarding: account detection is privacy-safe", () => {
  const LIST = [
    {
      id: "opencode",
      name: "OpenCode Console",
      methods: [{ id: "device", type: "oauth", label: "OpenCode Console account" }],
      connections: [{ type: "credential", id: "cred_1", label: "me@example.com", method: "oauth" }],
    },
    { id: "anthropic", name: "Anthropic", methods: [], connections: [] },
  ];

  it("reports only states: no labels, ids or methods leave the adapter", () => {
    const s = parseAccountStatus(LIST);
    assert.deepEqual(s, { opencode: "connected", otherProviders: false });
    const text = JSON.stringify(s);
    assert.ok(!text.includes("example.com") && !text.includes("cred_1"));
  });

  it("detects needs_auth, env connections and other providers", () => {
    assert.deepEqual(
      parseAccountStatus([
        {
          id: "opencode",
          connections: [
            { type: "credential", method: "oauth", status: { status: "needs_auth", message: "expired" } },
          ],
        },
        { id: "anthropic", connections: [{ type: "env", name: "ANTHROPIC_API_KEY" }] },
      ]),
      { opencode: "needs-auth", otherProviders: true },
    );
    assert.deepEqual(parseAccountStatus([]), { opencode: "none", otherProviders: false });
    assert.throws(() => parseAccountStatus({ nope: true }));
  });

  it("reads GET /api/integration for the workspace and never calls the credential API", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ location: {}, data: LIST }), { status: 200 });
    }) as typeof fetch;
    const c = new HttpOpenCodeClient({ url: "http://127.0.0.1:9" }, fetchImpl);
    assert.deepEqual(await c.accountStatus("/w"), { opencode: "connected", otherProviders: false });
    assert.equal(urls.length, 1);
    const u = new URL(urls[0]);
    assert.equal(u.pathname, "/api/integration");
    assert.equal(u.searchParams.get("location[directory]"), "/w");
    assert.ok(!urls.some((x) => x.includes("/api/credential")));
  });
});

describe("onboarding: catalog refresh (sign-in auto re-check)", () => {
  const silentLog = { info() {}, warn() {}, error() {} };
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
  function setup() {
    const client = new MockClient();
    const c = new SessionController(
      client,
      new MemoryStore(),
      { onEvents() {}, onTranscriptReset() {}, onStateChanged() {} },
      silentLog,
      () => ({ model: "", agent: "" }),
      { debounceMs: 1, stopCheckMs: 20, modelRetryMs: 1, catalogDebounceMs: 5 },
    );
    return { client, c };
  }

  it("loads the account status together with models and agents", async () => {
    const { c, client } = setup();
    client.account = { opencode: "none", otherProviders: false };
    await c.setDirectory("/w");
    assert.equal(c.catalogLoaded, true);
    assert.deepEqual(c.account, { opencode: "none", otherProviders: false });
  });

  it("an account check failure leaves the status unknown (null), not signed out", async () => {
    const { c, client } = setup();
    client.accountError = new Error("boom");
    await c.setDirectory("/w");
    assert.equal(c.account, null);
    assert.ok(c.models && c.models.length > 0);
  });

  it("integration / provider / model events trigger one debounced refresh", async () => {
    const { c, client } = setup();
    await c.setDirectory("/w");
    const before = client.callsTo("listModels").length;
    client.account = { opencode: "connected", otherProviders: false };
    for (const type of ["integration.updated", "provider.updated", "model.updated"])
      c.handleRawEvent({ id: "e", type, data: {} });
    await tick(40);
    assert.equal(client.callsTo("listModels").length, before + 1);
    assert.equal(c.account?.opencode, "connected");
    assert.equal(isCatalogEvent({ type: "session.created" }), false);
  });

  it("a refresh keeps the user's model, variant and agent selection", async () => {
    const { c } = setup();
    await c.setDirectory("/w");
    await c.selectModel("vast/qwen");
    await c.selectVariant("high");
    await c.selectAgent("plan");
    await c.refreshCatalog();
    assert.deepEqual([c.selectedModel, c.selectedVariant, c.selectedAgent], ["vast/qwen", "high", "plan"]);
  });

  it("frequent refreshes (events + sign-in poll) coalesce and always publish", async () => {
    const { c, client } = setup();
    client.models = [];
    client.account = { opencode: "none", otherProviders: false };
    await c.setDirectory("/w");
    const before = client.callsTo("listModels").length;
    client.account = { opencode: "needs-auth", otherProviders: false };
    const runs = [c.refreshCatalog(), c.refreshCatalog(), c.refreshCatalog(), c.refreshCatalog()];
    await Promise.all(runs);
    assert.equal(c.account?.opencode, "needs-auth", "the refreshed state was published");
    assert.ok(client.callsTo("listModels").length - before <= 2, "at most one run plus one coalesced re-run");
    assert.equal(c.catalogLoading, false);
  });

  it("models appearing after sign-in are picked up by a refresh", async () => {
    const { c, client } = setup();
    const all = client.models;
    client.models = [];
    client.account = { opencode: "none", otherProviders: false };
    await c.setDirectory("/w");
    assert.deepEqual(c.models, []);
    client.models = all;
    client.account = { opencode: "connected", otherProviders: false };
    await c.refreshCatalog();
    assert.equal(c.models?.length, 2);
    assert.ok(c.selectedModel);
  });
});

describe("onboarding: webview messages", () => {
  it("accepts the onboarding actions", () => {
    for (const type of ["signIn", "connectProvider", "refreshConnection", "openFolder", "dismissSignInHint"])
      assert.deepEqual(parseWebviewMessage({ type }), { type });
    assert.deepEqual(parseWebviewMessage({ type: "openOfficial", link: "install" }), {
      type: "openOfficial",
      link: "install",
    });
  });

  it("opens official pages by key only, never arbitrary URLs, and rejects credential fields", () => {
    assert.equal(parseWebviewMessage({ type: "openOfficial", link: "https://evil.example" }), undefined);
    assert.equal(parseWebviewMessage({ type: "openOfficial", link: "toString" }), undefined);
    assert.equal(parseWebviewMessage({ type: "signIn", password: "x" }), undefined);
    assert.equal(parseWebviewMessage({ type: "signIn", apiKey: "x" }), undefined);
  });
});
