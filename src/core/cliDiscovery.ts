// Locates the `opencode` executable without running it.

import * as path from "node:path";

export interface DiscoveryEnv {
  configuredPath: string;
  pathEnv: string;
  home: string;
  platform: NodeJS.Platform;
  /** Returns true when `file` exists, is a regular file and is executable. */
  isExecutable: (file: string) => boolean;
}

export type DiscoveryResult =
  | { found: true; path: string; source: "setting" | "PATH" | "known-location" }
  | { found: false; searched: string[]; configuredInvalid: boolean };

export function executableNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["opencode.exe", "opencode.cmd", "opencode"] : ["opencode"];
}

/** Path rules of the platform being searched, so results do not depend on the host running the code. */
function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

export function knownLocations(home: string, platform: NodeJS.Platform): string[] {
  const p = pathFor(platform);
  const names = executableNames(platform);
  const dirs =
    platform === "win32"
      ? [
          p.join(home, ".opencode", "bin"),
          p.join(home, "AppData", "Roaming", "npm"),
          p.join(home, ".bun", "bin"),
        ]
      : [
          p.join(home, ".opencode", "bin"),
          p.join(home, ".local", "bin"),
          p.join(home, ".bun", "bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
        ];
  return dirs.flatMap((d) => names.map((n) => p.join(d, n)));
}

function expandHome(file: string, home: string, p: path.PlatformPath): string {
  if (file === "~") return home;
  if (file.startsWith("~/") || file.startsWith("~\\")) return p.join(home, file.slice(2));
  return file;
}

export function discoverExecutable(env: DiscoveryEnv): DiscoveryResult {
  const p = pathFor(env.platform);
  const searched: string[] = [];
  const configured = env.configuredPath.trim();
  if (configured) {
    const candidate = expandHome(configured, env.home, p);
    searched.push(candidate);
    if (p.isAbsolute(candidate) && env.isExecutable(candidate)) {
      return { found: true, path: candidate, source: "setting" };
    }
    // An explicitly configured but invalid path is reported, not silently replaced.
    return { found: false, searched, configuredInvalid: true };
  }

  const sep = env.platform === "win32" ? ";" : ":";
  const names = executableNames(env.platform);
  for (const dir of env.pathEnv.split(sep).filter(Boolean)) {
    if (!p.isAbsolute(dir)) continue; // never resolve relative PATH entries
    for (const name of names) {
      const candidate = p.join(dir, name);
      searched.push(candidate);
      if (env.isExecutable(candidate)) return { found: true, path: candidate, source: "PATH" };
    }
  }

  for (const candidate of knownLocations(env.home, env.platform)) {
    if (searched.includes(candidate)) continue;
    searched.push(candidate);
    if (env.isExecutable(candidate)) return { found: true, path: candidate, source: "known-location" };
  }
  return { found: false, searched, configuredInvalid: false };
}
