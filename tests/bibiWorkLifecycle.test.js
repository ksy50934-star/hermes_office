import assert from "node:assert/strict";
import test from "node:test";
import {
  WORK_STATUS,
  WorkLifecycleError,
  applyWorkEvent,
  createWorkItem,
  isTerminalStatus,
  reduceWorkEvents,
} from "../src/bibi/workLifecycle.js";

function intake(overrides = {}) {
  return createWorkItem({
    id: "work-1",
    ownerId: "owner-1",
    clientRequestId: "req-1",
    title: "월간 보고 초안",
    brief: "지난달 실행 결과를 정리한다.",
    createdAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  });
}

function event(type, payload = {}) {
  return { id: `${type}-1`, type, at: "2026-08-24T00:01:00.000Z", ...payload };
}

test("intake produces a durable, unassigned work item", () => {
  const work = intake();
  assert.equal(work.status, WORK_STATUS.INTAKE);
  assert.equal(work.profileId, null);
  assert.equal(work.clientRequestId, "req-1");
  assert.equal(work.attempt, 0);
  assert.deepEqual(work.appliedEventIds, []);
  assert.equal(work.leaseId, null);
});

test("intake requires an owner, an id and a client request id", () => {
  assert.throws(() => createWorkItem({ id: "", ownerId: "o", clientRequestId: "r", title: "t" }), WorkLifecycleError);
  assert.throws(() => createWorkItem({ id: "w", ownerId: "", clientRequestId: "r", title: "t" }), WorkLifecycleError);
  assert.throws(() => createWorkItem({ id: "w", ownerId: "o", clientRequestId: "", title: "t" }), WorkLifecycleError);
  assert.throws(() => createWorkItem({ id: "w", ownerId: "o", clientRequestId: "r", title: "  " }), WorkLifecycleError);
});

test("the happy path runs intake to succeeded and records the assignment", () => {
  const events = [
    event("assign", { profileId: "bibi-01" }),
    { ...event("lease"), id: "lease-1", leaseId: "lease-a", nodeId: "node-a", leaseExpiresAt: "2026-08-24T00:06:00.000Z" },
    { ...event("start"), id: "start-1" },
    { ...event("succeed"), id: "succeed-1", resultId: "result-1" },
  ];
  const work = reduceWorkEvents(intake(), events);
  assert.equal(work.status, WORK_STATUS.SUCCEEDED);
  assert.equal(work.profileId, "bibi-01");
  assert.equal(work.resultId, "result-1");
  assert.equal(work.attempt, 1);
  assert.equal(work.leaseId, null, "a finished work item must not still hold a lease");
  assert.equal(isTerminalStatus(work.status), true);
});

test("assignment refuses an upstream generic profile and any non-roster identifier", () => {
  for (const profileId of ["default", "hermes-director", "bibi-19", ""]) {
    assert.throws(
      () => applyWorkEvent(intake(), event("assign", { profileId })),
      (error) => error instanceof WorkLifecycleError && error.code === "INVALID_PROFILE",
      `${profileId} must be refused`,
    );
  }
});

test("illegal transitions throw instead of silently advancing", () => {
  const work = intake();
  assert.throws(() => applyWorkEvent(work, event("start")), (error) => error.code === "INVALID_TRANSITION");
  assert.throws(() => applyWorkEvent(work, event("succeed")), (error) => error.code === "INVALID_TRANSITION");

  const done = reduceWorkEvents(work, [
    event("assign", { profileId: "bibi-01" }),
    { ...event("cancel"), id: "cancel-1" },
  ]);
  assert.equal(done.status, WORK_STATUS.CANCELLED);
  assert.throws(
    () => applyWorkEvent(done, { ...event("assign", { profileId: "bibi-02" }), id: "assign-2" }),
    (error) => error.code === "TERMINAL_WORK_ITEM",
  );
});

