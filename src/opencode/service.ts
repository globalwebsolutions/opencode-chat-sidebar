// Finds the OpenCode server to talk to.
//
// OpenCode 2.x runs a shared, local background service (`opencode service ...`).
// It registers itself in `$XDG_STATE_HOME/opencode/service.json` (default
// `~/.local/state/opencode/service.json`) with its loopback URL and a per-service
// password. The official CLI and `@opencode/client` discover it the same way:
// read that file, then probe `GET /api/info` with HTTP Basic auth
// (`opencode:<password>`) and check the reported pid.
//
// The password is held in memory only for the lifetime of the connection. It is
// never written to extension storage, settings or logs.

import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { Endpoint } from "./client";

export interface ServiceRegistration {
  url: string;
  password?: string;
  pid?: number;
  version?: string;
}

export type DiscoveryOutcome =
  | { ok: true; endpoint: Endpoint; version: string; source: "service" | "setting" }
  | {
      ok: false;
      reason: "not-registered" | "not-responding" | "unauthorized" | "invalid-setting";
      detail: string;
    };

export function serviceFilePath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const state =
    env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME
      : path.join(home, ".local", "state");
  return path.join(state, "opencode", "service.json");
}

export function parseRegistration(text: string | undefined): ServiceRegistration | undefined {
  if (!text) return undefined;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (typeof j.url !== "string") return undefined;
    return {
      url: j.url,
      password: typeof j.password === "string" ? j.password : undefined,
      pid: typeof j.pid === "number" ? j.pid : undefined,
      version: typeof j.version === "string" ? j.version : undefined,
    };
  } catch {
    return undefined;
  }
}

export function basicAuth(password: string): string {
  return "Basic " + Buffer.from("opencode:" + password).toString("base64");
}

export function isLoopbackUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export interface DiscoveryDeps {
  readFile: (file: string) => Promise<string | undefined>;
  fetch: typeof fetch;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

async function probe(
  endpoint: Endpoint,
  fetchImpl: typeof fetch,
  expectPid?: number,
): Promise<DiscoveryOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(new URL("/api/info", endpoint.url), {
      headers: endpoint.authorization ? { authorization: endpoint.authorization } : {},
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    return {
      ok: false,
      reason: "not-responding",
      detail: `No response from ${endpoint.url} (${e instanceof Error ? e.message : String(e)})`,
    };
  }
  if (res.status === 401)
    return { ok: false, reason: "unauthorized", detail: `${endpoint.url} rejected the credentials` };
  if (!res.ok)
    return { ok: false, reason: "not-responding", detail: `${endpoint.url} answered HTTP ${res.status}` };
  let info: Record<string, unknown>;
  try {
    info = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "not-responding", detail: `${endpoint.url} did not return server info` };
  }
  if (expectPid !== undefined && typeof info.pid === "number" && info.pid !== expectPid) {
    return {
      ok: false,
      reason: "not-responding",
      detail: "A different process answered on the registered port",
    };
  }
  return {
    ok: true,
    endpoint,
    version: typeof info.version === "string" ? info.version : "unknown",
    source: "service",
  };
}

export async function discoverServer(
  settings: { serverUrl: string; allowRemote: boolean },
  deps: DiscoveryDeps,
): Promise<DiscoveryOutcome> {
  const registration = parseRegistration(await deps.readFile(serviceFilePath(deps.env, deps.home)));
  const configured = settings.serverUrl.trim();

  if (configured) {
    if (!/^https?:\/\//i.test(configured)) {
      return {
        ok: false,
        reason: "invalid-setting",
        detail: "opencodeSidebar.serverUrl must start with http:// or https://",
      };
    }
    if (!isLoopbackUrl(configured) && !settings.allowRemote) {
      return {
        ok: false,
        reason: "invalid-setting",
        detail:
          "opencodeSidebar.serverUrl is not a loopback address. Enable opencodeSidebar.allowRemoteServer to use it.",
      };
    }
    let authorization: string | undefined;
    if (registration?.password && sameOrigin(registration.url, configured))
      authorization = basicAuth(registration.password);
    else if (deps.env?.OPENCODE_SERVER_PASSWORD) authorization = basicAuth(deps.env.OPENCODE_SERVER_PASSWORD);
    const outcome = await probe({ url: configured, authorization }, deps.fetch);
    return outcome.ok ? { ...outcome, source: "setting" } : outcome;
  }

  if (!registration) {
    return {
      ok: false,
      reason: "not-registered",
      detail: "No OpenCode background service is registered on this machine",
    };
  }
  if (!isLoopbackUrl(registration.url)) {
    return {
      ok: false,
      reason: "invalid-setting",
      detail: "The registered OpenCode service is not on a loopback address; refusing to connect",
    };
  }
  const authorization = registration.password ? basicAuth(registration.password) : undefined;
  return probe({ url: registration.url, authorization }, deps.fetch, registration.pid);
}

/**
 * Starts the shared background service with the documented CLI command
 * (`opencode service start`). OpenCode itself guarantees a single service per
 * user and binds it to 127.0.0.1.
 */
export function startService(
  executable: string,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      executable,
      ["service", "start"],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        resolve({ ok: !error, output: error ? `${error.message}\n${output}`.trim() : output });
      },
    );
  });
}
