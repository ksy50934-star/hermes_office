import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTH_PROBLEM,
  describeAuthError,
  validateCredentials,
} from "../src/bibi/authForm.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFile(path.join(projectRoot, relative), "utf8");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("a well-formed credential pair passes", () => {
  const result = validateCredentials({ email: "ops@example.com", password: "correct horse" });
  assert.equal(result.valid, true);
  assert.deepEqual(result.problems, []);
});

test("surrounding whitespace in an email does not make it invalid", () => {
  const result = validateCredentials({ email: "  ops@example.com  ", password: "password1" });
  assert.equal(result.valid, true);
  assert.equal(result.email, "ops@example.com");
});

test("a missing or malformed email is reported against the email field", () => {
  for (const [email, code] of [
    ["", AUTH_PROBLEM.EMAIL_REQUIRED],
    ["   ", AUTH_PROBLEM.EMAIL_REQUIRED],
    [null, AUTH_PROBLEM.EMAIL_REQUIRED],
    ["not-an-email", AUTH_PROBLEM.EMAIL_INVALID],
    ["ops@", AUTH_PROBLEM.EMAIL_INVALID],
    ["@example.com", AUTH_PROBLEM.EMAIL_INVALID],
    ["ops example@x.com", AUTH_PROBLEM.EMAIL_INVALID],
  ]) {
    const result = validateCredentials({ email, password: "password1" });
    assert.equal(result.valid, false, `${String(email)} must be invalid`);
    const problem = result.problems.find((item) => item.field === "email");
    assert.ok(problem, `${String(email)} needs an email problem`);
    assert.equal(problem.code, code);
    assert.ok(problem.message.trim());
  }
});

test("a missing password is reported against the password field", () => {
  for (const password of ["", null, undefined]) {
    const result = validateCredentials({ email: "ops@example.com", password });
    assert.equal(result.valid, false);
    const problem = result.problems.find((item) => item.field === "password");
    assert.equal(problem.code, AUTH_PROBLEM.PASSWORD_REQUIRED);
  }
});

test("a password is never trimmed, because leading space can be deliberate", () => {
  const result = validateCredentials({ email: "ops@example.com", password: "  spaced  " });
  assert.equal(result.valid, true);
  assert.equal(result.password, "  spaced  ");
});

test("both fields can be reported at once", () => {
  const result = validateCredentials({ email: "", password: "" });
  assert.equal(result.problems.length, 2);
  assert.deepEqual(result.problems.map((problem) => problem.field).sort(), ["email", "password"]);
});

test("a non-object input is invalid rather than throwing", () => {
  for (const input of [null, undefined, "ops@example.com", 42]) {
    assert.equal(validateCredentials(input).valid, false);
  }
});

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------

test("a wrong password is explained without revealing whether the account exists", () => {
  const message = describeAuthError({ message: "Invalid login credentials" });
  assert.match(message, /이메일|비밀번호/);
  // Must not disclose which of the two was wrong.
  assert.ok(!/없는 계정|가입되지/.test(message));
});

test("common Supabase auth failures are translated", () => {
  assert.match(describeAuthError({ message: "Email not confirmed" }), /확인/);
  assert.match(describeAuthError({ message: "Email logins are disabled" }), /이메일/);
  assert.match(describeAuthError({ status: 429, message: "Too many requests" }), /잠시|다시/);
  assert.match(describeAuthError({ message: "Failed to fetch" }), /네트워크|연결/);
});

test("an unrecognised failure still says something specific rather than nothing", () => {
  const message = describeAuthError({ message: "teapot" });
  assert.ok(message.includes("teapot"), "an unknown cause must not be swallowed");
  assert.ok(describeAuthError(null).trim());
  assert.ok(describeAuthError(undefined).trim());
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("the workspace client exposes sign-in and sign-out and no sign-up", async () => {
  const client = await read("src/cloud/workspaceClient.js");
  assert.match(client, /export function signInWithPassword/);
  assert.match(client, /export function signOut/);
  // Accounts are provisioned by the owner; the app must never open a public
  // registration path.
  assert.doesNotMatch(client, /signUp/);
  assert.doesNotMatch(client, /resetPasswordForEmail|signInWithOtp|signInWithOAuth/);
});

test("the workspace renders a real sign-in form wired to Supabase", async () => {
  const source = await read("src/BibiWorkspace.jsx");

  assert.match(source, /signInWithPassword/);
  assert.match(source, /validateCredentials/);
  assert.match(source, /describeAuthError/);

  // A real form, not a notice telling the user to sign in elsewhere.
  assert.match(source, /<form[^>]*className="bibi-signin"/);
  assert.match(source, /type="email"/);
  assert.match(source, /type="password"/);
  assert.match(source, /autoComplete="email"/);
  assert.match(source, /autoComplete="current-password"/);
  assert.match(source, /htmlFor="bibi-signin-email"/);
  assert.match(source, /htmlFor="bibi-signin-password"/);
});

test("sign-in errors and per-field problems are shown to the user", async () => {
  const source = await read("src/BibiWorkspace.jsx");
  assert.match(source, /role="alert"/);
  assert.match(source, /aria-invalid/);
  // The submit button must be disabled while a sign-in is in flight, so a
  // double submit cannot fire two requests.
  assert.match(source, /disabled=\{signingIn/);
});

test("a signed-in user can sign out from the workspace", async () => {
  const source = await read("src/BibiWorkspace.jsx");
  assert.match(source, /signOut/);
  assert.match(source, /className="bibi-signout"/);
});

test("the workspace offers no public sign-up anywhere", async () => {
  const source = await read("src/BibiWorkspace.jsx");
  assert.doesNotMatch(source, /signUp/);
  assert.doesNotMatch(source, /회원가입|가입하기/);
});