test("a released or expired lease returns the work to assigned and keeps the attempt count", () => {
  const leased = reduceWorkEvents(intake(), [
    event("assign", { profileId: "bibi-03" }),
    { ...event("lease"), id: "lease-1", leaseId: "lease-a", nodeId: "node-a", leaseExpiresAt: "2026-08-24T00:06:00.000Z" },
    { ...event("start"), id: "start-1" },
  ]);
  assert.equal(leased.attempt, 1);

  const released = applyWorkEvent(leased, { ...event("release"), id: "release-1", reason: "lease expired" });
  assert.equal(released.status, WORK_STATUS.ASSIGNED);
  assert.equal(released.profileId, "bibi-03", "the assignment survives a lost lease");
  assert.equal(released.leaseId, null);
  assert.equal(released.nodeId, null);
  assert.equal(released.attempt, 1);

  const retried = applyWorkEvent(released, {
    ...event("lease"), id: "lease-2", leaseId: "lease-b", nodeId: "node-a", leaseExpiresAt: "2026-08-24T00:12:00.000Z",
  });
  assert.equal(applyWorkEvent(retried, { ...event("start"), id: "start-2" }).attempt, 2);
});

test("blocking preserves the assignment and requires an explicit reason", () => {
  const assigned = applyWorkEvent(intake(), event("assign", { profileId: "bibi-04" }));
  assert.throws(
    () => applyWorkEvent(assigned, { ...event("block"), id: "block-1", reason: "" }),
    (error) => error.code === "MISSING_REASON",
  );
  const blocked = applyWorkEvent(assigned, { ...event("block"), id: "block-1", reason: "사용자 결정 필요" });
  assert.equal(blocked.status, WORK_STATUS.BLOCKED);
  assert.equal(blocked.blockedReason, "사용자 결정 필요");
  const unblocked = applyWorkEvent(blocked, { ...event("unblock"), id: "unblock-1" });
  assert.equal(unblocked.status, WORK_STATUS.ASSIGNED);
  assert.equal(unblocked.profileId, "bibi-04");
  assert.equal(unblocked.blockedReason, null);
});

test("failure requires an error message and can be retried by reassignment", () => {
  const running = reduceWorkEvents(intake(), [
    event("assign", { profileId: "bibi-05" }),
    { ...event("lease"), id: "lease-1", leaseId: "lease-a", nodeId: "node-a", leaseExpiresAt: "2026-08-24T00:06:00.000Z" },
    { ...event("start"), id: "start-1" },
  ]);
  assert.throws(
    () => applyWorkEvent(running, { ...event("fail"), id: "fail-1", error: "" }),
    (error) => error.code === "MISSING_REASON",
  );
  const failed = applyWorkEvent(running, { ...event("fail"), id: "fail-1", error: "로컬 프로필 응답 없음" });
  assert.equal(failed.status, WORK_STATUS.FAILED);
  assert.equal(failed.error, "로컬 프로필 응답 없음");
  assert.equal(failed.leaseId, null);
  assert.equal(isTerminalStatus(failed.status), true);
});

test("replaying the same event id is a no-op, so reconnect cannot double-apply", () => {
  const assigned = applyWorkEvent(intake(), event("assign", { profileId: "bibi-06" }));
  const replayed = applyWorkEvent(assigned, event("assign", { profileId: "bibi-06" }));
  assert.deepEqual(replayed, assigned);

  const leaseEvent = { ...event("lease"), id: "lease-1", leaseId: "lease-a", nodeId: "node-a", leaseExpiresAt: "2026-08-24T00:06:00.000Z" };
  const startEvent = { ...event("start"), id: "start-1" };
  const once = reduceWorkEvents(assigned, [leaseEvent, startEvent]);
  const twice = reduceWorkEvents(assigned, [leaseEvent, startEvent, leaseEvent, startEvent]);
  assert.deepEqual(twice, once);
  assert.equal(twice.attempt, 1, "a replayed start must not inflate the attempt count");
});

test("every event must carry an id so replay protection cannot be bypassed", () => {
  assert.throws(
    () => applyWorkEvent(intake(), { type: "assign", profileId: "bibi-01" }),
    (error) => error.code === "MISSING_EVENT_ID",
  );
});

test("an unknown event type is rejected rather than ignored", () => {
  assert.throws(
    () => applyWorkEvent(intake(), event("teleport")),
    (error) => error.code === "UNKNOWN_EVENT",
  );
});

test("applying an event never mutates the work item it was given", () => {
  const work = intake();
  const snapshot = structuredClone(work);
  applyWorkEvent(work, event("assign", { profileId: "bibi-07" }));
  assert.deepEqual(work, snapshot);
});
