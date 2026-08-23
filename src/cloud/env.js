/**
 * Client-side cloud configuration, and the boundary that keeps a privileged
 * Supabase key out of the browser bundle.
 *
 * Vite inlines every `VITE_`-prefixed variable into the shipped JavaScript, so
 * "don't put the service-role key in the client" cannot be a convention — by the
 * time it is wrong, the key is already published. This module classifies the key
 * it is handed and refuses anything privileged, and it reports a privileged
 * *variable name* as fatal even when the value looks harmless, because the name
 * is what a future operator will fill in.
 *
 * This is the one module in `src/` allowed to name these patterns; it names them
 * in order to reject them.
 */

export class CloudConfigError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CloudConfigError";
    this.code = code;
  }
}

const CLIENT_PREFIX = "VITE_";
const PRIVILEGED_NAME_PATTERN = /(SERVICE_ROLE|SERVICE_KEY|SECRET)/i;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

const CLIENT_SAFE_ROLES = new Set(["anon", "publishable"]);
const PRIVILEGED_ROLES = new Set(["service_role", "secret"]);

function decodeJwtRole(key) {
  const segments = key.split(".");
  if (segments.length !== 3) return "unknown";
  try {
    const payload = JSON.parse(atob(segments[1].replace(/-/g, "+").replace(/_/g, "/")));
    const role = typeof payload?.role === "string" ? payload.role.trim() : "";
    return role || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Classify a Supabase key. Covers both the legacy JWT keys, whose privilege is
 * in the `role` claim, and the newer prefixed keys, whose privilege is in the
 * prefix.
 */
export function describeKeyRole(key) {
  const value = typeof key === "string" ? key.trim() : "";
  if (!value) return "unknown";
  if (value.startsWith("sb_publishable_")) return "publishable";
  if (value.startsWith("sb_secret_")) return "secret";
  if (value.startsWith("eyJ")) return decodeJwtRole(value);
  return "unknown";
}

export function assertClientSafeKey(key) {
  const role = describeKeyRole(key);
  if (PRIVILEGED_ROLES.has(role)) {
    throw new CloudConfigError(
      `권한이 큰 Supabase 키(${role})는 브라우저에 넣을 수 없습니다. anon 또는 publishable 키만 사용하세요.`,
      "SERVICE_ROLE_KEY_IN_CLIENT",
    );
  }
  if (!CLIENT_SAFE_ROLES.has(role)) {
    throw new CloudConfigError(
      "Supabase 키를 인식할 수 없습니다. 값이 잘린 것은 아닌지 확인하세요.",
      "UNRECOGNISED_KEY",
    );
  }
  return key;
}

function isAcceptableUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" || LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the browser's cloud configuration. Never throws: an unconfigured
 * workspace has to render, and it renders as offline with a stated reason
 * rather than as a blank screen or a crash.
 */
export function resolveClientConfig(env = {}) {
  const problems = [];
  const read = (key) => String(env?.[key] ?? "").trim();

  for (const key of Object.keys(env ?? {})) {
    if (key.startsWith(CLIENT_PREFIX) && PRIVILEGED_NAME_PATTERN.test(key) && read(key)) {
      problems.push({
        code: "PRIVILEGED_KEY_EXPOSED",
        message: `${key}는 브라우저 번들에 그대로 포함됩니다. ${CLIENT_PREFIX} 접두사를 떼고 서버 전용 변수로 옮기세요.`,
      });
    }
  }

  const url = read("VITE_SUPABASE_URL");
  if (!url) {
    problems.push({ code: "MISSING_SUPABASE_URL", message: "VITE_SUPABASE_URL이 설정되지 않았습니다." });
  } else if (!isAcceptableUrl(url)) {
    problems.push({
      code: "INSECURE_SUPABASE_URL",
      message: `VITE_SUPABASE_URL은 https여야 합니다: ${url}`,
    });
  }

  const anonKey = read("VITE_SUPABASE_ANON_KEY");
  if (!anonKey) {
    problems.push({ code: "MISSING_SUPABASE_ANON_KEY", message: "VITE_SUPABASE_ANON_KEY가 설정되지 않았습니다." });
  } else {
    try {
      assertClientSafeKey(anonKey);
    } catch (error) {
      problems.push({ code: error.code, message: error.message });
    }
  }

  const configured = problems.length === 0;
  return {
    configured,
    url: configured ? url : null,
    // A key is only handed back once it has passed every check, so a caller
    // cannot accidentally use a rejected one.
    anonKey: configured ? anonKey : null,
    problems,
  };
}
