import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpOpenCodeClient, OpenCodeHttpError, toModelOption } from "../src/opencode/client";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(routes: Record<string, (req: Captured) => Response>) {
  const captured: Captured[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const req: Captured = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    captured.push(req);
    const path = new URL(url).pathname;
    const key = `${req.method} ${path}`;
    const handler = routes[key];
    if (!handler)
      return new Response(JSON.stringify({ _tag: "NotFound", message: "no route " + key }), { status: 404 });
    return handler(req);
  }) as typeof fetch;
  return { fn, captured };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const AUTH = "Basic b3BlbmNvZGU6eA==";

describe("HTTP OpenCode client", () => {
  it("sends basic auth and scopes catalog requests to the workspace location", async () => {
    const { fn, captured } = mockFetch({
      "GET /api/model": () =>
        json({
          location: { directory: "/r" },
          data: [
            {
              id: "kimi",
              providerID: "go",
              name: "Kimi",
              enabled: true,
              limit: { context: 1000, output: 10 },
              headers: { authorization: "secret" },
            },
            { id: "off", providerID: "go", name: "Off", enabled: false, limit: { context: 1, output: 1 } },
          ],
        }),
      "GET /api/provider": () => json({ data: [{ id: "go", name: "OpenCode Go" }] }),
    });
    const c = new HttpOpenCodeClient({ url: "http://127.0.0.1:9", authorization: AUTH }, fn);
    const models = await c.listModels("/r/my repo");
    assert.deepEqual(models, [
      {
        key: "go/kimi",
        providerID: "go",
        id: "kimi",
        name: "Kimi",
        providerName: "OpenCode Go",
        contextLimit: 1000,
        variants: [],
      },
    ]);
    assert.equal(captured[0].headers.authorization, AUTH);
    assert.equal(new URL(captured[0].url).searchParams.get("location[directory]"), "/r/my repo");
  });

  it("never exposes model headers or request bodies", () => {
    const m = toModelOption(
      {
        id: "a",
        providerID: "p",
        name: "A",
        enabled: true,
        limit: { context: 5 },
        headers: { "x-api-key": "k" },
        body: { k: 1 },
      },
      new Map(),
    );
    assert.deepEqual(Object.keys(m ?? {}).sort(), [
      "contextLimit",
      "id",
      "key",
      "name",
      "providerID",
      "providerName",
      "variants",
    ]);
  });

  it("lists only primary, visible agents", async () => {
    const { fn } = mockFetch({
      "GET /api/agent": () =>
        json({
          data: [
            { id: "build", name: "Build", mode: "primary", hidden: false },
            { id: "explore", name: "Explore", mode: "subagent", hidden: false },
            { id: "title", name: "Title", mode: "primary", hidden: true },
            { id: "plan", name: "Plan", mode: "all", hidden: false },
          ],
        }),
    });
    const agents = await new HttpOpenCodeClient({ url: "http://127.0.0.1:9" }, fn).listAgents("/r");
    assert.deepEqual(
      agents.map((a) => a.id),
      ["build", "plan"],
    );
  });

  it("lists root sessions for the workspace directory, newest first", async () => {
    const { fn, captured } = mockFetch({
      "GET /api/session": () =>
        json({
          data: [
            {
              id: "ses_1",
              title: "T",
              agent: "build",
              model: { providerID: "p", id: "m" },
              time: { created: 1, updated: 2 },
              cost: 0.1,
              tokens: {},
              projectID: "x",
              location: { directory: "/r" },
            },
          ],
          cursor: {},
        }),
    });
    const s = await new HttpOpenCodeClient({ url: "http://127.0.0.1:9" }, fn).listSessions("/r", 20);
    assert.deepEqual(s, [
      {
        id: "ses_1",
        title: "T",
        created: 1,
        updated: 2,
        agent: "build",
        modelKey: "p/m",
        outcome: null,
        variant: null,
        cost: 0.1,
      },
    ]);
    const q = new URL(captured[0].url).searchParams;
    assert.equal(q.get("directory"), "/r");
    assert.equal(q.get("parentID"), "null");
    assert.equal(q.get("order"), "desc");
  });

  it("creates sessions, prompts, switches, interrupts and replies with the documented bodies", async () => {
    const { fn, captured } = mockFetch({
      "POST /api/session": () => json({ data: { id: "ses_1", time: { created: 1, updated: 1 } } }),
      "POST /api/session/ses_1/prompt": () => json({ data: { id: "msg_1" } }),
      "POST /api/session/ses_1/model": () => new Response(null, { status: 204 }),
      "POST /api/session/ses_1/agent": () => new Response(null, { status: 204 }),
      "POST /api/session/ses_1/interrupt": () => json({ interrupted: true }),
      "POST /api/session/ses_1/permission/per_1/reply": () => new Response(null, { status: 204 }),
    });
    const c = new HttpOpenCodeClient({ url: "http://127.0.0.1:9" }, fn);
    await c.createSession({ directory: "/r", agent: "build", model: { providerID: "p", id: "m" } });
    assert.deepEqual(captured[0].body, {
      location: { directory: "/r" },
      agent: "build",
      model: { providerID: "p", id: "m" },
    });
    assert.deepEqual(await c.prompt("ses_1", { text: "hi", files: [] }), { id: "msg_1" });
    assert.deepEqual(captured[1].body, { text: "hi" });
    await c.prompt("ses_1", { text: "hi", files: [{ uri: "file:///r/a", name: "a" }] });
    assert.deepEqual(captured[2].body, { text: "hi", files: [{ uri: "file:///r/a", name: "a" }] });
    await c.switchModel("ses_1", { providerID: "p", id: "m2" });
    assert.deepEqual(captured[3].body, { model: { providerID: "p", id: "m2" } });
    await c.switchAgent("ses_1", "plan");
    assert.deepEqual(captured[4].body, { agent: "plan" });
    assert.equal(await c.interrupt("ses_1"), true);
    assert.equal(captured[5].method, "POST");
    await c.replyPermission("ses_1", "per_1", "always");
    assert.deepEqual(captured[6].body, { decision: "always" });
  });

  it("maps HTTP errors to OpenCodeHttpError with status and tag", async () => {
    const { fn } = mockFetch({
      "GET /api/session/ses_x": () => json({ _tag: "SessionNotFound", message: "Session not found" }, 404),
    });
    const c = new HttpOpenCodeClient({ url: "http://127.0.0.1:9" }, fn);
    await assert.rejects(
      c.getSession("ses_x"),
      (e: unknown) => e instanceof OpenCodeHttpError && e.status === 404 && e.tag === "SessionNotFound",
    );
  });

  it("pages message history from newest and returns it oldest-first", async () => {
    let call = 0;
    const { fn, captured } = mockFetch({
      "GET /api/session/ses_1/message": (req) => {
        call++;
        const q = new URL(req.url).searchParams;
        // OpenCode rejects order + cursor together (InvalidCursorError).
        if (q.get("cursor") && q.get("order"))
          return json({ _tag: "InvalidCursorError", message: "Cursor cannot be combined with order" }, 400);
        return call === 1
          ? json({ data: [{ id: "m3" }, { id: "m2" }], cursor: { next: "c1" } })
          : json({ data: [{ id: "m1" }], cursor: { next: null } });
      },
    });
    const msgs = await new HttpOpenCodeClient({ url: "http://127.0.0.1:9" }, fn).listMessages("ses_1", 2);
    assert.equal(captured.length, 1, "stops when the limit is reached");
    assert.deepEqual(
      msgs.map((m) => (m as { id: string }).id),
      ["m2", "m3"],
    );
    call = 0;
    const all = await new HttpOpenCodeClient({ url: "http://127.0.0.1:9" }, fn).listMessages("ses_1", 3);
    assert.deepEqual(
      all.map((m) => (m as { id: string }).id),
      ["m1", "m2", "m3"],
    );
    const second = new URL(captured[2].url).searchParams;
    assert.equal(second.get("cursor"), "c1");
    assert.equal(second.get("order"), null);
    call = 0;
    const rest = await new HttpOpenCodeClient({ url: "http://127.0.0.1:9" }, fn).listMessages("ses_1", 10);
    assert.deepEqual(
      rest.map((m) => (m as { id: string }).id),
      ["m1", "m2", "m3"],
    );
  });

  it("subscribes to the event stream, parses frames and reconnects after a drop", async () => {
    let connections = 0;
    const encoder = new TextEncoder();
    const { fn } = mockFetch({
      "GET /api/event": () => {
        connections++;
        const body = new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(encoder.encode('data: {"type":"server.connected","data":{}}\n\n: heartbeat\n\n'));
            ctrl.enqueue(
              encoder.encode(
                `data: {"type":"session.text.delta","data":{"n":${connections}}}\n\ndata: not-json\n\n`,
              ),
            );
            ctrl.close();
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const c = new HttpOpenCodeClient({ url: "http://127.0.0.1:9" }, fn, [5]);
    const events: unknown[] = [];
    let opens = 0;
    let closes = 0;
    const sub = c.subscribe({
      onEvent: (e) => events.push(e),
      onOpen: () => opens++,
      onClose: () => closes++,
    });
    await new Promise((r) => setTimeout(r, 60));
    sub.dispose();
    assert.ok(connections >= 2, "reconnected");
    assert.ok(opens >= 2 && closes >= 1);
    assert.deepEqual(events.slice(0, 2), [
      { type: "server.connected", data: {} },
      { type: "session.text.delta", data: { n: 1 } },
    ]);
  });
});
