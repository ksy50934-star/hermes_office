/**
 * The invite link's return trip.
 *
 * Everything here is deterministic and offline: `parseAuthCallback` is handed a
 * URL string and asked what it means. The cases are the four shapes Supabase
 * actually returns, plus the two that matter most and are easiest to get wrong
 * — a failure dressed as a fragment, and a token left behind in the address bar.
 *
 * No real credential appears below. Every token is an obvious fixture.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTH_CALLBACK,
  AUTH_PARAM_NAMES,
  CALLBACK_INTENT,
  describeCallbackError,
  describeCallbackFailure,
  isAuthCallback,
  parseAuthCallback,
  requiresPasswordSetup,
  strippedUrl,
} from "../src/bibi/authCallback.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFile(path.join(projectRoot, relative), "utf8");

const SITE = "https://bibi-workspace-18.vercel.app";
const ACCESS = "fixture-access-token-not-a-real-credential";
const REFRESH = "fixture-refresh-token-not-a-real-credential";

// ---------------------------------------------------------------------------
// Shape 1 — implicit flow, tokens in the fragment
// ---------------------------------------------------------------------------

test("an invite that returns tokens in the fragment is recognised as an invite", () => {
  const callback = parseAuthCallback(
    `${SITE}/#access_token=${ACCESS}&expires_in=3600&refresh_token=${REFRESH}&token_type=bearer&type=invite`,
  );

  assert.equal(callback.kind, AUTH_CALLBACK.TOKENS);
  assert.equal(callback.intent, CALLBACK_INTENT.INVITE);
  assert.equal(callback.tokens.accessToken, ACCESS);
  assert.equal(callback.tokens.refreshToken, REFRESH);
  assert.equal(requiresPasswordSetup(callback), true);
});

test("a recovery link also has to end in a new password", () => {
  const callback = parseAuthCallback(
    `${SITE}/#access_token=${ACCESS}&refresh_token=${REFRESH}&type=recovery`,
  );
  assert.equal(callback.intent, CALLBACK_INTENT.RECOVERY);
  assert.equal(requiresPasswordSetup(callback), true);
});

test("a confirmed sign-up is treated like an invite, not waved through", () => {
  const callback = parseAuthCallback(
    `${SITE}/#access_token=${ACCESS}&refresh_token=${REFRESH}&type=signup`,
  );
  assert.equal(callback.intent, CALLBACK_INTENT.INVITE);
  assert.equal(requiresPasswordSetup(callback), true);
});

test("a link that only signs someone in asks for no password", () => {
  const callback = parseAuthCallback(
    `${SITE}/#access_token=${ACCESS}&refresh_token=${REFRESH}&type=magiclink`,
  );
  assert.equal(callback.kind, AUTH_CALLBACK.TOKENS);
  assert.equal(callback.intent, CALLBACK_INTENT.SIGN_IN);
  assert.equal(requiresPasswordSetup(callback), false);
});

test("an access token with no refresh token is a truncated link, not a session", () => {
  const callback = parseAuthCallback(`${SITE}/#access_token=${ACCESS}&type=invite`);
  assert.equal(callback.kind, AUTH_CALLBACK.NONE);
  assert.equal(isAuthCallback(callback), false);
  assert.equal(requiresPasswordSetup(callback), false);
});

// ---------------------------------------------------------------------------
// Shape 2 — token hash in the query
// ---------------------------------------------------------------------------

test("a token-hash invite is recognised and keeps its type for verification", () => {
  const callback = parseAuthCallback(`${SITE}/?token_hash=pkce_fixturehash&type=invite`);

  assert.equal(callback.kind, AUTH_CALLBACK.TOKEN_HASH);
  assert.equal(callback.tokenHash, "pkce_fixturehash");
  // GoTrue verifies an invite hash differently from a recovery hash, so the
  // type must survive parsing rather than being defaulted away.
  assert.equal(callback.type, "invite");
  assert.equal(requiresPasswordSetup(callback), true);
});

// ---------------------------------------------------------------------------
// Shape 3 — PKCE code
// ---------------------------------------------------------------------------

test("a PKCE code is recognised, and an invite code still owes a password", () => {
  const plain = parseAuthCallback(`${SITE}/?code=fixture-code-value`);
  assert.equal(plain.kind, AUTH_CALLBACK.CODE);
  assert.equal(plain.code, "fixture-code-value");
  assert.equal(requiresPasswordSetup(plain), false);

  const invite = parseAuthCallback(`${SITE}/?code=fixture-code-value&type=invite`);
  assert.equal(invite.kind, AUTH_CALLBACK.CODE);
  assert.equal(requiresPasswordSetup(invite), true);
});

// ---------------------------------------------------------------------------
// Shape 4 — failure
// ---------------------------------------------------------------------------

test("an expired invite is a failure, never a session", () => {
  const callback = parseAuthCallback(
    `${SITE}/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`,
  );

  assert.equal(callback.kind, AUTH_CALLBACK.ERROR);
  assert.equal(callback.errorCode, "otp_expired");
  assert.equal(callback.tokens, null);
  assert.equal(requiresPasswordSetup(callback), false);
});

test("a failure beats a token in the same URL", () => {
  // Defence in depth. If a proxy or a mangled template ever produced both, the
  // one that must not win is the token.
  const callback = parseAuthCallback(
    `${SITE}/#error=access_denied&error_code=otp_expired&access_token=${ACCESS}&refresh_token=${REFRESH}&type=invite`,
  );
  assert.equal(callback.kind, AUTH_CALLBACK.ERROR);
  assert.equal(callback.tokens, null);
});

test("an error with no code still classifies as a failure", () => {
  const callback = parseAuthCallback(`${SITE}/?error=server_error`);
  assert.equal(callback.kind, AUTH_CALLBACK.ERROR);
  assert.equal(callback.errorCode, "server_error");
});

// ---------------------------------------------------------------------------
// Nothing to do
// ---------------------------------------------------------------------------

test("an ordinary visit is not a callback", () => {
  for (const href of [
    `${SITE}/`,
    `${SITE}/?view=office`,
    `${SITE}/#section`,
    `${SITE}/?view=kanban#board`,
  ]) {
    const callback = parseAuthCallback(href);
    assert.equal(callback.kind, AUTH_CALLBACK.NONE, `${href} must not look like a callback`);
    assert.equal(isAuthCallback(callback), false);
  }
});

test("unparseable input is inert rather than throwing", () => {
  for (const href of [null, undefined, "", "not a url", 42, {}]) {
    const callback = parseAuthCallback(href);
    assert.equal(callback.kind, AUTH_CALLBACK.NONE);
    assert.equal(requiresPasswordSetup(callback), false);
  }
  assert.equal(isAuthCallback(null), false);
  assert.equal(requiresPasswordSetup(null), false);
});

// ---------------------------------------------------------------------------
// Scrubbing the address bar
// ---------------------------------------------------------------------------

test("every auth parameter is removed from the URL, in query and in fragment", () => {
  const href = `${SITE}/?code=c&token_hash=h&error=e&error_code=ec&error_description=ed`
    + `#access_token=${ACCESS}&refresh_token=${REFRESH}&expires_in=3600&expires_at=1&token_type=bearer&type=invite`;
  const cleaned = strippedUrl(href);

  for (const name of AUTH_PARAM_NAMES) {
    assert.ok(!cleaned.includes(name), `${name} must not survive stripping: ${cleaned}`);
  }
  assert.ok(!cleaned.includes(ACCESS), "the access token must not survive");
  assert.ok(!cleaned.includes(REFRESH), "the refresh token must not survive");
  assert.equal(cleaned, "/");
});

test("stripping preserves the rest of the route", () => {
  const cleaned = strippedUrl(
    `${SITE}/some/path?view=office&keep=1#access_token=${ACCESS}&refresh_token=${REFRESH}&type=invite&anchor=x`,
  );
  assert.ok(cleaned.startsWith("/some/path"), cleaned);
  assert.ok(cleaned.includes("view=office"), cleaned);
  assert.ok(cleaned.includes("keep=1"), cleaned);
  assert.ok(cleaned.includes("anchor=x"), cleaned);
  assert.ok(!cleaned.includes(ACCESS), cleaned);
});

test("stripping a clean URL leaves it alone and never throws", () => {
  assert.equal(strippedUrl(`${SITE}/?view=office`), "/?view=office");
  assert.equal(strippedUrl("not a url"), "not a url");
  assert.equal(strippedUrl(null), "");
});

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

test("a failed link is explained without saying whether the account exists", () => {
  const expired = describeCallbackError({ errorCode: "otp_expired" });
  assert.ok(expired.trim());
  // The one distinction worth drawing is expiry, which is not a fact about
  // whether an account exists.
  assert.match(expired, /만료|사용/);

  for (const code of ["access_denied", "validation_failed", "unauthorized_client", ""]) {
    const message = describeCallbackError({ errorCode: code });
    assert.ok(message.trim(), `${code} needs wording`);
    assert.ok(
      !/없는 계정|가입되지|등록되지 않은|존재하지 않는 사용자/.test(message),
      `${code} must not disclose account existence: ${message}`,
    );
  }
});

test("a browser-mismatch failure tells the user the one thing that would help", () => {
  for (const code of ["flow_state_not_found", "bad_code_verifier"]) {
    assert.match(describeCallbackError({ errorCode: code }), /브라우저/);
  }
});

test("no failure wording ever contains a token or an error description", () => {
  const callback = parseAuthCallback(
    `${SITE}/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid`,
  );
  const message = describeCallbackError(callback);

  assert.ok(!message.includes(ACCESS));
  assert.ok(!message.includes("Email link"));
  // The server's own prose is dropped rather than relayed.
  assert.ok(!/error_description|access_denied/.test(message));
  assert.ok(describeCallbackFailure().trim());
});

test("unknown and missing failure codes still produce actionable wording", () => {
  for (const input of [null, undefined, {}, { errorCode: "teapot" }, { errorCode: 42 }]) {
    const message = describeCallbackError(input);
    assert.ok(message.trim());
    assert.match(message, /초대|소유자/);
  }
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("the browser client does not sweep the URL up on its own", async () => {
  const source = await read("src/cloud/supabaseBrowser.js");
  // If the library consumed the fragment, `type=invite` would be gone before
  // anything could read it, and an invited user would land in the workspace
  // without ever choosing a password.
  assert.match(source, /detectSessionInUrl:\s*false/);
  assert.match(source, /flowType:\s*"implicit"/);
  assert.match(source, /persistSession:\s*true/);
  assert.match(source, /autoRefreshToken:\s*true/);
});

test("the workspace client can redeem all three success shapes", async () => {
  const source = await read("src/cloud/workspaceClient.js");
  assert.match(source, /export async function establishSessionFromCallback/);
  assert.match(source, /auth\.setSession\(/);
  assert.match(source, /auth\.verifyOtp\(/);
  assert.match(source, /auth\.exchangeCodeForSession\(/);
});

test("the workspace scrubs the URL before it spends the token", async () => {
  const source = await read("src/BibiWorkspace.jsx");

  assert.match(source, /parseAuthCallback\(window\.location\.href\)/);
  assert.match(source, /history\.replaceState\(null, "", strippedUrl\(window\.location\.href\)\)/);

  // The scrub has to happen inside the capture, before the callback is handed
  // back to the component that will redeem it.
  const capture = source.slice(
    source.indexOf("function consumeAuthCallback"),
    source.indexOf("export function resetAuthCallbackCapture"),
  );
  assert.ok(capture.includes("replaceState"), "the capture must scrub the URL itself");
  assert.ok(
    capture.indexOf("replaceState") < capture.lastIndexOf("return capturedCallback"),
    "the scrub must precede handing the callback back",
  );
});

test("the callback is captured exactly once per page load", async () => {
  const source = await read("src/BibiWorkspace.jsx");
  // React mounts twice in development and effects re-run; a token redeems once.
  assert.match(source, /if \(capturedCallback !== undefined\) return capturedCallback;/);
});

test("no auth token is ever written to a log", async () => {
  for (const file of [
    "src/bibi/authCallback.js",
    "src/bibi/passwordPolicy.js",
    "src/bibi/pendingPasswordSetup.js",
    "src/cloud/workspaceClient.js",
    "src/BibiWorkspace.jsx",
  ]) {
    const source = await read(file);
    assert.doesNotMatch(source, /console\.(log|info|warn|error|debug)/, `${file} must not log`);
  }
});
