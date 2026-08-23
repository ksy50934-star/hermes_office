import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CloudConfigError,
  assertClientSafeKey,
  describeKeyRole,
  resolveClientConfig,
} from "../src/cloud/env.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

const ANON_KEY = jwt({ iss: "supabase", ref: "example", role: "anon" });
const SERVICE_ROLE_KEY = jwt({ iss: "supabase", ref: "example", role: "service_role" });

const HEALTHY_ENV = Object.freeze({
  VITE_SUPABASE_URL: "https://example.supabase.co",
  VITE_SUPABASE_ANON_KEY: ANON_KEY,
});

// ---------------------------------------------------------------------------
// Key classification
// ---------------------------------------------------------------------------

test("a legacy anon JWT is recognised as client-safe", () => {
  assert.equal(describeKeyRole(ANON_KEY), "anon");
  assert.doesNotThrow(() => assertClientSafeKey(ANON_KEY));
});

test("a service-role JWT is refused even though it is structurally a valid key", () => {
  assert.equal(describeKeyRole(SERVICE_ROLE_KEY), "service_role");
  assert.throws(
    () => assertClientSafeKey(SERVICE_ROLE_KEY),
    (error) => error instanceof CloudConfigError && error.code === "SERVICE_ROLE_KEY_IN_CLIENT",
  );
});

test("the new publishable and secret key formats are classified correctly", () => {
  assert.equal(describeKeyRole("sb_publishable_abcdefghijklmnop"), "publishable");
  assert.doesNotThrow(() => assertClientSafeKey("sb_publishable_abcdefghijklmnop"));

  assert.equal(describeKeyRole("sb_secret_abcdefghijklmnop"), "secret");
  assert.throws(() => assertClientSafeKey("sb_secret_abcdefghijklmnop"), (error) => error.code === "SERVICE_ROLE_KEY_IN_CLIENT");
});

test("an unreadable key is refused rather than assumed safe", () => {
  for (const key of ["", "   ", "not-a-key", null, undefined, 12345]) {
    assert.equal(describeKeyRole(key), "unknown");
    assert.throws(() => assertClientSafeKey(key), (error) => error instanceof CloudConfigError, `${String(key)} must be refused`);
  }
});

test("a JWT whose payload is not decodable is unknown, not anon", () => {
  assert.equal(describeKeyRole("eyJhbGciOiJIUzI1NiJ9.@@@@.sig"), "unknown");
});

// ---------------------------------------------------------------------------
// Client configuration
// ---------------------------------------------------------------------------

test("a healthy environment resolves to a configured client", () => {
  const config = resolveClientConfig(HEALTHY_ENV);
  assert.equal(config.configured, true);
  assert.deepEqual(config.problems, []);
  assert.equal(config.url, "https://example.supabase.co");
  assert.equal(config.anonKey, ANON_KEY);
});

test("an unconfigured environment reports as unconfigured rather than throwing at import time", () => {
  const config = resolveClientConfig({});
  assert.equal(config.configured, false);
  assert.equal(config.anonKey, null);
  assert.ok(config.problems.length >= 1);
  assert.ok(config.problems.some((problem) => problem.code === "MISSING_SUPABASE_URL"));
  assert.ok(config.problems.some((problem) => problem.code === "MISSING_SUPABASE_ANON_KEY"));
});

test("a service-role key in the client environment is a fatal configuration problem", () => {
  const config = resolveClientConfig({ ...HEALTHY_ENV, VITE_SUPABASE_ANON_KEY: SERVICE_ROLE_KEY });
  assert.equal(config.configured, false);
  assert.equal(config.anonKey, null, "a privileged key must never be handed back for use");
  assert.ok(config.problems.some((problem) => problem.code === "SERVICE_ROLE_KEY_IN_CLIENT"));
});

test("any client-visible variable that names a privileged key is reported", () => {
  for (const key of ["VITE_SUPABASE_SERVICE_ROLE_KEY", "VITE_SERVICE_KEY", "VITE_SUPABASE_SECRET"]) {
    const config = resolveClientConfig({ ...HEALTHY_ENV, [key]: "anything" });
    assert.equal(config.configured, false, `${key} must be fatal`);
    assert.ok(config.problems.some((problem) => problem.code === "PRIVILEGED_KEY_EXPOSED"));
  }
});

