/**
 * The rules a newly chosen password has to clear, and the wording used when it
 * does not.
 *
 * This runs entirely in the browser and decides nothing on its own — Supabase
 * remains the authority, and a password this module accepts can still be
 * refused server-side. Its job is to catch the mistakes that are worth catching
 * before a round trip, and in particular the one mistake the server will *not*
 * report: bcrypt, which GoTrue hashes with, ignores everything past 72 bytes.
 * A 90-character passphrase would be silently truncated, and the user would
 * never learn that a third of what they typed was decoration.
 *
 * The password itself is only ever read here. It is not logged, not stored, not
 * echoed into a message, and not included in anything this module returns
 * beyond the caller's own value.
 */

export const PASSWORD_PROBLEM = Object.freeze({
  REQUIRED: "PASSWORD_REQUIRED",
  TOO_SHORT: "PASSWORD_TOO_SHORT",
  TOO_LONG: "PASSWORD_TOO_LONG",
  TOO_SIMPLE: "PASSWORD_TOO_SIMPLE",
  CONTAINS_EMAIL: "PASSWORD_CONTAINS_EMAIL",
  CONFIRM_REQUIRED: "PASSWORD_CONFIRM_REQUIRED",
  CONFIRM_MISMATCH: "PASSWORD_CONFIRM_MISMATCH",
});

/** Comfortably above Supabase's default of six; short enough to be typable. */
export const PASSWORD_MIN_LENGTH = 12;

/** bcrypt's input limit. Past this the tail is not part of the secret at all. */
export const PASSWORD_MAX_BYTES = 72;

const encoder = new TextEncoder();

export function passwordByteLength(password) {
  return encoder.encode(String(password ?? "")).length;
}

/**
 * How many of the four character families appear. Two is the bar — enough to
 * rule out a single run of lowercase letters, low enough that a real passphrase
 * with one capital or one digit is not rejected for failing a puzzle.
 */
function characterClasses(password) {
  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/\d/.test(password)) classes += 1;
  if (/[^a-zA-Z\d]/.test(password)) classes += 1;
  return classes;
}

function isSingleRepeatedCharacter(password) {
  const characters = [...password];
  return characters.length > 1 && characters.every((character) => character === characters[0]);
}

/** The part of an address before the `@`, which is the part people reuse. */
function emailLocalPart(email) {
  const value = typeof email === "string" ? email.trim().toLowerCase() : "";
  const at = value.indexOf("@");
  return at > 0 ? value.slice(0, at) : value;
}

/**
 * Check a new password and its confirmation.
 *
 * Returns every problem it finds rather than the first, so the form can show
 * the whole picture in one pass instead of making the user discover the rules
 * one failed submit at a time.
 */
export function validateNewPassword(input) {
  const password = typeof input?.password === "string" ? input.password : "";
  const confirm = typeof input?.confirm === "string" ? input.confirm : "";
  const email = typeof input?.email === "string" ? input.email : "";
  const problems = [];

  if (!password) {
    problems.push({
      field: "password",
      code: PASSWORD_PROBLEM.REQUIRED,
      message: "새 비밀번호를 입력하세요.",
    });
  } else {
    if ([...password].length < PASSWORD_MIN_LENGTH) {
      problems.push({
        field: "password",
        code: PASSWORD_PROBLEM.TOO_SHORT,
        message: `비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상이어야 합니다.`,
      });
    }

    if (passwordByteLength(password) > PASSWORD_MAX_BYTES) {
      problems.push({
        field: "password",
        code: PASSWORD_PROBLEM.TOO_LONG,
        message: `비밀번호가 너무 깁니다. ${PASSWORD_MAX_BYTES}바이트까지만 실제로 저장됩니다. 조금 줄여 주세요.`,
      });
    }

    if (characterClasses(password) < 2 || isSingleRepeatedCharacter(password)) {
      problems.push({
        field: "password",
        code: PASSWORD_PROBLEM.TOO_SIMPLE,
        message: "영문 대소문자·숫자·기호 중 두 종류 이상을 섞어 주세요.",
      });
    }

    const local = emailLocalPart(email);
    if (local.length >= 3 && password.toLowerCase().includes(local)) {
      problems.push({
        field: "password",
        code: PASSWORD_PROBLEM.CONTAINS_EMAIL,
        message: "비밀번호에 이메일 주소를 포함할 수 없습니다.",
      });
    }
  }

  if (!confirm) {
    problems.push({
      field: "confirm",
      code: PASSWORD_PROBLEM.CONFIRM_REQUIRED,
      message: "확인을 위해 비밀번호를 한 번 더 입력하세요.",
    });
  } else if (password && confirm !== password) {
    problems.push({
      field: "confirm",
      code: PASSWORD_PROBLEM.CONFIRM_MISMATCH,
      message: "두 비밀번호가 서로 다릅니다.",
    });
  }

  return { valid: problems.length === 0, problems };
}

const UPDATE_ERROR_RULES = [
  [/should be different from the old password|same.*password/i, "이전과 다른 비밀번호를 사용하세요."],
  [/at least one character of each|password.*requirement|weak password/i, "비밀번호가 서버 정책을 충족하지 않습니다. 대소문자·숫자·기호를 섞어 다시 시도하세요."],
  [/password should be at least/i, `비밀번호가 너무 짧습니다. ${PASSWORD_MIN_LENGTH}자 이상으로 다시 시도하세요.`],
  [/pwned|leaked|compromised/i, "유출 이력이 있는 비밀번호입니다. 다른 비밀번호를 사용하세요."],
  [/session|jwt|token|not authenticated|auth session missing/i, "인증이 만료되었습니다. 초대 링크를 다시 열어 주세요."],
  [/too many requests|rate limit/i, "요청이 너무 잦습니다. 잠시 후 다시 시도하세요."],
  [/failed to fetch|networkerror|load failed/i, "네트워크 연결에 실패했습니다. 연결 상태를 확인하세요."],
];

/**
 * Wording for a rejected password update.
 *
 * Unlike a failed sign-in, there is nothing to conceal here: the visitor is
 * already authenticated and is being told why their own change did not take.
 * An unrecognised cause is therefore surfaced rather than flattened, because
 * the person reading it is the person who has to act on it. What is never
 * surfaced is the password.
 */
export function describePasswordUpdateError(error) {
  if (!error) return "비밀번호를 저장하지 못했습니다.";
  const message = String(error.message ?? error ?? "").trim();

  if (Number(error.status) === 429) return "요청이 너무 잦습니다. 잠시 후 다시 시도하세요.";
  for (const [pattern, text] of UPDATE_ERROR_RULES) {
    if (pattern.test(message)) return text;
  }
  return message ? `비밀번호를 저장하지 못했습니다: ${message}` : "비밀번호를 저장하지 못했습니다.";
}
