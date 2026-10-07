import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyPath, findSensitive } from "../src/core/sensitive";

describe("sensitive path detection", () => {
  for (const p of [
    ".env",
    "backend/.env",
    ".env.staging",
    ".env.production.local",
    "/Users/me/.ssh/config",
    "~/.ssh/id_ed25519",
    "id_rsa",
    "certs/server.key",
    "tls/private.pem",
    "android/app/release.keystore",
    "upload.jks",
    "cert.p12",
    "/home/u/.aws/credentials",
    "/home/u/.kube/config",
    "/home/u/.docker/config.json",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    "gcp/service-account-prod.json",
    "secrets.yaml",
    "/home/u/.gnupg/private-keys-v1.d/x",
  ]) {
    it(`flags ${p}`, () => assert.ok(classifyPath(p), p));
  }

  for (const p of [
    ".env.example",
    ".env.staging.example",
    ".env.sample",
    "src/env.ts",
    "README.md",
    "app/Http/Kernel.php",
    "keys.ts",
    "*",
  ]) {
    it(`does not flag ${p}`, () => assert.equal(classifyPath(p), undefined, p));
  }

  it("scans shell commands token by token", () => {
    const m = findSensitive(["cat backend/.env | grep DB_"]);
    assert.deepEqual(
      m.map((x) => x.value),
      ["backend/.env"],
    );
  });

  it("deduplicates matches across resources", () => {
    assert.equal(findSensitive([".env", ".env"]).length, 1);
  });

  it("strips quotes around tokens", () => {
    assert.equal(findSensitive(["cat '.env'"])[0]?.value, ".env");
  });
});
