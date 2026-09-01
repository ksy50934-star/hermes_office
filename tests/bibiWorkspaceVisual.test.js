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

import { BIBI_VIEW_ID, isBibiCloudView, isBibiSurface } from "../src/bibi/surface.js";
import {
  BRIDGE_STATE,
  DISCOVERY_STATE,
  describeConversationBridge,
} from "../src/bibi/telegramBridge.js";
import { OFFICE_BRAND_MARK_SRC } from "../src/branding.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFile(path.join(projectRoot, relative), "utf8");

const MOBILE_VIEWPORT = 390;

/**
 * The signed-in workspace root, anchored on its header.
 *
 * The class alone will not do: the unconfigured-cloud screen carries the same
 * `bibi-workspace` class and returns earlier in the file, so a class-only match
 * would land on that instead and read the ordering backwards. The header is
 * rendered by this branch and no other, which is what pins the match.
 *
 * The attribute gap is deliberate. This element legitimately grows attributes —
 * it currently carries the scroll-reset ref — and the contract under test is
 * "the full-width workspace renders here, after every card screen", not the
 * element's exact attribute list. An exact-literal match made the two unrelated
 * ideas fail together.
 */
const SIGNED_IN_WORKSPACE_ROOT = /<div className=\{`bibi-workspace is-surface-\$\{surface\}`\}[^<]*?>\s*<header className="bibi-header">/;

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
  for (const view of ["ceo", "office", "chat", "meeting", "kanban", "data", "command", "sessions", "team", "plugins", "system", "terminal"]) {
    assert.equal(isBibiCloudView(view), true, `${view} is an owner-data Bibi route`);
  }
  for (const other of ["", null, undefined]) {
    assert.equal(isBibiCloudView(other), false, `${String(other)} is not a cloud route`);
    assert.equal(isBibiSurface(other), false, `${String(other)} is not the CEO renderer`);
  }
});

test("the owner chat surface renders the verified Telegram bridge and its disconnect action", async () => {
  const bridge = describeConversationBridge({
    conversation: {
      id: "conversation-1",
      origin_channel: "web",
      sync_status: "synced",
      telegram_mirroring_enabled: false,
    },
    binding: {
      id: "binding-old",
      binding_state: "verified",
      hermes_session_id: "session-old",
      channel_account_id: "telegram-account",
      external_conversation_id: "telegram-chat",
    },
    connectorHealth: { state: "online", label: "ONLINE" },
    discovery: {
      state: DISCOVERY_STATE.READY,
      detail: null,
      incompleteCount: 0,
      sessions: [{
        hermes_session_id: "20260901_173509_8daf1f41",
        identity_complete: true,
        session_state: "active",
      }],
    },
  });

  assert.equal(bridge.state, BRIDGE_STATE.VERIFIED);
  assert.equal(bridge.canDisconnect, true);
  assert.equal(isBibiSurface("chat"), true, "the chat route must mount BibiWorkspace rather than the bridge-less direct-chat renderer");

  const [workspace, app] = await Promise.all([
    read("src/BibiWorkspace.jsx"),
    read("src/App.jsx"),
  ]);
  assert.match(workspace, /<TelegramBridgePanel/);
  assert.match(workspace, /bridge\.canDisconnect[\s\S]*?연결 해제/);
  assert.match(app, /const specialistSurfaceReady = !bibiSurface/);
  assert.match(app, /specialistSurfaceReady && bibiCloudView && view === "chat"/);
});

test("verified bridge rendering tolerates the current conversation readback shapes", () => {
  for (const conversation of [
    null,
    {},
    { id: "conversation-1" },
    {
      id: "conversation-1",
      origin_channel: "telegram",
      sync_status: "synced",
      sync_error: null,
      telegram_mirroring_enabled: false,
    },
  ]) {
    const bridge = describeConversationBridge({
      conversation,
      binding: {
        id: "binding-old",
        binding_state: "verified",
        hermes_session_id: "session-old",
      },
    });
    assert.equal(bridge.canDisconnect, true);
    assert.ok(bridge.label && bridge.detail && bridge.projectionLabel);
  }
});

test("App derives the Bibi surface from the shared predicate, not a loose string", async () => {
  const app = await read("src/App.jsx");

  // The contract is that the predicate comes from the shared module and is what
  // App branches on. The rest of that import list is free to grow — it now also
  // carries the auth-gate vocabulary — so pinning the exact named-import set
  // would fail on unrelated additions without protecting anything.
  assert.match(app, /import \{[^}]*\bisBibiSurface\b[^}]*\} from "\.\/bibi\/surface\.js";/);
  assert.match(app, /const bibiSurface = isBibiSurface\(view\);/);

  // And it must stay a derived value rather than being recomputed inline at the
  // call sites, which is the drift the original finding was about.
  assert.ok(
    (app.match(/isBibiSurface\(/g) ?? []).length >= 1,
    "App must call the shared predicate",
  );
});

test("legacy Hermes core-health errors are withheld only while the Bibi surface is active", async () => {
  const app = await read("src/App.jsx");

  // The gate is inside refresh, so the banner text is never even produced there.
  assert.match(app, /const reportError = \(message\) => \{\s*if \(bibiSurfaceRef\.current\) return;\s*setError\(message\);\s*\};/);
  assert.match(app, /bibiSurfaceRef\.current = isBibiCloudView\(view\);/);
  assert.match(app, /reportError\(loadError\.message\);/);
  assert.match(app, /reportError\(`Hermes 업무 보드를 불러오지 못했습니다\./);
  // …and the banner itself is hidden on that surface only.
  assert.match(app, /\{error && !officeNotice && !bibiCloudView && \(/);
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

test("legacy online-count and refresh chrome is hidden on owner-data cloud routes", async () => {
  const app = await read("src/App.jsx");

  assert.match(app, /\{!bibiCloudView && \(\s*<span className="topbar-signal">/);
  assert.match(app, /\{!bibiCloudView && <button type="button" onClick=\{refresh\}>새로고침<\/button>\}/);
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

  // Three screens precede the workspace — redeeming an invite, signing in, and
  // choosing a password — and each is a card. Every one of them carries the
  // modifier and the capped container together; the three-column grid carries
  // neither.
  const modifiers = (workspace.match(/bibi-workspace is-auth/g) ?? []).length;
  const containers = (workspace.match(/className="bibi-auth"/g) ?? []).length;
  assert.ok(modifiers >= 1, "at least one card screen must exist");
  assert.equal(modifiers, containers, "every capped card must carry both the modifier and the container");

  const workspaceRoot = workspace.search(SIGNED_IN_WORKSPACE_ROOT);
  assert.notEqual(workspaceRoot, -1, "the signed-in workspace must render at full width");
  // Every card screen short-circuits before that root, so none of them can wrap it.
  const lastCard = workspace.lastIndexOf("bibi-workspace is-auth");
  assert.ok(lastCard < workspaceRoot, "no card screen may enclose the signed-in workspace");

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
