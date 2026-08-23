/**
 * One polling cycle of the local Mac connector.
 *
 * The cycle is: report what the Mac can actually see, ask the control plane for
 * leased work, drop anything already delivered, and run what is left. Every
 * outcome is reported with a deterministic event id derived from the command,
 * so a report that is retried after a dropped response lands as a duplicate on
 * the control plane rather than as a second transition.
 *
 * The distinction the runner cares most about is release versus fail. A profile
 * the Mac cannot see right now is not a failed job — it is a job that has to go
 * back in the queue. Reporting that as a failure would teach the owner to
 * distrust failures.
 */

import { createIdempotencyLedger, suppressDuplicateCommands } from "../src/bibi/idempotency.js";
import { isBibiProfileId, isExecutionProfileId, toExecutionProfileId } from "../src/bibi/roster.js";

/** Never renew sooner than this, however short the remaining lease is. */
const MIN_RENEWAL_DELAY_MS = 1_000;

export function createLeaseRunner({
  config,
  transport,
  executor,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  ledger = createIdempotencyLedger(),
} = {}) {
  async function report(event) {
    return transport.report(event);
  }

  /**
   * Keep the lease alive for the duration of one execution. The renewal point
   * is half the remaining window: early enough to survive one lost request,
   * late enough not to hammer the control plane on a short task.
   */
  function withLeaseRenewal(command, run) {
    const expiresAt = Date.parse(command.leaseExpiresAt ?? "");
    const remainingMs = Number.isFinite(expiresAt) ? expiresAt - now() : 0;
    if (remainingMs <= 0) return run();

    const timer = setTimer(async () => {
      try {
        await transport.renewLease({ leaseId: command.leaseId, workItemId: command.workItemId });
      } catch {
        // A failed renewal is not fatal here: the control plane expires the
        // lease and re-queues the work, which is the honest outcome.
      }
    }, Math.max(MIN_RENEWAL_DELAY_MS, Math.floor(remainingMs / 2)));

    return run().finally(() => clearTimer(timer));
  }

  async function runCommand(command, reportedProfileIds, counters) {
    // A command names an organisational role slot. The physical profile that
    // will actually run it is derived here, once, and travels alongside the
    // role slot through execution and into every report.
    const executionProfileId = toExecutionProfileId(command.profileId);
    const identity = { profileId: command.profileId, executionProfileId };

    if (!isBibiProfileId(command.profileId) || !executionProfileId) {
      await report({
        id: `${command.id}:fail`,
        type: "fail",
        workItemId: command.workItemId,
        ...identity,
        error: `'${command.profileId}'은(는) 실제 bibi 조직 역할이 아닙니다. bibi-01부터 bibi-18까지만 실행합니다.`,
      });
      counters.failed += 1;
      return;
    }

    if (!reportedProfileIds.includes(executionProfileId)) {
      await report({
        id: `${command.id}:release`,
        type: "release",
        workItemId: command.workItemId,
        ...identity,
        reason: `로컬 Mac에서 실행 프로필 '${executionProfileId}'을(를) 확인할 수 없어 업무를 대기열로 돌려보냅니다.`,
      });
      counters.released += 1;
      return;
    }

    await report({ id: `${command.id}:start`, type: "start", workItemId: command.workItemId, ...identity });

    try {
      const result = await withLeaseRenewal(command, () => executor.execute({ ...command, executionProfileId }));
      await report({
        id: `${command.id}:succeed`,
        type: "succeed",
        workItemId: command.workItemId,
        ...identity,
        summary: result?.summary ?? "",
        detail: result?.detail ?? "",
        evidence: result?.evidence ?? [],
      });
      counters.succeeded += 1;
    } catch (error) {
      await report({
        id: `${command.id}:fail`,
        type: "fail",
        workItemId: command.workItemId,
        ...identity,
        error: error?.message ?? String(error),
      });
      counters.failed += 1;
    }
  }

  async function runOnce() {
    const counters = { succeeded: 0, failed: 0, released: 0 };

    // What the Mac can actually see right now, as *physical* profiles. Anything
    // that must not execute is dropped here: the rollback `bibi-01` directory,
    // upstream generic profiles, and identifiers that are not profiles at all.
    // A local runtime that cannot be listed reports nothing rather than a
    // remembered roster.
    let reportedProfileIds = [];
    let localRuntimeReachable = true;
    try {
      const listed = await executor.listProfileIds();
      reportedProfileIds = (Array.isArray(listed) ? listed : []).filter(isExecutionProfileId);
    } catch {
      // reportedProfileIds stays empty: a runtime that cannot be listed has an
      // unknown roster, and an unknown roster is reported as none.
      localRuntimeReachable = false;
    }

    try {
      await transport.heartbeat({
        nodeLabel: config.nodeLabel,
        connectorMode: config.mode,
        reportedProfileIds,
        localRuntimeReachable,
        dryRun: config.dryRun,
      });
    } catch (error) {
      return {
        online: false,
        error: error?.message ?? String(error),
        accepted: 0,
        suppressed: 0,
        localRuntimeReachable,
        ...counters,
      };
    }

    let batch;
    try {
      batch = await transport.poll({ max: config.maxBatch });
    } catch (error) {
      return {
        online: false,
        error: error?.message ?? String(error),
        accepted: 0,
        suppressed: 0,
        localRuntimeReachable,
        ...counters,
      };
    }

    const { accepted, suppressed } = suppressDuplicateCommands(batch?.commands ?? [], ledger);
    for (const command of accepted) {
      await runCommand(command, reportedProfileIds, counters);
    }

    return {
      online: true,
      error: null,
      accepted: accepted.length,
      suppressed: suppressed.length,
      localRuntimeReachable,
      ...counters,
    };
  }

  return { runOnce };
}
