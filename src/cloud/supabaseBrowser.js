/**
 * The browser's Supabase client.
 *
 * Created lazily and only from a configuration that has already passed the key
 * checks in `env.js`. An unconfigured or misconfigured workspace gets `null`
 * rather than a half-built client, so the UI has one thing to branch on and
 * renders an honest offline state instead of failing at the first query.
 */

import { createClient } from "@supabase/supabase-js";
import { resolveClientConfig } from "./env.js";

function browserEnv() {
  // `import.meta.env` is Vite's inlined environment. Outside a Vite build it is
  // undefined, and an empty object resolves to "unconfigured", which is correct.
  return import.meta.env ?? {};
}

let cachedConfig = null;
let cachedClient = null;

export function getCloudConfig(env = browserEnv()) {
  if (!cachedConfig) cachedConfig = resolveClientConfig(env);
  return cachedConfig;
}

export function getSupabaseClient(env = browserEnv()) {
  if (cachedClient) return cachedClient;
  const config = getCloudConfig(env);
  if (!config.configured) return null;

  cachedClient = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
    realtime: {
      // Enough to follow a busy work board without flooding a laptop tab.
      params: { eventsPerSecond: 10 },
    },
  });
  return cachedClient;
}

/** Test and hot-reload seam; production code never needs this. */
export function resetSupabaseClient() {
  cachedConfig = null;
  cachedClient = null;
}
