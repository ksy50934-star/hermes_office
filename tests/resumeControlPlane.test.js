import assert from "node:assert/strict";
import test from "node:test";

import { handlePoll } from "../api/_lib/handlers.js";

const leased = Object.freeze({
  workItemId: "work-1",
  profileId: "bibi-07",
  kind: "chat",
  conversationId: "conversation-1",
  title: "후속",
  brief: "계속",
  attempt: 2,
  leaseId: "lease-1",
  leaseExpiresAt: "2026-08-24T04:10:00.000Z",
  bindingId: "binding-1",
  hermesSessionId: "session-1",
  channelOrigin: "telegram",
  continuationStatus: "bound",
  resumeLeaseId: "resume-lease-1",
});

test("poll carries the complete bound-session identity and exclusive lease", async () => {
  const result = await handlePoll({
    auth: { ownerId: "owner-1", connectorNodeId: "node-1" },
    body: { max: 1 },
    store: { async claimWork() { return [leased]; } },
  });
  const [command] = result.body.commands;
  assert.equal(command.profileId, "bibi-07");
  assert.equal(command.executionProfileId, "bibi-07");
  assert.equal(command.bindingId, "binding-1");
  assert.equal(command.hermesSessionId, "session-1");
  assert.equal(command.channelOrigin, "telegram");
  assert.equal(command.continuationStatus, "bound");
  assert.equal(command.resumeLeaseId, "resume-lease-1");
});
