import assert from "node:assert/strict";
import test from "node:test";

import { createSqliteSessionVerifier } from "../connector/sessionBinding.js";

test("binding verification allows WAL coordination while its SQLite query stays query-only", async () => {
  let invocation;
  const verifier = createSqliteSessionVerifier({
    execFileImpl: async (binary, args, options) => {
      invocation = { binary, args, options };
      return {
        stdout: JSON.stringify([{
          id: "20260828_120000_abcd12",
          source: "telegram",
          profile_name: "default",
          expiry_finalized: 0,
          archived: 0,
        }]),
      };
    },
  });

  const result = await verifier.verify({
    home: "/safe/default",
    hermesSessionId: "20260828_120000_abcd12",
    executionProfileId: "default",
    channelOrigin: "telegram",
  });

  assert.deepEqual(result, { ok: true });
  const sql = invocation.args.at(-1);
  assert.equal(invocation.binary, "sqlite3");
  assert.deepEqual(invocation.args.slice(0, 3), ["-json", "/safe/default/state.db", sql]);
  assert.doesNotMatch(invocation.args.join(" "), /-readonly/);
  assert.match(sql, /^pragma query_only = on;/i);
});
