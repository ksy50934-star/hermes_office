/**
 * Direct pixel verification of the four bibi-06 design findings.
 *
 * Screenshots alone would only show that something changed. These measurements
 * read what the browser actually computed — resolved colours, real box heights,
 * the `disabled` property as the DOM sees it, and the button's y-position before
 * and after a failure appears — so each finding is answered with a number that
 * can be checked rather than an image that has to be believed.
 *
 * Everything runs against a local stub. Every token below is synthetic and no
 * credential of any kind is read. The bundle under test is the real build.
 *
 * Usage: node design-response-capture.mjs <distDir> <outDir> <port>
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const [, , DIST, OUT, PORT_ARG] = process.argv;
const PORT = Number(PORT_ARG || 4601);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fakeJwt = (claims) => [
  b64url({ alg: "HS256", typ: "JWT" }),
  b64url(claims),
  "evidence-signature-not-verified-client-side",
].join(".");

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;
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

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp",
  ".webmanifest": "application/manifest+json", ".ico": "image/x-icon",
};

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => resolve(raw));
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, ORIGIN);
  const route = url.pathname;
  if (request.method === "OPTIONS") return json(response, 204, {});

  if (route === "/auth/v1/token") {
    const raw = await readBody(request);
    // One address is wired to fail, so the error state can be photographed and
    // measured without inventing a rejection client-side.
    if (raw.includes("reject-me@example.invalid")) {
      return json(response, 400, {
        error: "invalid_grant",
        error_description: "Invalid login credentials",
      });
    }
    return json(response, 200, {
      access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN,
      token_type: "bearer", expires_in: 3600, expires_at: FAR_FUTURE, user: FIXTURE_USER,
    });
  }
  if (route === "/auth/v1/user") { request.resume(); return json(response, 200, FIXTURE_USER); }
  if (route === "/auth/v1/logout") return json(response, 204, {});
  if (route.startsWith("/auth/v1/")) return json(response, 200, {});
  if (route.startsWith("/rest/v1/")) return json(response, 200, []);
  if (route.startsWith("/api/")) return json(response, 200, {});

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

// --- in-page measurement ---------------------------------------------------

/**
 * Resolved contrast ratio, computed the way a checker would: walk up for the
 * first non-transparent background, then apply WCAG relative luminance.
 * `opacity` on the text node is folded in, which is exactly why a hint that
 * relies on it cannot be reasoned about from the declaration alone.
 */
