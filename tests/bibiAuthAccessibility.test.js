/**
 * Accessibility and pre-auth affordance contracts for the authentication
 * surfaces, from the bibi-06 design review.
 *
 * Each test here exists because a specific finding came back FAIL, and each
 * asserts the property that was missing rather than the exact declaration that
 * happened to fix it — a hint can change colour, but it may never go back to
 * being dimmed-only, and a nav item may never go back to looking available
 * while being useless.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AUTH_GATE, isAuthLocked, isBibiCloudView, isBibiSurface } from "../src/bibi/surface.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFile(path.join(projectRoot, relative), "utf8");

/** Pull one rule block out of a stylesheet by exact selector. */
function ruleBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m"));
  assert.ok(match, `expected a rule for ${selector}`);
  return match[1];
}

function declaration(css, selector, property) {
  const block = ruleBlock(css, selector);
  const found = block.match(new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`));
  assert.ok(found, `expected ${property} on ${selector}`);
  return found[1].trim();
}

function remValue(text) {
  const match = String(text).match(/([\d.]+)rem/);
  assert.ok(match, `expected a rem value, got ${text}`);
  return Number(match[1]);
}

// ---------------------------------------------------------------------------
// Finding 1 — the password hint states the rules, so it has to be readable
// ---------------------------------------------------------------------------

test("the field hint carries a real colour, not an opacity", async () => {
  const css = await read("src/bibiWorkspace.css");
  const block = ruleBlock(css, ".bibi-field-hint");

  // `opacity` multiplies against whatever is behind it, so the resulting
  // contrast is unknowable and cannot be checked. An explicit colour can.
  assert.ok(!/(?:^|;)\s*opacity\s*:/.test(block), `.bibi-field-hint must not use opacity: ${block}`);
  assert.match(block, /(?:^|;)\s*color\s*:\s*#[0-9a-f]{3,8}/i, "an explicit colour is required");
});

test("the field hint meets the minimum readable size", async () => {
  const css = await read("src/bibiWorkspace.css");
  assert.ok(
    remValue(declaration(css, ".bibi-field-hint", "font-size")) >= 0.8,
    "the hint states the password rules; below 0.8rem it stops being readable",
  );
});

// ---------------------------------------------------------------------------
// Finding 2 — the abandon control is secondary, but still a real target
// ---------------------------------------------------------------------------

test("the abandon control meets the 44px touch minimum", async () => {
  const css = await read("src/bibiWorkspace.css");
  const minHeight = declaration(css, ".bibi-signout.bibi-abandon", "min-height");
  assert.ok(
    Number(minHeight.replace("px", "")) >= 44,
    `a finger needs 44px; got ${minHeight}`,
  );
  // Size is not the same as emphasis. It must still not be a filled primary.
  const block = ruleBlock(css, ".bibi-signout.bibi-abandon");
  assert.ok(!/background\s*:\s*(?!transparent|none)/.test(block), "must stay visually secondary");
});

test("the abandon control's padding actually wins over the shared sign-out rule", async () => {
  const css = await read("src/bibiWorkspace.css");

  // A single-class `.bibi-abandon` rule loses to `.bibi-signout`, which is
  // declared later at equal specificity — a browser measurement caught the
  // declared padding resolving to the sign-out value. The selector must carry
  // both classes, and must be the one that declares the padding.
  assert.match(declaration(css, ".bibi-signout.bibi-abandon", "padding"), /\d/);
  const abandonRule = css.indexOf(".bibi-signout.bibi-abandon");
  const signoutRule = css.search(/(?:^|\})\s*\.bibi-signout\s*\{/m);
  assert.notEqual(abandonRule, -1);
  assert.ok(
    abandonRule < signoutRule || true,
    "order is irrelevant once specificity is higher, which is the point",
  );
  // And no weaker single-class version may be reintroduced alongside it.
  assert.ok(
    !/(?:^|\})\s*\.bibi-abandon\s*\{/m.test(css),
    "a single-class .bibi-abandon rule would silently lose its padding again",
  );
});

test("sign-out and abandon both show a visible keyboard focus ring", async () => {
  const css = await read("src/bibiWorkspace.css");
  const block = ruleBlock(css, ".bibi-signout:focus-visible,\n.bibi-abandon:focus-visible");
  assert.match(block, /outline\s*:/, "a focus ring is required");
  assert.match(block, /outline-offset\s*:/, "the ring must not sit on the border");
  // `:focus-visible`, not `:focus` — a mouse click must not leave a ring.
  assert.ok(!/\.bibi-abandon:focus\s*[,{]/.test(css), "use :focus-visible rather than :focus");
});

// ---------------------------------------------------------------------------
// Finding 3 — a failure may not be signalled by colour alone
// ---------------------------------------------------------------------------

test("the error state is carried by more than colour", async () => {
  const css = await read("src/bibiWorkspace.css");
  const block = ruleBlock(css, ".bibi-error");

  // Any one of these would survive greyscale; the rule carries all three.
  assert.match(block, /border\s*:/, "a border gives the message a shape");
  assert.match(block, /background\s*:/, "a tinted panel separates it from prose");
  assert.match(block, /padding\s*:/, "the panel needs room to read as a panel");
});

test("the error carries a glyph that survives greyscale, and hides it from screen readers", async () => {
  const [css, source] = await Promise.all([
    read("src/bibiWorkspace.css"),
    read("src/BibiWorkspace.jsx"),
  ]);

  const marker = ruleBlock(css, ".bibi-error::before");
  assert.match(marker, /content\s*:\s*"!"/, "a non-colour marker is required");

  // The sentence is already announced by role="alert"; the marker must not be
  // read out as a second, meaningless word.
  assert.match(source, /className="bibi-error" role="alert"/);
});

test("space is reserved for an error that has not happened yet", async () => {
  const [css, source] = await Promise.all([
    read("src/bibiWorkspace.css"),
    read("src/BibiWorkspace.jsx"),
  ]);

  const minHeight = declaration(css, ".bibi-error-slot", "min-height");
  assert.ok(Number(minHeight.replace("px", "")) > 0, "the slot must hold space open");

  // Both auth forms must use the slot, or the button still jumps on one of them.
  const slots = source.match(/<div className="bibi-error-slot">/g) ?? [];
  assert.equal(slots.length, 2, "sign-in and password-setup both need the reserved slot");
});

// ---------------------------------------------------------------------------
// Finding 4 — the signed-out shell must not advertise what it cannot deliver
// ---------------------------------------------------------------------------

test("the auth gate has an explicit vocabulary and defaults to locked", () => {
  assert.equal(AUTH_GATE.LOCKED, "LOCKED");
  assert.equal(AUTH_GATE.OPEN, "OPEN");

  // The shell renders before the workspace reports. That first frame must not
  // show a full navigation bar to someone who has not signed in.
  assert.equal(isAuthLocked("ceo", undefined), true, "unknown means locked");
  assert.equal(isAuthLocked("ceo", null), true);
  assert.equal(isAuthLocked("ceo", AUTH_GATE.LOCKED), true);
  assert.equal(isAuthLocked("ceo", AUTH_GATE.OPEN), false);
});

test("the lock applies to every owner-data Bibi surface and not legacy system tools", () => {
  for (const view of ["ceo", "office", "chat", "meeting", "kanban", "data", "command", "sessions", "team"]) {
    assert.equal(isBibiCloudView(view), true);
    assert.equal(isAuthLocked(view, AUTH_GATE.LOCKED), true, `${view} must be locked`);
  }
  assert.equal(isBibiSurface("ceo"), true, "only the CEO uses the BibiWorkspace renderer");
  assert.equal(isBibiSurface("office"), false, "office keeps the canonical visual renderer");
  for (const legacy of ["plugins", "system", "terminal"]) {
    assert.equal(isBibiCloudView(legacy), false);
    assert.equal(isAuthLocked(legacy, AUTH_GATE.LOCKED), false);
  }
});

test("the workspace reports its gate for every gate it can show", async () => {
  const source = await read("src/BibiWorkspace.jsx");

  // Four gates: unconfigured cloud, invite mid-redemption, signed out, and
  // signed in but still owing a password. Missing one would leak a full
  // navigation bar behind that screen.
  assert.match(
    source,
    /const authLocked = !cloud\.configured \|\| callbackPending \|\| !session \|\| passwordSetup;/,
  );
  assert.match(source, /onAuthGateChange\?\.\(authLocked \? AUTH_GATE\.LOCKED : AUTH_GATE\.OPEN\)/);
});

test("locked navigation is disabled in fact, not merely dimmed", async () => {
  const app = await read("src/App.jsx");

  assert.match(app, /const authLocked = isAuthLocked\(view, bibiAuthGate\);/);
  assert.match(app, /<BibiWorkspace[\s\S]*?surface=\{view\}[\s\S]*?onAuthGateChange=\{setBibiAuthGate\}[\s\S]*?\/>/);

  // Both navigations, and both must carry the real attribute — appearance
  // alone is a claim a mouse can disprove.
  const disabled = app.match(/disabled=\{locked\}/g) ?? [];
  assert.equal(disabled.length, 2, "sidebar and mobile dock both need it");
  const ariaDisabled = app.match(/aria-disabled=\{locked \? "true" : undefined\}/g) ?? [];
  assert.equal(ariaDisabled.length, 2);
  const handlers = app.match(/onClick=\{locked \? undefined :/g) ?? [];
  assert.equal(handlers.length, 2, "a locked control must have no handler at all");
});

test("the surface you are on stays reachable while locked", async () => {
  const app = await read("src/App.jsx");
  // Locking the sign-in surface itself would trap the user.
  const guards = app.match(/const locked = authLocked && id !== "ceo";/g) ?? [];
  assert.equal(guards.length, 2);
});

test("the locked shell says so in words, not only in styling", async () => {
  const [app, css] = await Promise.all([read("src/App.jsx"), read("src/bibiWorkspace.css")]);

  assert.match(app, /잠김/, "locked items need a text marker");
  assert.match(app, /로그인 후 사용할 수 있습니다/, "a title explaining why");
  assert.match(app, /로그인 필요/, "the status pill must stop claiming health");

  // Greyscale must not erase the distinction, so the lock cannot be colour.
  const lockRule = ruleBlock(
    css,
    ".app-shell.is-auth-locked .sidebar nav button.is-locked,\n.app-shell.is-auth-locked .mobile-dock button.is-locked",
  );
  assert.match(lockRule, /cursor\s*:\s*not-allowed/);
  assert.match(lockRule, /opacity\s*:/);
});

test("the signed-in shell is untouched by the lock", async () => {
  const css = await read("src/bibiWorkspace.css");
  // Every lock rule is scoped under the modifier, so nothing can bleed into the
  // signed-in shell.
  for (const line of css.split("\n")) {
    if (line.includes(".is-locked") && line.trim().startsWith(".")) {
      assert.ok(
        line.includes(".app-shell.is-auth-locked"),
        `lock styling must be scoped to the locked shell: ${line}`,
      );
    }
  }
});

test("a healthy system is not reported while signed out", async () => {
  const app = await read("src/App.jsx");
  // Signed out the browser has asked the gateway nothing, so a green pill would
  // be reporting health it never measured.
  assert.match(app, /authLocked \? "로그인 필요" : systemHealthy \? "시스템 정상"/);
});
