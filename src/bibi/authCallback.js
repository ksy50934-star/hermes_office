/**
 * What the browser was handed when it came back from an official invite link.
 *
 * An invited user never types a password to get in the first time. They follow
 * a link Supabase mailed them, and Supabase bounces them back here carrying
 * proof of that click. Which shape that proof takes is not ours to choose — it
 * depends on the auth flow and on how the email template was rendered — so this
 * module recognises all four shapes rather than betting on one:
 *
 *   1. implicit  `#access_token=…&refresh_token=…&type=invite`
 *   2. token hash `?token_hash=…&type=invite`   (template emits `.TokenHash`)
 *   3. PKCE       `?code=…`
 *   4. failure    `#error=access_denied&error_code=otp_expired&…`
 *
 * Two rules shape everything below.
 *
 * A failure is recognised *before* a success. Supabase can return an error in
 * the same fragment position a token would occupy, and an expired invite that
 * were read as a session would drop an unauthenticated visitor into a screen
 * that promises them an account.
 *
 * Nothing here is logged and no message ever embeds a token. The parsed result
 * carries secrets; the human-facing text derived from it carries none. That
 * separation is the reason the wording lives in this module rather than being
 * built from whatever the server happened to say.
 */

/** The shape of proof the link came back with. */
export const AUTH_CALLBACK = Object.freeze({
  NONE: "NONE",
  TOKENS: "TOKENS",
  TOKEN_HASH: "TOKEN_HASH",
  CODE: "CODE",
  ERROR: "ERROR",
});

/** What the visitor is here to do, once the proof checks out. */
export const CALLBACK_INTENT = Object.freeze({
  /** First arrival from an invite: they have no password yet. */
  INVITE: "INVITE",
  /** A deliberate reset: they have one and are replacing it. */
  RECOVERY: "RECOVERY",
  /** A link that only signs in; nothing to set. */
  SIGN_IN: "SIGN_IN",
});

/**
 * Every parameter name the auth handshake may put in a URL. Used to scrub the
 * address bar afterwards, so the list has to stay complete rather than minimal:
 * a name missing here is a token left in the user's history.
 */
const AUTH_PARAM_NAMES = Object.freeze([
  "access_token",
  "refresh_token",
  "expires_in",
  "expires_at",
  "token_type",
  "provider_token",
  "provider_refresh_token",
  "token_hash",
  "code",
  "type",
  "error",
  "error_code",
  "error_description",
]);

const INTENT_BY_TYPE = Object.freeze({
  invite: CALLBACK_INTENT.INVITE,
  // A confirmed sign-up arrives with no password set for the same reason an
  // invite does, so it is treated identically rather than waved through.
  signup: CALLBACK_INTENT.INVITE,
  recovery: CALLBACK_INTENT.RECOVERY,
  magiclink: CALLBACK_INTENT.SIGN_IN,
  email_change: CALLBACK_INTENT.SIGN_IN,
});

const NONE = Object.freeze({
  kind: AUTH_CALLBACK.NONE,
  intent: CALLBACK_INTENT.SIGN_IN,
  type: "",
  tokens: null,
  tokenHash: "",
  code: "",
  errorCode: "",
});

