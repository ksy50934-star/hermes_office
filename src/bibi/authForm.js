/**
 * Sign-in form validation and error wording.
 *
 * Kept out of the component so the rules are testable on their own, and so the
 * wording of a failed sign-in is decided in one place rather than scattered
 * through JSX.
 *
 * This workspace has exactly one account, provisioned by the owner. There is no
 * registration, no password reset and no social sign-in, so nothing here needs
 * to distinguish "no such account" from "wrong password" — and deliberately
 * does not, since that difference is worth nothing to the owner and something
 * to anyone else.
 */

export const AUTH_PROBLEM = Object.freeze({
  EMAIL_REQUIRED: "EMAIL_REQUIRED",
  EMAIL_INVALID: "EMAIL_INVALID",
  PASSWORD_REQUIRED: "PASSWORD_REQUIRED",
});

/**
 * Deliberately loose: the server is the authority on whether an address is
 * real. This only catches the typo class of mistake before a round trip.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateCredentials(input) {
  if (!input || typeof input !== "object") {
    return {
      valid: false,
      email: "",
      password: "",
      problems: [
        { field: "email", code: AUTH_PROBLEM.EMAIL_REQUIRED, message: "이메일을 입력하세요." },
        { field: "password", code: AUTH_PROBLEM.PASSWORD_REQUIRED, message: "비밀번호를 입력하세요." },
      ],
    };
  }

  const email = typeof input.email === "string" ? input.email.trim() : "";
  // Never trimmed: a leading or trailing space can be part of a real password.
  const password = typeof input.password === "string" ? input.password : "";
  const problems = [];

  if (!email) {
    problems.push({ field: "email", code: AUTH_PROBLEM.EMAIL_REQUIRED, message: "이메일을 입력하세요." });
  } else if (!EMAIL_PATTERN.test(email)) {
    problems.push({ field: "email", code: AUTH_PROBLEM.EMAIL_INVALID, message: "이메일 형식이 올바르지 않습니다." });
  }

  if (!password) {
    problems.push({ field: "password", code: AUTH_PROBLEM.PASSWORD_REQUIRED, message: "비밀번호를 입력하세요." });
  }

  return { valid: problems.length === 0, email, password, problems };
}

export function problemFor(problems, field) {
  return (problems ?? []).find((problem) => problem.field === field) ?? null;
}

const ERROR_RULES = [
  [/invalid login credentials/i, "이메일 또는 비밀번호가 올바르지 않습니다."],
  [/email not confirmed/i, "이메일 확인이 완료되지 않은 계정입니다."],
  [/email logins are disabled|email provider/i, "이메일 로그인이 비활성화되어 있습니다. Supabase 인증 설정을 확인하세요."],
  [/too many requests|rate limit/i, "요청이 너무 잦습니다. 잠시 후 다시 시도하세요."],
  [/failed to fetch|networkerror|load failed/i, "네트워크 연결에 실패했습니다. 연결 상태를 확인하세요."],
];

export function describeAuthError(error) {
  if (!error) return "로그인에 실패했습니다.";
  const message = String(error.message ?? error ?? "").trim();

  if (Number(error.status) === 429) return "요청이 너무 잦습니다. 잠시 후 다시 시도하세요.";
  for (const [pattern, text] of ERROR_RULES) {
    if (pattern.test(message)) return text;
  }
  // An unrecognised cause is surfaced rather than hidden behind a generic
  // sentence, because the owner is the person who has to fix it.
  return message ? `로그인에 실패했습니다: ${message}` : "로그인에 실패했습니다.";
}