test("a non-https Supabase URL is refused unless it is loopback", () => {
  assert.ok(resolveClientConfig({ ...HEALTHY_ENV, VITE_SUPABASE_URL: "http://example.supabase.co" })
    .problems.some((problem) => problem.code === "INSECURE_SUPABASE_URL"));
  assert.equal(resolveClientConfig({ ...HEALTHY_ENV, VITE_SUPABASE_URL: "http://127.0.0.1:54321" }).configured, true);
});

// ---------------------------------------------------------------------------
// The browser bundle must not be able to reach a privileged key at all
// ---------------------------------------------------------------------------

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(full));
    else found.push(full);
  }
  return found;
}

test("no browser source reads a service-role key or a server-only secret", async () => {
  const files = (await walk(path.join(projectRoot, "src"))).filter((file) => /\.(js|jsx)$/.test(file));
  assert.ok(files.length > 20, "expected the browser sources to be present");

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const relative = path.relative(projectRoot, file);
    // env.js names these patterns in order to reject them; every other module
    // must not mention them at all.
    if (relative === path.join("src", "cloud", "env.js")) continue;
    for (const pattern of [/SERVICE_ROLE_KEY/, /SUPABASE_SERVICE_ROLE/, /sb_secret_/]) {
      assert.doesNotMatch(source, pattern, `${relative} must not reference a privileged key (${pattern})`);
    }
  }
});

test("no browser source imports a server-only or connector-only module", async () => {
  const files = (await walk(path.join(projectRoot, "src"))).filter((file) => /\.(js|jsx)$/.test(file));
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const relative = path.relative(projectRoot, file);
    for (const pattern of [/from\s+["']\.\.\/api\//, /from\s+["']\.\.\/connector\//, /from\s+["']node:/]) {
      assert.doesNotMatch(source, pattern, `${relative} must not import server-only code (${pattern})`);
    }
  }
});

test("the built browser bundle contains no service-role key material", async () => {
  const assetsDir = path.join(projectRoot, "dist", "assets");
  const exists = await stat(assetsDir).then(() => true, () => false);
  assert.ok(exists, "run `npm run build` before this test; dist/assets must exist");

  const bundles = (await readdir(assetsDir)).filter((name) => name.endsWith(".js"));
  assert.ok(bundles.length > 0, "expected at least one built bundle");

  for (const name of bundles) {
    const source = await readFile(path.join(assetsDir, name), "utf8");

    // The word "service_role" legitimately appears in the bundle: it is the
    // value `env.js` compares against in order to *reject* a privileged key.
    // What must not appear is actual key material, so look for that instead.
    for (const [, payload] of source.matchAll(/\beyJ[A-Za-z0-9_-]{8,}\.([A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}\b/g)) {
      let claims;
      try {
        claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        continue;
      }
      assert.notEqual(claims?.role, "service_role", `${name} embeds a service-role JWT`);
      assert.notEqual(claims?.role, "secret", `${name} embeds a secret-role JWT`);
    }

    assert.doesNotMatch(source, /sb_secret_[A-Za-z0-9_-]{8,}/, `${name} must not embed a secret key`);
    // An inlined read of the server-only variable would leave its name behind.
    assert.ok(!source.includes("SUPABASE_SERVICE_ROLE_KEY"), `${name} must not reference the service-role variable`);
  }
});

test("the built bundle mentions a privileged role only as a value it rejects", async () => {
  const assetsDir = path.join(projectRoot, "dist", "assets");
  const bundles = (await readdir(assetsDir)).filter((name) => name.endsWith(".js"));

  for (const name of bundles) {
    const source = await readFile(path.join(assetsDir, name), "utf8");
    for (const match of source.matchAll(/service_role/g)) {
      const window = source.slice(Math.max(0, match.index - 80), match.index + 80);
      // Every occurrence must sit next to the rejection set, not next to a key.
      assert.match(
        window,
        /Set\(|secret|PRIVILEGED/,
        `${name} mentions service_role outside the key-rejection path: ${window}`,
      );
    }
  }
});

test("server-only modules are the only place a privileged key is read", async () => {
  const serverEnv = await readFile(path.join(projectRoot, "api", "_lib", "serverEnv.js"), "utf8");
  assert.match(serverEnv, /SUPABASE_SERVICE_ROLE_KEY/);
  // The server variable must not be exposed under the client-visible prefix.
  assert.doesNotMatch(serverEnv, /VITE_SUPABASE_SERVICE_ROLE_KEY/);
});