function paramsOf(text) {
  const value = typeof text === "string" ? text.replace(/^[#?]/, "") : "";
  return new URLSearchParams(value);
}

function read(params, name) {
  const value = params.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** The fragment is checked first because that is where the implicit flow lands. */
function firstOf(name, hash, query) {
  return read(hash, name) || read(query, name);
}

function intentFor(type) {
  return INTENT_BY_TYPE[type] ?? CALLBACK_INTENT.SIGN_IN;
}

/**
 * Classify the current URL. Never throws and never partially reports: an input
 * it cannot make sense of is `NONE`, which renders the ordinary sign-in screen.
 */
export function parseAuthCallback(href) {
  let hash;
  let query;
  try {
    const url = new URL(String(href));
    hash = paramsOf(url.hash);
    query = paramsOf(url.search);
  } catch {
    return NONE;
  }

  const type = firstOf("type", hash, query).toLowerCase();
  const intent = intentFor(type);

  // Failure first. See the module note: an expired invite must never be able to
  // wear the shape of a session.
  const errorName = firstOf("error", hash, query);
  const errorCode = firstOf("error_code", hash, query);
  if (errorName || errorCode) {
    return {
      kind: AUTH_CALLBACK.ERROR,
      intent,
      type,
      tokens: null,
      tokenHash: "",
      code: "",
      // The machine-readable code only. `error_description` is server prose and
      // is deliberately dropped rather than shown.
      errorCode: (errorCode || errorName).toLowerCase(),
    };
  }

  const accessToken = firstOf("access_token", hash, query);
  const refreshToken = firstOf("refresh_token", hash, query);
  if (accessToken && refreshToken) {
    return {
      kind: AUTH_CALLBACK.TOKENS,
      intent,
      type,
      tokens: { accessToken, refreshToken },
      tokenHash: "",
      code: "",
      errorCode: "",
    };
  }

  const tokenHash = firstOf("token_hash", hash, query);
  if (tokenHash) {
    return {
      kind: AUTH_CALLBACK.TOKEN_HASH,
      intent,
      type,
      tokens: null,
      tokenHash,
      code: "",
      errorCode: "",
    };
  }

  const code = firstOf("code", hash, query);
  if (code) {
    return {
      kind: AUTH_CALLBACK.CODE,
      intent,
      type,
      tokens: null,
      tokenHash: "",
      code,
      errorCode: "",
    };
  }

  // An access token with no refresh token is a truncated link, not a session.
  return NONE;
}

/** Did the link carry anything the app has to act on before rendering? */
export function isAuthCallback(callback) {
  return Boolean(callback) && callback.kind !== AUTH_CALLBACK.NONE;
}

/**
 * Whether the visitor still owes us a password. True for an invite and for a
 * recovery; false for a link that merely signs someone in.
 *
 * This is derived from the *link*, never from the session, which is what keeps
 * an ordinary returning user out of the setup screen.
 */
export function requiresPasswordSetup(callback) {
  if (!callback) return false;
  if (callback.kind !== AUTH_CALLBACK.TOKENS
    && callback.kind !== AUTH_CALLBACK.TOKEN_HASH
    && callback.kind !== AUTH_CALLBACK.CODE) return false;
  return callback.intent === CALLBACK_INTENT.INVITE
    || callback.intent === CALLBACK_INTENT.RECOVERY;
}

/**
 * The same URL with every auth parameter removed, preserving the rest of the
 * route. Called before the tokens are used, so a copied address bar, a shared
 * screen or a browser history entry never carries a credential.
 */
export function strippedUrl(href) {
  let url;
  try {
    url = new URL(String(href));
  } catch {
    return typeof href === "string" ? href : "";
  }

  const query = url.searchParams;
  const hash = paramsOf(url.hash);
  for (const name of AUTH_PARAM_NAMES) {
    query.delete(name);
    hash.delete(name);
  }

  const hashText = hash.toString();
  url.hash = hashText ? `#${hashText}` : "";
  return `${url.pathname}${url.search}${url.hash}`;
}

const CALLBACK_ERROR_TEXT = Object.freeze({
  otp_expired: "초대 링크가 만료되었거나 이미 사용되었습니다. 소유자에게 새 초대를 요청하세요.",
  access_denied: "초대 링크를 확인할 수 없습니다. 소유자에게 새 초대를 요청하세요.",
  flow_state_expired: "초대 링크가 만료되었습니다. 소유자에게 새 초대를 요청하세요.",
  flow_state_not_found: "이 브라우저에서는 링크를 확인할 수 없습니다. 초대 메일을 받은 브라우저에서 다시 열어 주세요.",
  bad_code_verifier: "이 브라우저에서는 링크를 확인할 수 없습니다. 초대 메일을 받은 브라우저에서 다시 열어 주세요.",
  validation_failed: "초대 링크를 확인할 수 없습니다. 소유자에게 새 초대를 요청하세요.",
  unauthorized_client: "초대 링크를 확인할 수 없습니다. 소유자에게 새 초대를 요청하세요.",
  server_error: "인증 서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도하세요.",
});

const CALLBACK_FALLBACK = "초대 링크를 확인할 수 없습니다. 소유자에게 새 초대를 요청하세요.";

/**
 * Human wording for a failed callback.
 *
 * Every branch says roughly the same thing on purpose. Whether the link expired,
 * was already redeemed, or never named a real account is exactly the difference
 * an attacker probing addresses would like to learn, and is a difference the
 * invited user can do nothing with either way: the fix is always "ask for a new
 * invite". The only variation is where it changes what the *user* should do
 * next — reopening the link in a different browser.
 */
export function describeCallbackError(callback) {
  const code = typeof callback?.errorCode === "string" ? callback.errorCode.toLowerCase() : "";
  return CALLBACK_ERROR_TEXT[code] ?? CALLBACK_FALLBACK;
}

/** Wording for a callback that parsed but that Supabase then refused. */
export function describeCallbackFailure() {
  return CALLBACK_FALLBACK;
}

export { AUTH_PARAM_NAMES };
