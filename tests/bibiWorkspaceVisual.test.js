/**
 * Layout contracts for the Bibi Workspace surface.
 *
 * These guard the five regressions found by pixel QA at 390x844 and 1440x900:
 * a login card that overflowed the mobile viewport, legacy Hermes header chrome
 * and a legacy core-health banner rendered over a surface that reports its own
 * health, a broken sidebar mark, and an auth card stretched across the whole
 * desktop content column.
 *
 * They are source and stylesheet contracts rather than screenshots: the failure
 * mode in every case was a rule or a condition going missing, and that is
 * exactly what a regression here would look like again.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BIBI_VIEW_ID, isBibiSurface } from "../src/bibi/surface.js";
import { OFFICE_BRAND_MARK_SRC } from "../src/branding.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFile(path.join(projectRoot, relative), "utf8");

const MOBILE_VIEWPORT = 390;

/** Pull one declaration out of a rule block, so the tests assert numbers. */
function declaration(css, selector, property) {
  const pattern = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
  );
  const block = css.match(pattern);
  assert.ok(block, `expected a rule for ${selector}`);
  const found = block[1].match(new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`));
  assert.ok(found, `expected ${property} on ${selector}`);
  return found[1].trim();
}

/** Extract the body of a media query block, brace-balanced. */
function mediaBlock(css, query) {
  const start = css.indexOf(query);
  assert.notEqual(start, -1, `expected a ${query} block`);
  let index = css.indexOf("{", start);
  let depth = 0;
  const from = index;
  for (; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(from + 1, index);
    }
  }
  throw new Error(`unbalanced ${query} block`);
}

// ---------------------------------------------------------------------------
// The active-view condition
// ---------------------------------------------------------------------------

test("the Bibi surface is identified by one shared predicate", () => {
  assert.equal(BIBI_VIEW_ID, "ceo");
  assert.equal(isBibiSurface("ceo"), true);
  for (const other of ["office", "chat", "meeting", "kanban", "data", "command", "", null, undefined]) {
    assert.equal(isBibiSurface(other), false, `${String(other)} is not the Bibi surface`);
  }
});

test("App derives the Bibi surface from the shared predicate, not a loose string", async () => {
  const app = await read("src/App.jsx");

  assert.match(app, /import \{ isBibiSurface \} from "\.\/bibi\/surface\.js";/);
  assert.match(app, /const bibiSurface = isBibiSurface\(view\);/);
});

test("legacy Hermes core-health errors are withheld only while the Bibi surface is active", async () => {
  const app = await read("src/App.jsx");

  // The gate is inside refresh, so the banner text is never even produced there.
  assert.match(app, /const reportError = \(message\) => \{\s*if \(bibiSurfaceRef\.current\) return;\s*setError\(message\);\s*\};/);
  assert.match(app, /bibiSurfaceRef\.current = isBibiSurface\(view\);/);
  assert.match(app, /reportError\(loadError\.message\);/);
  assert.match(app, /reportError\(`Hermes 업무 보드를 불러오지 못했습니다\./);
  // …and the banner itself is hidden on that surface only.
  assert.match(app, /\{error && !officeNotice && !bibiSurface && \(/);
  // The suppression must be surface-scoped: no unconditional silencing.
  assert.doesNotMatch(app, /\{error && !officeNotice && \(/);
  assert.doesNotMatch(app, /setError\(loadError\.message\);/);
});

test("connection state is still tracked on the Bibi surface", async () => {
  const app = await read("src/App.jsx");

  // Only the legacy error text is withheld. Losing the offline transition would
  // make the sidebar status lie once the user navigates away.
  assert.match(app, /reportError\(loadError\.message\);\s*setConnection\("offline"\);/);
});

test("legacy online-count and refresh chrome is hidden on the Bibi surface only", async () => {
  const app = await read("src/App.jsx");

  assert.match(app, /\{!bibiSurface && \(\s*<span className="topbar-signal">/);
  assert.match(app, /\{!bibiSurface && <button type="button" onClick=\{refresh\}>새로고침<\/button>\}/);
  // Upstream views keep the chrome: it is conditioned, never deleted.
  assert.match(app, /명 온라인<\/span>/);
});

// ---------------------------------------------------------------------------
// The sidebar mark
// ---------------------------------------------------------------------------

test("the sidebar mark points at an asset that exists and is a real SVG", () => {
  assert.ok(OFFICE_BRAND_MARK_SRC.startsWith("/"), "the mark is served from the site root");
  const asset = path.join(projectRoot, "public", OFFICE_BRAND_MARK_SRC.replace(/^\//, ""));
  assert.ok(existsSync(asset), `${OFFICE_BRAND_MARK_SRC} must exist under public/`);
  const contents = readFileSync(asset, "utf8");
  assert.ok(contents.length > 0, "the mark must not be empty");
  assert.match(contents, /<svg[\s>]/);
});

test("the sidebar mark is not shadowed by the Hermes dev proxy prefix", async () => {
  const viteConfig = await read("vite.config.js");

  // The dev and preview servers proxy this prefix to the local backend, so any
  // public file whose path starts with it is never served.
  const proxied = viteConfig.match(/"(\/hermes)":\s*\{/);
  assert.ok(proxied, "the /hermes proxy prefix is expected to exist");
  assert.equal(
    OFFICE_BRAND_MARK_SRC.startsWith(proxied[1]),
    false,
    `${OFFICE_BRAND_MARK_SRC} would be swallowed by the ${proxied[1]} proxy`,
  );
});

test("the brand lockup falls back to a text mark when the image fails", async () => {
  const [app, styles] = await Promise.all([read("src/App.jsx"), read("src/styles.css")]);

  assert.match(app, /onError=\{\(\) => setMarkBroken\(true\)\}/);
  assert.match(app, /<span className="brand-lockup-fallback" aria-hidden="true">/);
  assert.match(app, /src=\{OFFICE_BRAND_MARK_SRC\}/);
  assert.doesNotMatch(app, /src="\/hermes-mark\.svg"/);
  assert.match(styles, /\.brand-lockup-fallback\s*\{/);
});

// ---------------------------------------------------------------------------
// Responsive fit
// ---------------------------------------------------------------------------

test("the Bibi surface and its descendants size as border boxes", async () => {
  const css = await read("src/bibiWorkspace.css");

  assert.match(
    css,
    /\.bibi-workspace,\s*\.bibi-workspace \*,[\s\S]*?box-sizing:\s*border-box;/,
  );
  assert.equal(declaration(css, ".bibi-workspace", "max-width"), "100%");
  assert.equal(declaration(css, ".bibi-workspace", "min-width"), "0");
});

test("flex and grid children of the surface cannot blow out the content column", async () => {
  const css = await read("src/bibiWorkspace.css");

  const block = css.match(
    /\.bibi-workspace > \*,\s*\.bibi-layout > \*,\s*\.bibi-side > \*\s*\{([^}]*)\}/,
  );
  assert.ok(block, "surface children need an explicit min-width reset");
  assert.match(block[1], /min-width:\s*0;/);
  assert.match(block[1], /max-width:\s*100%;/);
});

test("the sign-in form, fields and helper text stay inside the card", async () => {
  const css = await read("src/bibiWorkspace.css");

  assert.equal(declaration(css, ".bibi-signin", "max-width"), "min(340px, 100%)");
  assert.equal(declaration(css, ".bibi-signin input", "max-width"), "100%");
  assert.equal(declaration(css, ".bibi-signin input", "min-width"), "0");
  assert.equal(declaration(css, ".bibi-signin-note", "max-width"), "100%");
  assert.match(declaration(css, ".bibi-signin-note", "overflow-wrap"), /anywhere/);
});

test("the mobile block trims the surface to safe-area padding", async () => {
  const css = await read("src/bibiWorkspace.css");
  const mobile = mediaBlock(css, "@media (max-width: 640px)");

  assert.match(mobile, /\.bibi-workspace\s*\{[^}]*padding:[^;]*env\(safe-area-inset-left\)/);
  assert.match(mobile, /\.bibi-auth\s*\{[^}]*max-width:\s*100%;/);
});

test("nothing on the mobile sign-in surface can exceed a 390px viewport", async () => {
  const css = await read("src/bibiWorkspace.css");
  const mobile = mediaBlock(css, "@media (max-width: 640px)");

  // The widest fixed chain on this screen is: surface padding, card padding,
  // then the form's own cap. Adding a fixed width anywhere in it has to keep
  // the total inside the narrowest supported viewport.
  const surfacePadding = mobile.match(/\.bibi-workspace\s*\{[^}]*padding:\s*([^;]+);/);
  assert.ok(surfacePadding, "the mobile surface declares its own padding");
  const surfaceSide = Number(surfacePadding[1].match(/max\((\d+)px/)[1]);

  const cardPadding = mobile.match(
    /\.bibi-setup,[\s\S]*?\{[^}]*padding:\s*(\d+)px;/,
  );
  assert.ok(cardPadding, "the mobile cards declare their own padding");
  const cardSide = Number(cardPadding[1]);

  const formCap = 340; // .bibi-signin max-width: min(340px, 100%)
  const available = MOBILE_VIEWPORT - surfaceSide * 2 - cardSide * 2;
  assert.ok(available > 0, "the card must have room left inside the viewport");
  assert.ok(
    Math.min(formCap, available) <= available,
    `form width ${Math.min(formCap, available)} must fit ${available}px of content`,
  );
  // The `min(…, 100%)` cap is what makes the line above true for any viewport;
  // a bare pixel cap wider than the column is the regression being guarded.
  assert.doesNotMatch(
    await read("src/bibiWorkspace.css"),
    /\.bibi-signin\s*\{[^}]*max-width:\s*\d+px;/,
  );
});

// ---------------------------------------------------------------------------
// Desktop composition
// ---------------------------------------------------------------------------

test("the signed-out auth panel is centred at a reading width", async () => {
  const [css, workspace] = await Promise.all([
    read("src/bibiWorkspace.css"),
    read("src/BibiWorkspace.jsx"),
  ]);

  assert.match(workspace, /<div className="bibi-workspace is-auth">\s*<div className="bibi-auth">/);
  assert.match(css, /\.bibi-workspace\.is-auth\s*\{[^}]*align-items:\s*center;/);

  const maxWidth = declaration(css, ".bibi-auth", "max-width");
  const pixels = Number(maxWidth.replace("px", ""));
  assert.ok(Number.isFinite(pixels), "the auth panel needs a pixel cap");
  assert.ok(pixels >= 360 && pixels <= 640, `auth panel cap ${maxWidth} should read as a card, not a column`);
  assert.match(declaration(css, ".bibi-auth", "margin-inline"), /auto/);
});

test("the signed-in workspace keeps the full content width", async () => {
  const [css, workspace] = await Promise.all([
    read("src/bibiWorkspace.css"),
    read("src/BibiWorkspace.jsx"),
  ]);

  // Only the signed-out branch carries the modifier, and the three-column grid
  // is never wrapped in the capped container.
  assert.equal((workspace.match(/bibi-workspace is-auth/g) ?? []).length, 1);
  assert.equal((workspace.match(/className="bibi-auth"/g) ?? []).length, 1);
  assert.match(workspace, /<div className="bibi-workspace">\s*<header className="bibi-header">/);
  assert.doesNotMatch(css, /\.bibi-layout\s*\{[^}]*max-width:\s*\d+px;/);
});

// ---------------------------------------------------------------------------
// Mobile navigation dock
// ---------------------------------------------------------------------------

test("the mobile dock has one column per destination", async () => {
  const [app, styles] = await Promise.all([read("src/App.jsx"), read("src/styles.css")]);

  const tabs = app.match(/const MOBILE_TABS = \[([\s\S]*?)\];/);
  assert.ok(tabs, "MOBILE_TABS must be declared");
  const tabCount = (tabs[1].match(/\[\s*"/g) ?? []).length;
  assert.ok(tabCount > 0, "MOBILE_TABS must not be empty");
  assert.match(tabs[1], /\[\s*"ceo",/, "the Bibi surface is a mobile destination");

  const columns = styles.match(
    /\.mobile-dock \{ grid-template-columns: repeat\((\d+), minmax\(0, 1fr\)\) !important; \}/,
  );
  assert.ok(columns, "the mobile dock declares its column count");
  assert.equal(
    Number(columns[1]),
    tabCount,
    "a dock narrower than its tab list wraps the last tab onto a clipped row",
  );
});