const MEASURE = () => {
  const parse = (value) => {
    const m = String(value).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(",").map((n) => Number(n.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const backdropOf = (el) => {
    let node = el;
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    const stack = [];
    while (node && node !== document.documentElement.parentNode) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) stack.push(bg);
      node = node.parentElement;
    }
    for (let i = stack.length - 1; i >= 0; i -= 1) acc = over(stack[i], acc);
    return acc;
  };
  const contrast = (el) => {
    if (!el) return null;
    const style = getComputedStyle(el);
    const fg = parse(style.color);
    if (!fg) return null;
    const effectiveAlpha = fg.a * Number(style.opacity || 1);
    const composited = over({ ...fg, a: effectiveAlpha }, backdropOf(el));
    const l1 = lum(composited);
    const l2 = lum(backdropOf(el));
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    return Math.round(ratio * 100) / 100;
  };
  const box = (el) => (el ? el.getBoundingClientRect() : null);

  const hint = document.querySelector(".bibi-field-hint");
  const abandon = document.querySelector(".bibi-abandon");
  const slot = document.querySelector(".bibi-error-slot");
  const lockedNav = [...document.querySelectorAll(".sidebar nav button.is-locked")];
  const lockedDock = [...document.querySelectorAll(".mobile-dock button.is-locked")];
  const shell = document.querySelector(".app-shell");

  return {
    fieldHint: hint ? {
      fontSizePx: parseFloat(getComputedStyle(hint).fontSize),
      opacity: Number(getComputedStyle(hint).opacity),
      color: getComputedStyle(hint).color,
      contrastRatio: contrast(hint),
    } : null,
    abandonButton: abandon ? {
      heightPx: Math.round(box(abandon).height * 100) / 100,
      widthPx: Math.round(box(abandon).width * 100) / 100,
      padding: getComputedStyle(abandon).padding,
      background: getComputedStyle(abandon).backgroundColor,
    } : null,
    errorSlot: slot ? {
      heightPx: Math.round(box(slot).height * 100) / 100,
      isEmpty: slot.children.length === 0,
    } : null,
    shellLocked: shell ? shell.classList.contains("is-auth-locked") : null,
    lockedNavCount: lockedNav.length,
    lockedNavAllDisabled: lockedNav.length > 0 && lockedNav.every((b) => b.disabled === true),
    lockedNavAllAriaDisabled: lockedNav.length > 0 && lockedNav.every((b) => b.getAttribute("aria-disabled") === "true"),
    lockedNavHaveTextMarker: lockedNav.length > 0 && lockedNav.every((b) => /잠김/.test(b.textContent)),
    lockedDockCount: lockedDock.length,
    lockedDockAllDisabled: lockedDock.length > 0 && lockedDock.every((b) => b.disabled === true),
    unlockedNavCount: document.querySelectorAll(".sidebar nav button:not(.is-locked)").length,
    statusText: document.querySelector(".sidebar-status strong")?.textContent ?? null,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  };
};

const ERROR_STYLE = () => {
  const el = document.querySelector(".bibi-error");
  if (!el) return null;
  const style = getComputedStyle(el);
  const marker = getComputedStyle(el, "::before");
  return {
    borderTopWidthPx: parseFloat(style.borderTopWidth),
    borderLeftWidthPx: parseFloat(style.borderLeftWidth),
    backgroundColor: style.backgroundColor,
    backgroundIsTransparent: /rgba\([^)]*,\s*0\)/.test(style.backgroundColor),
    paddingLeftPx: parseFloat(style.paddingLeft),
    markerContent: marker.content,
    text: el.textContent.trim().slice(0, 80),
  };
};

const VIEWPORTS = [
  { name: "360", width: 360, height: 780, mobile: true },
  { name: "390", width: 390, height: 844, mobile: true },
  { name: "1440", width: 1440, height: 900, mobile: false },
];

const INVITE = `#access_token=${ACCESS_TOKEN}&refresh_token=${REFRESH_TOKEN}`
  + "&expires_in=3600&token_type=bearer&type=invite";

const executablePath = process.env.BIBI_CHROMIUM_PATH || undefined;
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const results = [];

