/**
 * Real-browser readback of the deployed production site.
 *
 * Covers what production can honestly show without a human password: the
 * sign-in screen, a failed invite link, and the generic wording the real auth
 * server's rejection produces. The password-setup screen is not reachable here
 * — reaching it means redeeming a live invite, which ends in a password this
 * process must never hold — so it is evidenced against a local stub instead and
 * confirmed present in this same shipped bundle by string match.
 *
 * The one credential submitted below is a random string against an address at
 * .invalid, which cannot resolve to any account. Nothing real is attempted.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";

const [, , SITE, OUT] = process.argv;

const VIEWPORTS = [
  { name: "360", width: 360, height: 780, mobile: true },
  { name: "390", width: 390, height: 844, mobile: true },
  { name: "desktop", width: 1440, height: 900, mobile: false },
];

const EXPIRED = "#error=access_denied&error_code=otp_expired"
  + "&error_description=Email+link+is+invalid+or+has+expired";

const SCENES = [
  { name: "prod-signin", path: "/", expect: "#bibi-signin-email" },
  { name: "prod-invite-expired", path: `/${EXPIRED}`, expect: ".bibi-notice" },
];

const executablePath = process.env.BIBI_CHROMIUM_PATH || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const results = [];

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
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });

      const record = { scene: scene.name, viewport: viewport.name, width: viewport.width, found: false };
      try {
        await page.goto(`${SITE}${scene.path}`, { waitUntil: "load", timeout: 45000 });
        await page.waitForSelector(scene.expect, { timeout: 20000 });
        record.found = true;
        record.urlAfterLoad = page.url();
        record.authParamsRemaining = /access_token|refresh_token|token_hash|error_code/.test(page.url());
        record.overflow = await page.evaluate(() => ({
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        }));
        if (scene.name === "prod-invite-expired") {
          record.noticeText = (await page.textContent(".bibi-notice"))?.trim() ?? null;
        }
        record.hasSignUpControl = await page.evaluate(() =>
          /회원가입|가입하기|sign\s?up/i.test(document.body.innerText));

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

  // One rejected sign-in, to see the real server's failure become our wording.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "ko-KR" });
  const page = await context.newPage();
  const record = { scene: "prod-signin-rejected", viewport: "390", width: 390, found: false };
  try {
    await page.goto(`${SITE}/`, { waitUntil: "load", timeout: 45000 });
    await page.waitForSelector("#bibi-signin-email", { timeout: 20000 });
    await page.fill("#bibi-signin-email", "no-such-account-probe@example.invalid");
    await page.fill("#bibi-signin-password", randomUUID());
    await page.click('.bibi-signin button[type="submit"]');
    await page.waitForSelector('.bibi-error[role="alert"]', { timeout: 25000 });
    record.found = true;
    record.errorText = (await page.textContent('.bibi-error[role="alert"]'))?.trim() ?? null;
    // The wording must not reveal whether that address has an account.
    record.disclosesAccountExistence = /없는 계정|가입되지|등록되지 않은|존재하지 않/.test(record.errorText ?? "");
    await page.screenshot({ path: path.join(OUT, "prod-signin-rejected-390.png"), fullPage: true });
    record.screenshot = "prod-signin-rejected-390.png";
  } catch (thrown) {
    record.error = String(thrown.message ?? thrown).slice(0, 300);
  }
  results.push(record);
  await context.close();
} finally {
  await browser.close();
}

process.stdout.write(JSON.stringify({ site: SITE, results }, null, 2));
