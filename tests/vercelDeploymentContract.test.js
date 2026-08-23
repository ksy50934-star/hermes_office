import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const read = (relative) => readFile(path.join(projectRoot, relative), "utf8");

/** Variables the browser needs. None of them may be privileged. */
const REQUIRED_CLIENT_KEYS = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];
/** Variables only the serverless functions read. */
const REQUIRED_SERVER_KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
/** Variables the local Mac connector reads. */
const REQUIRED_CONNECTOR_KEYS = [
  "BIBI_CONNECTOR_MODE",
  "BIBI_CONTROL_PLANE_URL",
  "BIBI_CONNECTOR_TOKEN",
  "BIBI_HERMES_BIN",
  "BIBI_HERMES_DEFAULT_HOME",
  "BIBI_HERMES_PROFILES_ROOT",
  "BIBI_HERMES_MAX_TURNS",
  "BIBI_HERMES_TIMEOUT_MS",
];

test("vercel.json builds the Vite app and serves the API from the same project", async () => {
  const config = JSON.parse(await read("vercel.json"));
  assert.equal(config.framework, "vite");
  assert.equal(config.outputDirectory, "dist");
  assert.match(config.buildCommand, /vite build|npm run build/);
});

test("the SPA rewrite does not swallow API routes", async () => {
  const config = JSON.parse(await read("vercel.json"));
  const rewrites = config.rewrites ?? [];
  assert.ok(rewrites.length > 0, "an SPA needs a fallback rewrite");

  const fallback = rewrites.find((rewrite) => rewrite.destination === "/index.html");
  assert.ok(fallback, "a fallback to index.html must exist");
  // A bare "/(.*)" fallback would capture /api/* and break every function.
  assert.doesNotMatch(fallback.source, /^\/\(\.\*\)$/, "the fallback must exclude /api");
  assert.match(fallback.source, /api/, "the fallback pattern must mention api in its exclusion");
});

test("the API responses are never cached at the edge", async () => {
  const config = JSON.parse(await read("vercel.json"));
  const headers = config.headers ?? [];
  const apiHeaders = headers.find((entry) => entry.source.includes("api"));
  assert.ok(apiHeaders, "API routes need an explicit cache header rule");
  const cacheControl = apiHeaders.headers.find((header) => header.key.toLowerCase() === "cache-control");
  assert.ok(cacheControl, "API routes need Cache-Control");
  assert.match(cacheControl.value, /no-store/);
});

test("the environment example documents every variable the workspace needs", async () => {
  const example = await read(".env.cloud.example");
  for (const key of [...REQUIRED_CLIENT_KEYS, ...REQUIRED_SERVER_KEYS, ...REQUIRED_CONNECTOR_KEYS]) {
    assert.match(example, new RegExp(`^${key}=`, "m"), `${key} must be documented`);
  }
});

test("the environment example never exposes a privileged key to the browser", async () => {
  const example = await read(".env.cloud.example");
  for (const line of example.split("\n")) {
    const name = line.split("=")[0].trim();
    if (!name.startsWith("VITE_")) continue;
    assert.doesNotMatch(name, /(SERVICE_ROLE|SERVICE_KEY|SECRET)/i, `${name} would ship in the browser bundle`);
  }
  assert.doesNotMatch(example, /^VITE_SUPABASE_SERVICE_ROLE_KEY=/m);
});

test("the environment example ships no real secret values", async () => {
  const example = await read(".env.cloud.example");
  for (const key of ["SUPABASE_SERVICE_ROLE_KEY", "BIBI_CONNECTOR_TOKEN", "VITE_SUPABASE_ANON_KEY"]) {
    const match = example.match(new RegExp(`^${key}=(.*)$`, "m"));
    assert.ok(match, `${key} must be present`);
    const value = match[1].trim();
    assert.ok(
      value === "" || /^(CHANGE_ME|<|REPLACE)/i.test(value),
      `${key} must be a placeholder, found: ${value.slice(0, 24)}`,
    );
  }
});

test("the connector defaults in the example describe the outbound-only local topology", async () => {
  const example = await read(".env.cloud.example");
  assert.match(example, /^BIBI_CONNECTOR_MODE=outbound-local-mac$/m);
  // Both of these must default to the safe value.
  assert.match(example, /^BIBI_CONNECTOR_INBOUND_PORT=$/m);
  assert.match(example, /^BIBI_CONNECTOR_ALLOW_LOCAL_EXECUTION=false$/m);
});

test("the obsolete HTTP execution settings are gone from every environment document", async () => {
  for (const file of [".env.cloud.example", "vercel.json"]) {
    const contents = await read(file);
    assert.doesNotMatch(contents, /HERMES_LOCAL_URL/, `${file} still names HERMES_LOCAL_URL`);
    assert.doesNotMatch(contents, /BIBI_HERMES_EXECUTION_ENDPOINT/, `${file} still names the endpoint`);
  }
});

test("the example documents the verified Hermes CLI contract", async () => {
  const example = await read(".env.cloud.example");
  // The exact invocation and the fact that HERMES_HOME is the only selector.
  assert.match(example, /hermes chat -q .*-Q --source tool --max-turns/);
  assert.match(example, /HERMES_HOME/);
  assert.match(example, /^BIBI_HERMES_DEFAULT_HOME=/m);
  assert.match(example, /^BIBI_HERMES_PROFILES_ROOT=/m);
});

test("the filled-in cloud environment file is never committed", async () => {
  const gitignore = await read(".gitignore");
  assert.match(gitignore, /^\.env\.cloud$/m);
});

test("the environment example itself stays committable", async () => {
  // A broad `.env*` rule would otherwise swallow the contract document, and the
  // negation has to come after it to take effect.
  const gitignore = await read(".gitignore");
  assert.match(gitignore, /^!\.env\.cloud\.example$/m);
  assert.match(gitignore, /^!\.env\.example$/m);

  const broadRule = gitignore.split("\n").findIndex((line) => line.trim() === ".env*");
  const negation = gitignore.split("\n").findIndex((line) => line.trim() === "!.env.cloud.example");
  assert.ok(broadRule !== -1 && negation > broadRule, "the negation must follow the broad rule");
});

test("every connector endpoint the connector calls exists as a function", async () => {
  const transport = await read("connector/outboundTransport.js");
  const routes = [...transport.matchAll(/request\("(\/api\/[^"]+)"/g)].map((match) => match[1]);
  assert.ok(routes.length >= 4, `expected the connector routes, found ${routes.join(", ")}`);

  for (const route of routes) {
    const file = `${route.replace(/^\/api\//, "api/")}.js`;
    await assert.doesNotReject(read(file), `${route} must be implemented at ${file}`);
  }
});