try {
  for (const viewport of VIEWPORTS) {
    for (const scene of [
      { name: "signin-locked-shell", path: "/", expect: "#bibi-signin-email" },
      { name: "password-setup", path: `/${INVITE}`, expect: "#bibi-new-password" },
    ]) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2, isMobile: viewport.mobile, hasTouch: viewport.mobile, locale: "ko-KR",
      });
      const page = await context.newPage();
      const consoleErrors = [];
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });

      const record = { scene: scene.name, viewport: viewport.name, found: false };
      try {
        await page.goto(`${ORIGIN}${scene.path}`, { waitUntil: "load", timeout: 30000 });
        await page.waitForSelector(scene.expect, { timeout: 15000 });
        record.found = true;
        record.measurements = await page.evaluate(MEASURE);

        // Layout shift: where is the submit button before and after a failure?
        if (scene.name === "signin-locked-shell") {
          const before = await page.evaluate(() =>
            Math.round(document.querySelector('.bibi-signin button[type="submit"]').getBoundingClientRect().top));
          await page.fill("#bibi-signin-email", "reject-me@example.invalid");
          await page.fill("#bibi-signin-password", "Fixture-Wrong-Passphrase-1");
          await page.click('.bibi-signin button[type="submit"]');
          await page.waitForSelector(".bibi-error", { timeout: 20000 });
          const after = await page.evaluate(() =>
            Math.round(document.querySelector('.bibi-signin button[type="submit"]').getBoundingClientRect().top));
          record.layoutShift = { submitTopBeforePx: before, submitTopAfterPx: after, shiftPx: after - before };
          record.errorStyle = await page.evaluate(ERROR_STYLE);
          await page.screenshot({
            path: path.join(OUT, `error-state-${viewport.name}.png`), fullPage: true,
          });
          record.errorScreenshot = `error-state-${viewport.name}.png`;
        }

        await page.screenshot({ path: path.join(OUT, `${scene.name}-${viewport.name}.png`), fullPage: true });
        record.screenshot = `${scene.name}-${viewport.name}.png`;
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

// --- findings verdicts -----------------------------------------------------

const hintChecks = results.filter((r) => r.measurements?.fieldHint).map((r) => r.measurements.fieldHint);
const abandonChecks = results.filter((r) => r.measurements?.abandonButton).map((r) => r.measurements.abandonButton);
const shiftChecks = results.filter((r) => r.layoutShift).map((r) => r.layoutShift);
const errorChecks = results.filter((r) => r.errorStyle).map((r) => r.errorStyle);
const lockChecks = results.filter((r) => r.scene === "signin-locked-shell").map((r) => r.measurements);

const findings = [
  {
    id: "F1", finding: "field hint: no opacity-only treatment, explicit high-contrast colour, min 0.8rem",
    measured: hintChecks,
    pass: hintChecks.length > 0
      && hintChecks.every((h) => h.opacity === 1 && h.fontSizePx >= 12.8 && h.contrastRatio >= 4.5),
    basis: "0.8rem = 12.8px at the default root size; 4.5:1 is the WCAG AA threshold for body text",
  },
  {
    id: "F2", finding: "abandon control: 44px minimum, visible focus ring, adequate padding, still secondary",
    measured: abandonChecks,
    pass: abandonChecks.length > 0 && abandonChecks.every((a) => a.heightPx >= 44),
    basis: "measured bounding box height at every viewport",
  },
  {
    id: "F3", finding: "error state: non-colour cue and reserved spacing",
    measured: { errorStyle: errorChecks, layoutShift: shiftChecks },
    pass: errorChecks.length > 0
      && errorChecks.every((e) => e.borderTopWidthPx > 0 && !e.backgroundIsTransparent && /!/.test(e.markerContent))
      && shiftChecks.length > 0 && shiftChecks.every((s) => s.shiftPx === 0),
    basis: "border + non-transparent background + ::before glyph; submit button y-position unchanged when the error appears",
  },
  {
    id: "F4", finding: "signed-out shell: pre-auth navigation unmistakably locked",
    measured: lockChecks,
    pass: lockChecks.length > 0 && lockChecks.every((m) =>
      m.shellLocked === true
      && m.lockedNavCount > 0 && m.lockedNavAllDisabled && m.lockedNavAllAriaDisabled && m.lockedNavHaveTextMarker
      && m.lockedDockCount > 0 && m.lockedDockAllDisabled
      && m.statusText === "로그인 필요"),
    basis: "DOM `disabled` property, aria-disabled, the 잠김 text marker, and the status pill wording",
  },
  {
    id: "F5", finding: "no horizontal overflow at any captured width",
    measured: results.filter((r) => r.measurements).map((r) => ({
      scene: r.scene, viewport: r.viewport,
      overflow: r.measurements.horizontalOverflow,
      doc: r.measurements.documentWidth, vp: r.measurements.viewportWidth,
    })),
    pass: results.filter((r) => r.measurements).every((r) => r.measurements.horizontalOverflow === false),
    basis: "documentElement.scrollWidth vs window.innerWidth",
  },
];

const report = {
  origin: ORIGIN,
  dist: DIST,
  viewports: VIEWPORTS.map((v) => v.width),
  scenes: results.length,
  all_scenes_found: results.every((r) => r.found),
  console_errors_total: results.reduce((n, r) => n + (r.consoleErrors?.length ?? 0), 0),
  findings,
  verdict: findings.every((f) => f.pass) ? "PASS" : "FAIL",
  failed: findings.filter((f) => !f.pass).map((f) => f.id),
  results,
};

process.stdout.write(JSON.stringify(report, null, 2));
if (report.verdict !== "PASS") process.exitCode = 1;
