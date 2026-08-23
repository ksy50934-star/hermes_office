/**
 * Server-only environment for the Vercel functions.
 *
 * These variables must never carry the `VITE_` prefix: Vite inlines that prefix
 * into the browser bundle, so a service-role key named that way is published the
 * moment the site builds. The check below is not decoration — it is the last
 * place the mistake can be caught before deploy.
 */

export class ServerEnvError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ServerEnvError";
    this.code = code;
  }
}

function required(env, key) {
  const value = String(env?.[key] ?? "").trim();
  if (!value) throw new ServerEnvError(`${key} is not configured.`, "MISSING_ENV");
  return value;
}

export function loadServerEnv(env = process.env) {
  // A client-visible alias of a privileged key is fatal even if the correct
  // server variable is also present, because the alias is what ships.
  for (const key of Object.keys(env ?? {})) {
    if (key.startsWith("VITE_") && /(SERVICE_ROLE|SERVICE_KEY|SECRET)/i.test(key) && String(env[key] ?? "").trim()) {
      throw new ServerEnvError(
        `${key} would be inlined into the browser bundle. Remove the VITE_ prefix.`,
        "PRIVILEGED_KEY_EXPOSED",
      );
    }
  }

  return {
    supabaseUrl: required(env, "SUPABASE_URL"),
    // Bypasses row level security. Only ever read here, only ever used from a
    // serverless function, never returned to a caller.
    supabaseServiceRoleKey: required(env, "SUPABASE_SERVICE_ROLE_KEY"),
    leaseTtlMs: Number(env?.BIBI_LEASE_TTL_MS ?? 300_000),
    maxLeaseBatch: Number(env?.BIBI_MAX_LEASE_BATCH ?? 4),
  };
}
