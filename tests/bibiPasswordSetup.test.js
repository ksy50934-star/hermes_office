/**
 * Choosing a password, and the obligation to choose one.
 *
 * Two things are covered. The policy itself, which is pure and checked against
 * concrete inputs. And the wiring, which is checked against source: the screen
 * has to exist, has to be the only thing reachable until the password saves,
 * and has to survive a reload without dropping the user into a workspace they
 * cannot get back into.
 *
 * Every password below is a fixture. None is, or resembles, a real credential,
 * and none is written anywhere but this file's assertions.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  PASSWORD_PROBLEM,
  describePasswordUpdateError,
  passwordByteLength,
  validateNewPassword,
} from "../src/bibi/passwordPolicy.js";
import {
  clearPasswordSetupPending,
  isPasswordSetupPending,
  markPasswordSetupPending,
} from "../src/bibi/pendingPasswordSetup.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFile(path.join(projectRoot, relative), "utf8");

const GOOD = "Fixture-Passphrase-9";
const EMAIL = "ops@example.com";

const codes = (result) => result.problems.map((problem) => problem.code);

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

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

test("a well-formed new password and matching confirmation passes", () => {
  const result = validateNewPassword({ password: GOOD, confirm: GOOD, email: EMAIL });
  assert.equal(result.valid, true);
  assert.deepEqual(result.problems, []);
});

test("a password shorter than the minimum is rejected against the password field", () => {
  const short = "Ab3-short";
  assert.ok(short.length < PASSWORD_MIN_LENGTH);
  const result = validateNewPassword({ password: short, confirm: short, email: EMAIL });

  assert.equal(result.valid, false);
  assert.ok(codes(result).includes(PASSWORD_PROBLEM.TOO_SHORT));
  assert.equal(result.problems[0].field, "password");
  assert.match(result.problems[0].message, new RegExp(String(PASSWORD_MIN_LENGTH)));
});

test("a password past bcrypt's limit is rejected rather than silently truncated", () => {
  // The tail past 72 bytes is not part of the secret at all. A user who is not
  // told that believes in security they do not have.
  const long = `Aa1-${"x".repeat(PASSWORD_MAX_BYTES)}`;
  assert.ok(passwordByteLength(long) > PASSWORD_MAX_BYTES);

  const result = validateNewPassword({ password: long, confirm: long, email: EMAIL });
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes(PASSWORD_PROBLEM.TOO_LONG));
});

test("byte length, not character count, decides the limit", () => {
  // Korean characters are three bytes each in UTF-8, so a 30-character
  // passphrase is already 90 bytes.
  const korean = "가".repeat(30);
  assert.equal(passwordByteLength(korean), 90);
  assert.equal([...korean].length, 30);

  const result = validateNewPassword({ password: korean, confirm: korean, email: EMAIL });
  assert.ok(codes(result).includes(PASSWORD_PROBLEM.TOO_LONG));
});

test("a long enough Korean passphrase within the byte limit is accepted", () => {
  const korean = "가나다라마바사아자차카타파하";
  assert.equal([...korean].length, 14);
  assert.ok(passwordByteLength(`${korean}7`) <= PASSWORD_MAX_BYTES);

  const value = `${korean}7`;
  const result = validateNewPassword({ password: value, confirm: value, email: EMAIL });
  assert.equal(result.valid, true, JSON.stringify(result.problems));
});

test("a single character family is too simple, two is enough", () => {
  const oneClass = "abcdefghijklm";
  assert.ok(oneClass.length >= PASSWORD_MIN_LENGTH);
  assert.ok(codes(validateNewPassword({ password: oneClass, confirm: oneClass, email: EMAIL }))
    .includes(PASSWORD_PROBLEM.TOO_SIMPLE));

  const twoClasses = "abcdefghijk1";
  assert.equal(validateNewPassword({ password: twoClasses, confirm: twoClasses, email: EMAIL }).valid, true);
});

test("one character repeated is rejected however long it is", () => {
  const repeated = "a".repeat(40);
  assert.ok(codes(validateNewPassword({ password: repeated, confirm: repeated, email: EMAIL }))
    .includes(PASSWORD_PROBLEM.TOO_SIMPLE));
});

test("a password containing the email local part is rejected", () => {
  const reused = "ops-Passphrase-9";
  const result = validateNewPassword({ password: reused, confirm: reused, email: "ops@example.com" });
  assert.equal(result.valid, false);
  assert.ok(codes(result).includes(PASSWORD_PROBLEM.CONTAINS_EMAIL));

  // Case does not let it through.
  const shouted = "OPS-Passphrase-9";
  assert.ok(codes(validateNewPassword({ password: shouted, confirm: shouted, email: "ops@example.com" }))
    .includes(PASSWORD_PROBLEM.CONTAINS_EMAIL));
});

test("a very short local part is not treated as a forbidden substring", () => {
  // Otherwise every password containing "a" would be rejected for a@b.com.
  const value = "Fixture-Passphrase-9";
  const result = validateNewPassword({ password: value, confirm: value, email: "a@example.com" });
  assert.equal(result.valid, true, JSON.stringify(result.problems));
});

test("a mismatched confirmation is reported against the confirmation field", () => {
  const result = validateNewPassword({ password: GOOD, confirm: `${GOOD}x`, email: EMAIL });
  assert.equal(result.valid, false);
  const problem = result.problems.find((item) => item.field === "confirm");
  assert.equal(problem.code, PASSWORD_PROBLEM.CONFIRM_MISMATCH);
  assert.ok(problem.message.trim());
});

test("an empty password and an empty confirmation are both reported", () => {
  const result = validateNewPassword({ password: "", confirm: "", email: EMAIL });
  assert.equal(result.valid, false);
  assert.deepEqual(codes(result).sort(), [
    PASSWORD_PROBLEM.CONFIRM_REQUIRED,
    PASSWORD_PROBLEM.REQUIRED,
  ].sort());
});

test("every problem is reported at once, not one per submit", () => {
  const result = validateNewPassword({ password: "ops", confirm: "different", email: "ops@example.com" });
  const found = codes(result);
  assert.ok(found.includes(PASSWORD_PROBLEM.TOO_SHORT));
  assert.ok(found.includes(PASSWORD_PROBLEM.TOO_SIMPLE));
  assert.ok(found.includes(PASSWORD_PROBLEM.CONTAINS_EMAIL));
  assert.ok(found.includes(PASSWORD_PROBLEM.CONFIRM_MISMATCH));
});

test("non-string input is invalid rather than throwing", () => {
  for (const input of [null, undefined, 42, "text", { password: 1, confirm: [] }]) {
    assert.equal(validateNewPassword(input).valid, false);
  }
});

test("no problem message ever echoes the password", () => {
  const secret = "Fixture-Echo-Check-1";
  const result = validateNewPassword({ password: secret, confirm: "no", email: EMAIL });
  for (const problem of result.problems) {
    assert.ok(!problem.message.includes(secret), `message leaked the password: ${problem.message}`);
  }
});

// ---------------------------------------------------------------------------
// Update failure wording
// ---------------------------------------------------------------------------

test("common password-update failures are translated", () => {
  assert.match(describePasswordUpdateError({ message: "New password should be different from the old password." }), /이전/);
  assert.match(describePasswordUpdateError({ message: "Password should contain at least one character of each" }), /정책|기호/);
  assert.match(describePasswordUpdateError({ message: "Password should be at least 8 characters" }), /짧/);
  assert.match(describePasswordUpdateError({ message: "This password has been found in a data breach (pwned)" }), /유출/);
  assert.match(describePasswordUpdateError({ message: "Auth session missing!" }), /인증|초대/);
  assert.match(describePasswordUpdateError({ status: 429, message: "rate limited" }), /잠시|다시/);
  assert.match(describePasswordUpdateError({ message: "Failed to fetch" }), /네트워크|연결/);
});

test("an unknown update failure is surfaced, and nothing is a blank message", () => {
  assert.ok(describePasswordUpdateError({ message: "teapot" }).includes("teapot"));
  assert.ok(describePasswordUpdateError(null).trim());
  assert.ok(describePasswordUpdateError(undefined).trim());
  assert.ok(describePasswordUpdateError({}).trim());
});

// ---------------------------------------------------------------------------
// The pending obligation
// ---------------------------------------------------------------------------

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    size: () => map.size,
  };
}

test("a pending password setup is remembered and then cleared", () => {
  const storage = fakeStorage();
  assert.equal(isPasswordSetupPending("user-1", storage), false);

  markPasswordSetupPending("user-1", storage);
  assert.equal(isPasswordSetupPending("user-1", storage), true);

  clearPasswordSetupPending("user-1", storage);
  assert.equal(isPasswordSetupPending("user-1", storage), false);
  assert.equal(storage.size(), 0);
});

test("the obligation is scoped to one account", () => {
  const storage = fakeStorage();
  markPasswordSetupPending("user-1", storage);
  // A marker left by one account must not follow another into setup.
  assert.equal(isPasswordSetupPending("user-2", storage), false);
});

test("a missing user id never records or reports an obligation", () => {
  const storage = fakeStorage();
  for (const id of ["", null, undefined]) {
    assert.equal(markPasswordSetupPending(id, storage), false);
    assert.equal(isPasswordSetupPending(id, storage), false);
    assert.equal(clearPasswordSetupPending(id, storage), false);
  }
  assert.equal(storage.size(), 0);
});

test("a storage that throws degrades to no obligation instead of breaking the sign-in", () => {
  const hostile = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.equal(markPasswordSetupPending("user-1", hostile), false);
  assert.equal(isPasswordSetupPending("user-1", hostile), false);
  assert.equal(clearPasswordSetupPending("user-1", hostile), false);

  assert.equal(markPasswordSetupPending("user-1", null), false);
  assert.equal(isPasswordSetupPending("user-1", null), false);
});

test("the stored value is a flag, never a credential", async () => {
  const source = await read("src/bibi/pendingPasswordSetup.js");
  assert.match(source, /setItem\(keyFor\(userId\), "1"\)/);
  assert.doesNotMatch(source, /password\s*\)/i, "no password value may reach storage");
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("the workspace client can set the signed-in user's own password", async () => {
  const source = await read("src/cloud/workspaceClient.js");
  assert.match(source, /export function updatePassword/);
  assert.match(source, /auth\.updateUser\(\{ password \}\)/);
  // Still no public registration and no self-service reset by email.
  assert.doesNotMatch(source, /signUp/);
  assert.doesNotMatch(source, /resetPasswordForEmail/);
});

test("the workspace renders a real password-setup form", async () => {
  const source = await read("src/BibiWorkspace.jsx");

  assert.match(source, /function PasswordSetupPanel/);
  assert.match(source, /validateNewPassword/);
  assert.match(source, /updatePassword\(password\)/);
  assert.match(source, /describePasswordUpdateError/);

  assert.match(source, /htmlFor="bibi-new-password"/);
  assert.match(source, /htmlFor="bibi-confirm-password"/);
  // Two fields, both marked as a new password so a manager offers to generate
  // and store one rather than autofilling the old one.
  const newPasswordFields = source.match(/autoComplete="new-password"/g) ?? [];
  assert.equal(newPasswordFields.length, 2);

  assert.match(source, /disabled=\{saving/);
  assert.match(source, /role="alert"/);
  assert.match(source, /aria-invalid/);
});

test("the setup screen is the only thing reachable until the password saves", async () => {
  const source = await read("src/BibiWorkspace.jsx");

  const setupBranch = source.indexOf("if (passwordSetup) {");
  const workspaceReturn = source.search(SIGNED_IN_WORKSPACE_ROOT);
  assert.notEqual(setupBranch, -1, "there must be a password-setup branch");
  assert.notEqual(workspaceReturn, -1, "there must be a signed-in workspace branch");
  assert.ok(setupBranch < workspaceReturn, "setup must short-circuit before the workspace renders");
});

test("an invite session records the obligation and clears it only on success", async () => {
  const source = await read("src/BibiWorkspace.jsx");

  assert.match(source, /markPasswordSetupPending\(next\.user\?\.id\)/);
  assert.match(source, /isPasswordSetupPending\(current\.user\?\.id\)/);
  // Cleared in the success handler, nowhere else.
  const clears = source.match(/clearPasswordSetupPending\(/g) ?? [];
  assert.equal(clears.length, 1, "the obligation must be discharged in exactly one place");
  const handler = source.slice(source.indexOf("const handlePasswordSet"), source.indexOf("const handleSignOut"));
  assert.ok(handler.includes("clearPasswordSetupPending"), "it must be the success handler that clears it");
});

test("a user mid-setup can always get out", async () => {
  const source = await read("src/BibiWorkspace.jsx");
  assert.match(source, /onAbandon=\{handleSignOut\}/);
  assert.match(source, /className="bibi-signout bibi-abandon"/);
});

test("the setup screen tells the user not to hand the password to anyone", async () => {
  const source = await read("src/BibiWorkspace.jsx");
  assert.match(source, /누구에게도.*입력해 전달하지 마세요|어떤 대화창에도/);
});

test("the password form has responsive rules at both phone widths", async () => {
  const css = await read("src/bibiWorkspace.css");
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /@media \(max-width: 380px\)/);
  assert.match(css, /\.bibi-field-hint/);
  assert.match(css, /\.bibi-notice/);
});
