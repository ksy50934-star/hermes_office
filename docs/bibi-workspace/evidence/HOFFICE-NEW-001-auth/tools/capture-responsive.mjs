/**
 * Real-browser responsive evidence for the invite-acceptance flow.
 *
 * The three screens that matter here — sign in, redeem an invite, choose a
 * password — cannot all be reached against production, because reaching the
 * third requires accepting a live invite, and accepting a live invite requires
 * a human password this process is forbidden to have. So the two screens behind
 * an authenticated session are driven against a local stub instead.
 *
 * Everything the stub hands out is synthetic: the anon key is a JWT this script
 * mints, the access token is a JWT this script mints, and the user it returns is
 * a fixture. No real credential is read, written, or needed. What the browser
 * renders is nonetheless the real built bundle, at real viewport widths.
 *
 * Usage: node capture-responsive.mjs <distDir> <outDir> <port>
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const [, , DIST, OUT, PORT_ARG] = process.argv;
const PORT = Number(PORT_ARG || 4599);
const ORIGIN = `http://127.0.0.1:${PORT}`;

// --- synthetic tokens ------------------------------------------------------

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function fakeJwt(claims) {
  return [
    b64url({ alg: "HS256", typ: "JWT" }),
    b64url(claims),
    "evidence-signature-not-verified-client-side",
  ].join(".");
}

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;
const ANON_KEY = fakeJwt({ role: "anon", iss: "bibi-local-evidence", exp: FAR_FUTURE });
const ACCESS_TOKEN = fakeJwt({
  role: "authenticated",
  sub: "00000000-0000-4000-8000-000000000001",
  email: "invited-fixture@example.invalid",
  exp: FAR_FUTURE,
});
const REFRESH_TOKEN = "evidence-refresh-token-fixture";

const FIXTURE_USER = {
  id: "00000000-0000-4000-8000-000000000001",
  aud: "authenticated",
  role: "authenticated",
  email: "invited-fixture@example.invalid",
  email_confirmed_at: new Date(0).toISOString(),
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
  app_metadata: { provider: "email" },
  user_metadata: {},
};

// --- static + GoTrue stub --------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
};

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
  });
  response.end(text);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, ORIGIN);
  const route = url.pathname;

  if (request.method === "OPTIONS") return json(response, 204, {});

  // GoTrue surface, only the calls this flow makes.
  if (route === "/auth/v1/user") {
    if (request.method === "PUT") {
      // A password update. The body is read and discarded without inspection —
      // this stub has no interest in the value and never records it.
      request.resume();
      return json(response, 200, FIXTURE_USER);
    }
    return json(response, 200, FIXTURE_USER);
  }
  if (route === "/auth/v1/token") {
    return json(response, 200, {
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: FAR_FUTURE,
      user: FIXTURE_USER,
    });
  }
  if (route === "/auth/v1/logout") return json(response, 204, {});
  if (route.startsWith("/auth/v1/")) return json(response, 200, {});
  if (route.startsWith("/rest/v1/")) return json(response, 200, []);
  if (route.startsWith("/api/")) return json(response, 200, {});

  // Static bundle, with SPA fallback.
  let filePath = path.join(DIST, route === "/" ? "index.html" : route.replace(/^\/+/, ""));
  if (!existsSync(filePath) || filePath.endsWith(path.sep)) filePath = path.join(DIST, "index.html");
  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
});

// --- capture ---------------------------------------------------------------

const VIEWPORTS = [
  { name: "360", width: 360, height: 780, mobile: true },
  { name: "390", width: 390, height: 844, mobile: true },
  { name: "desktop", width: 1440, height: 900, mobile: false },
];

const INVITE_FRAGMENT =
  `#access_token=${ACCESS_TOKEN}&refresh_token=${REFRESH_TOKEN}`
  + "&expires_in=3600&token_type=bearer&type=invite";

const EXPIRED_FRAGMENT =
  "#error=access_denied&error_code=otp_expired"
  + "&error_description=Email+link+is+invalid+or+has+expired";

const SCENES = [
  { name: "signin", path: "/", expect: "#bibi-signin-email" },
  { name: "invite-password-setup", path: `/${INVITE_FRAGMENT}`, expect: "#bibi-new-password" },
  { name: "invite-expired", path: `/${EXPIRED_FRAGMENT}`, expect: ".bibi-notice" },
];

const results = [];

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

// playwright-core pins a browser revision; this machine has a newer one from a
// different install. Reusing it beats downloading a second copy, and the page
// being screenshotted is the same either way.
const executablePath = process.env.BIBI_CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  for (const viewport of VIEWPORTS) {
    for (const scene of SCENES) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        isMobile: viewport.mobile,
        hasTouch: viewport.mobile,
        locale: "ko-KR",
      });
      const page = await context.newPage();
      const consoleErrors = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text().slice(0, 200));
      });

      const record = {
        scene: scene.name,
        viewport: viewport.name,
        width: viewport.width,
        selector: scene.expect,
        found: false,
        overflow: null,
        urlAfterLoad: null,
        tokenInUrl: null,
        screenshot: null,
        consoleErrors: [],
        error: null,
      };

      try {
        await page.goto(`${ORIGIN}${scene.path}`, { waitUntil: "load", timeout: 30000 });
        await page.waitForSelector(scene.expect, { timeout: 15000 });
        record.found = true;

        // The address bar must no longer hold the token the link arrived with.
        record.urlAfterLoad = page.url();
        record.tokenInUrl = record.urlAfterLoad.includes(ACCESS_TOKEN)
          || record.urlAfterLoad.includes("access_token")
          || record.urlAfterLoad.includes("error_code");

        // Nothing may spill sideways out of the viewport.
        record.overflow = await page.evaluate(() => ({
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        }));

        const file = path.join(OUT, `${scene.name}-${viewport.name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        record.screenshot = path.basename(file);
      } catch (thrown) {
        record.error = String(thrown.message ?? thrown).slice(0, 300);
      }

      record.consoleErrors = consoleErrors;
      results.push(record);
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

process.stdout.write(JSON.stringify({ origin: ORIGIN, dist: DIST, results }, null, 2));
