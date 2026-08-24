/**
 * The same four design findings, measured against the deployed Production site.
 *
 * The local capture proves the build behaves; this proves the thing actually
 * serving users behaves. The password-setup screen is not reachable here — it
 * sits behind a redeemed invite, which ends in a human password this process
 * must never hold — so the hint measurement is taken from the local run and
 * only the surfaces reachable signed-out are measured here.
 *
 * The one credential submitted is a random string against an address at
 * .invalid, which cannot correspond to any account.
 *
 * Usage: node prod-design-readback.mjs <siteUrl> <outDir>
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";

const [, , SITE, OUT] = process.argv;

const VIEWPORTS = [
  { name: "360", width: 360, height: 780, mobile: true },
  { name: "390", width: 390, height: 844, mobile: true },
  { name: "1440", width: 1440, height: 900, mobile: false },
];

const MEASURE = () => {
  const box = (el) => (el ? el.getBoundingClientRect() : null);
  const lockedNav = [...document.querySelectorAll(".sidebar nav button.is-locked")];
  const lockedDock = [...document.querySelectorAll(".mobile-dock button.is-locked")];
  const shell = document.querySelector(".app-shell");
  const slot = document.querySelector(".bibi-error-slot");
  return {
    shellLocked: shell ? shell.classList.contains("is-auth-locked") : null,
    lockedNavCount: lockedNav.length,
    lockedNavAllDisabled: lockedNav.length > 0 && lockedNav.every((b) => b.disabled === true),
    lockedNavAllAriaDisabled: lockedNav.length > 0 && lockedNav.every((b) => b.getAttribute("aria-disabled") === "true"),
    lockedNavHaveTextMarker: lockedNav.length > 0 && lockedNav.every((b) => /잠김/.test(b.textContent)),
    lockedDockCount: lockedDock.length,
    lockedDockAllDisabled: lockedDock.length > 0 && lockedDock.every((b) => b.disabled === true),
    statusText: document.querySelector(".sidebar-status strong")?.textContent ?? null,
    errorSlotHeightPx: slot ? Math.round(box(slot).height * 100) / 100 : null,
    signUpControlPresent: /회원가입|가입하기|sign\s?up/i.test(document.body.innerText),
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
    backgroundIsTransparent: /rgba\([^)]*,\s*0\)/.test(style.backgroundColor),
    markerContent: marker.content,
    discloses: /없는 계정|가입되지|등록되지 않은|존재하지 않/.test(el.textContent),
    text: el.textContent.trim().slice(0, 80),
  };
};

const executablePath = process.env.BIBI_CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const results = [];

try {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2, isMobile: viewport.mobile, hasTouch: viewport.mobile, locale: "ko-KR",
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });

    const record = { viewport: viewport.name, width: viewport.width, found: false };
    try {
      await page.goto(`${SITE}/`, { waitUntil: "load", timeout: 45000 });
      await page.waitForSelector("#bibi-signin-email", { timeout: 20000 });
      record.found = true;
      record.measurements = await page.evaluate(MEASURE);
      await page.screenshot({ path: path.join(OUT, `prod-locked-shell-${viewport.name}.png`), fullPage: true });
      record.screenshot = `prod-locked-shell-${viewport.name}.png`;

      // A real rejection from the real auth server, then measure the shift.
      const before = await page.evaluate(() =>
        Math.round(document.querySelector('.bibi-signin button[type="submit"]').getBoundingClientRect().top));
      await page.fill("#bibi-signin-email", "no-such-account-probe@example.invalid");
      await page.fill("#bibi-signin-password", randomUUID());
      await page.click('.bibi-signin button[type="submit"]');
      await page.waitForSelector(".bibi-error", { timeout: 30000 });
      const after = await page.evaluate(() =>
        Math.round(document.querySelector('.bibi-signin button[type="submit"]').getBoundingClientRect().top));
      record.layoutShift = { submitTopBeforePx: before, submitTopAfterPx: after, shiftPx: after - before };
      record.errorStyle = await page.evaluate(ERROR_STYLE);
      await page.screenshot({ path: path.join(OUT, `prod-error-state-${viewport.name}.png`), fullPage: true });
      record.errorScreenshot = `prod-error-state-${viewport.name}.png`;
    } catch (thrown) {
      record.error = String(thrown.message ?? thrown).slice(0, 300);
    }
    record.consoleErrors = consoleErrors;
    results.push(record);
    await context.close();
  }
} finally {
  await browser.close();
}

const findings = [
  {
    id: "P1", finding: "signed-out shell is locked on Production",
    pass: results.every((r) => r.measurements?.shellLocked === true
      && r.measurements.lockedNavAllDisabled && r.measurements.lockedNavAllAriaDisabled
      && r.measurements.lockedNavHaveTextMarker && r.measurements.lockedDockAllDisabled
      && r.measurements.statusText === "로그인 필요"),
  },
  {
    id: "P2", finding: "error state carries a non-colour cue on Production",
    pass: results.every((r) => r.errorStyle
      && r.errorStyle.borderTopWidthPx > 0 && !r.errorStyle.backgroundIsTransparent
      && /!/.test(r.errorStyle.markerContent)),
  },
  {
    id: "P3", finding: "no layout shift when the real server rejects a sign-in",
    pass: results.every((r) => r.layoutShift?.shiftPx === 0),
  },
  {
    id: "P4", finding: "no account-existence disclosure and no sign-up control",
    pass: results.every((r) => r.errorStyle?.discloses === false
      && r.measurements?.signUpControlPresent === false),
  },
  {
    id: "P5", finding: "no horizontal overflow at 360/390/1440",
    pass: results.every((r) => r.measurements?.horizontalOverflow === false),
  },
];

const report = {
  site: SITE,
  viewports: VIEWPORTS.map((v) => v.width),
  all_found: results.every((r) => r.found),
  console_errors_total: results.reduce((n, r) => n + (r.consoleErrors?.length ?? 0), 0),
  findings,
  verdict: findings.every((f) => f.pass) ? "PASS" : "FAIL",
  failed: findings.filter((f) => !f.pass).map((f) => f.id),
  results,
};

process.stdout.write(JSON.stringify(report, null, 2));
if (report.verdict !== "PASS") process.exitCode = 1;
