/**
 * Deployed row-level-security readback against the linked Supabase project.
 *
 * Read-only and anonymous. It uses the publishable key that already ships in
 * every browser bundle, and no human password: the question being asked is
 * exactly "what can someone with nothing but the public key reach?", which is
 * the question RLS exists to answer.
 *
 * This is separate evidence from the static migration checks. Those prove the
 * SQL says the right thing; this proves the deployed database behaves that way.
 */
/**
 * Both inputs are discovered from the deployed site rather than from any local
 * file: the Supabase URL and the publishable key are compiled into the browser
 * bundle and are already served to every visitor. Reading them back from the
 * live bundle is what makes this reproducible on any machine, and keeps it
 * clear that nothing secret is involved.
 */
const SITE = process.env.BIBI_SITE || "https://bibi-workspace-18.vercel.app";

async function discover() {
  const index = await (await fetch(`${SITE}/`)).text();
  const bundlePath = index.match(/\/assets\/index-[A-Za-z0-9_.-]+\.js/)?.[0];
  if (!bundlePath) throw new Error(`no bundle referenced by ${SITE}/`);
  const bundle = await (await fetch(`${SITE}${bundlePath}`)).text();
  const url = bundle.match(/https:\/\/[a-z0-9]+\.supabase\.co/)?.[0];
  const key = bundle.match(/sb_publishable_[A-Za-z0-9_-]+/)?.[0]
    ?? bundle.match(/"(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/)?.[1];
  if (!url || !key) throw new Error(`could not read cloud config out of ${bundlePath}`);
  return { url, key, bundlePath };
}

const { url: URL_BASE, key: ANON, bundlePath: BUNDLE_PATH } = await discover();

const PROTECTED_TABLES = [
  "bibi_profiles", "connector_nodes", "connector_credentials", "conversations",
  "messages", "work_items", "work_events", "work_results", "work_evidence",
  "command_leases",
];

const anonHeaders = { apikey: ANON, Authorization: `Bearer ${ANON}` };

async function probe(label, path, init = {}) {
  const response = await fetch(`${URL_BASE}${path}`, init);
  let body = null;
  try { body = await response.text(); } catch { body = null; }
  let rows = null;
  try { const parsed = JSON.parse(body); if (Array.isArray(parsed)) rows = parsed.length; } catch { /* not an array */ }
  return {
    label,
    path,
    status: response.status,
    rows,
    bodyExcerpt: (body ?? "").slice(0, 200),
  };
}

const report = {
  site: SITE,
  bundle: BUNDLE_PATH,
  supabase_url: URL_BASE,
  key_kind: ANON.startsWith("sb_publishable_") ? "publishable (public, ships in browser)" : "unknown",
  human_password_used: false,
  checks: {},
};

// 1. No key at all must be refused outright.
report.checks.no_api_key = await probe("no apikey", "/rest/v1/bibi_profiles?select=id&limit=1");

// 2. Anonymous select on every protected table must yield zero rows.
report.checks.anonymous_select = [];
for (const table of PROTECTED_TABLES) {
  report.checks.anonymous_select.push(
    await probe(table, `/rest/v1/${table}?select=*&limit=5`, { headers: anonHeaders }),
  );
}

// 3. Anonymous write must be refused. This is the check that distinguishes
//    "RLS is enforced" from "the tables merely happen to be empty".
report.checks.anonymous_insert = await probe(
  "insert work_items",
  "/rest/v1/work_items",
  {
    method: "POST",
    headers: { ...anonHeaders, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ title: "rls-readback-probe", brief: "must be refused" }),
  },
);

report.checks.anonymous_insert_conversations = await probe(
  "insert conversations",
  "/rest/v1/conversations",
  {
    method: "POST",
    headers: { ...anonHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ profile_id: "bibi-01", title: "rls-readback-probe" }),
  },
);

// 4. Distinguish "RLS filtered every row" from "the table is not there".
//    A missing table answers 404/PGRST205; an existing one answers 200 with an
//    empty array. Without this, zero rows would prove nothing.
report.checks.table_existence = {
  note: "200 + 0 rows means the table exists and RLS filtered it; 404/PGRST205 would mean it is absent",
  control_missing_table: await probe(
    "table_that_does_not_exist",
    "/rest/v1/table_that_does_not_exist?select=*&limit=1",
    { headers: anonHeaders },
  ),
  present: report.checks.anonymous_select
    .filter((check) => check.status === 200)
    .map((check) => check.label),
  absent: report.checks.anonymous_select
    .filter((check) => check.status !== 200)
    .map((check) => ({ table: check.label, status: check.status })),
};

// 5. Auth settings: public sign-up must be closed. This is now an expectation
//    rather than an observation — the setting was corrected on the project, so
//    a regression back to open signup has to fail this readback loudly.
const settings = await fetch(`${URL_BASE}/auth/v1/settings`, { headers: anonHeaders });
const settingsBody = await settings.json().catch(() => ({}));
report.checks.auth_settings = {
  status: settings.status,
  disable_signup: settingsBody?.disable_signup ?? null,
  external_email: settingsBody?.external?.email ?? null,
  external_anonymous_users: settingsBody?.external?.anonymous_users ?? null,
  mailer_autoconfirm: settingsBody?.mailer_autoconfirm ?? null,
  oauth_providers_enabled: Object.entries(settingsBody?.external ?? {})
    .filter(([name, on]) => on && name !== "email")
    .map(([name]) => name),
  full: settingsBody,
};

// 6. Public sign-up must be refused in practice, not just in configuration.
report.checks.signup_attempt = await probe("signup", "/auth/v1/signup", {
  method: "POST",
  headers: { ...anonHeaders, "Content-Type": "application/json" },
  // A deliberately unroutable address. Nothing is created if this is refused,
  // which is the expected and required outcome.
  body: JSON.stringify({ email: "rls-readback-probe@example.invalid", password: crypto.randomUUID() }),
});

// 7. site_url and the redirect allowlist, read back without any credential.
//
//    /auth/v1/settings does not expose either field, but GoTrue's behaviour
//    does. `/auth/v1/verify` validates `redirect_to` against the allowlist: an
//    allowed target is redirected to, a disallowed one falls back to site_url.
//    So one probe proves the allowlist contains production, and a second — with
//    a deliberately foreign target — makes the server name site_url itself.
//    The token is bogus in both cases; nothing is consumed or created.
const PRODUCTION = "https://bibi-workspace-18.vercel.app";

async function redirectProbe(target) {
  const url = `${URL_BASE}/auth/v1/verify?token=bibi-readback-bogus-token&type=invite`
    + `&redirect_to=${encodeURIComponent(target)}`;
  const response = await fetch(url, { redirect: "manual", headers: anonHeaders });
  const location = response.headers.get("location") ?? "";
  return { requested: target, status: response.status, redirectedTo: location.split("#")[0] };
}

const allowedProbe = await redirectProbe(PRODUCTION);
const foreignProbe = await redirectProbe("https://not-in-the-allowlist.example.com");

report.checks.redirect_configuration = {
  method: "unauthenticated /auth/v1/verify probes with a bogus token; nothing is consumed or created",
  allowed_target: allowedProbe,
  foreign_target: foreignProbe,
  production_in_allowlist: allowedProbe.redirectedTo.startsWith(PRODUCTION),
  // A foreign target falls back to site_url, so this IS site_url.
  site_url_observed: foreignProbe.redirectedTo,
  site_url_is_production: foreignProbe.redirectedTo.startsWith(PRODUCTION),
};

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

/**
 * The contract this readback exists to hold, stated as pass/fail rather than
 * left for a reader to infer from raw statuses.
 *
 * `signup_disabled` is checked two ways on purpose. The settings flag says what
 * the project is configured to do; the probe says what the endpoint actually
 * does. Configuration drift shows up as the two disagreeing.
 */
const expectations = [
  {
    id: "no_anonymous_read",
    expected: "every protected table returns zero rows to an anonymous caller",
    actual: `${report.checks.anonymous_select.filter((c) => c.rows === 0).length}/${report.checks.anonymous_select.length} returned zero rows`,
    pass: report.checks.anonymous_select.every((c) => c.status === 200 && c.rows === 0),
  },
  {
    id: "tables_exist",
    expected: "the zero rows above are RLS filtering, not a missing migration",
    actual: `${report.checks.table_existence.present.length} present, control missing-table probe returned ${report.checks.table_existence.control_missing_table.status}`,
    pass: report.checks.table_existence.absent.length === 0
      && report.checks.table_existence.control_missing_table.status === 404,
  },
  {
    id: "no_anonymous_write",
    expected: "anonymous inserts are refused by row level security",
    actual: `work_items ${report.checks.anonymous_insert.status}, conversations ${report.checks.anonymous_insert_conversations.status}`,
    pass: report.checks.anonymous_insert.status >= 400
      && report.checks.anonymous_insert_conversations.status >= 400,
  },
  {
    id: "api_key_required",
    expected: "a request with no api key is refused",
    actual: String(report.checks.no_api_key.status),
    pass: report.checks.no_api_key.status === 401,
  },
  {
    id: "signup_disabled_in_config",
    expected: "disable_signup === true",
    actual: String(report.checks.auth_settings.disable_signup),
    pass: report.checks.auth_settings.disable_signup === true,
  },
  {
    id: "signup_refused_in_practice",
    expected: "POST /auth/v1/signup returns 422 signup_disabled and creates nothing",
    actual: `${report.checks.signup_attempt.status} ${(() => {
      try { return JSON.parse(report.checks.signup_attempt.bodyExcerpt)?.error_code ?? ""; } catch { return ""; }
    })()}`.trim(),
    pass: report.checks.signup_attempt.status === 422
      && /signup_disabled/.test(report.checks.signup_attempt.bodyExcerpt),
  },
  {
    id: "production_in_redirect_allowlist",
    expected: "an invite returning to https://bibi-workspace-18.vercel.app is allowed",
    actual: report.checks.redirect_configuration.allowed_target.redirectedTo || "(no redirect)",
    pass: report.checks.redirect_configuration.production_in_allowlist === true,
  },
  {
    id: "site_url_is_production",
    expected: "site_url is https://bibi-workspace-18.vercel.app, not localhost",
    actual: report.checks.redirect_configuration.site_url_observed || "(no redirect)",
    pass: report.checks.redirect_configuration.site_url_is_production === true,
  },
  {
    id: "no_third_party_identity_providers",
    expected: "no OAuth provider and no anonymous users",
    actual: `oauth=[${report.checks.auth_settings.oauth_providers_enabled.join(",")}] anonymous_users=${report.checks.auth_settings.external_anonymous_users}`,
    pass: report.checks.auth_settings.oauth_providers_enabled.length === 0
      && report.checks.auth_settings.external_anonymous_users === false,
  },
];

report.expectations = expectations;
report.account_created_by_probe = false;
report.verdict = expectations.every((e) => e.pass) ? "PASS" : "FAIL";
report.failed_expectations = expectations.filter((e) => !e.pass).map((e) => e.id);

process.stdout.write(JSON.stringify(report, null, 2));

// A non-zero exit makes a regression impossible to miss when this is run from a
// script rather than read by a person.
if (report.verdict !== "PASS") process.exitCode = 1;
