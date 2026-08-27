import test from "node:test";
import assert from "node:assert/strict";
import { cloudArchiveView, createCloudArchiveAdapter } from "../src/bibi/archiveAdapter.js";

test("cloud archive maps durable conversations and meeting results into the specialist reader contract", () => {
  const view = cloudArchiveView({
    archive: [{
      id: "conv-1",
      profile_id: "bibi-02",
      title: "제품 점검",
      last_message_at: "2026-08-24T12:00:00.000Z",
      messages: [{ id: "m-1" }, { id: "m-2" }],
    }],
    // `complete` is the only value `bibi_meetings.status` accepts for a
    // finished meeting; the old fixture used `completed`, which the check
    // constraint has never allowed.
    meetings: [{
      id: "meeting-1",
      topic: "배포 판단",
      status: "complete",
      completion_mode: "automatic",
      completed_at: "2026-08-24T13:00:00.000Z",
      participants: [{
        profile_id: "bibi-02",
        result: {
          id: "result-1",
          summary: "배포 보류",
          detail: "회귀를 먼저 수정합니다.",
          created_at: "2026-08-24T12:30:00.000Z",
        },
      }],
    }],
  });

  assert.deepEqual(view.sessions[0], {
    id: "conv-1",
    profile: "bibi-02",
    title: "제품 점검",
    source: "Bibi Cloud",
    message_count: 2,
    last_active: 1787572800,
    created_at: undefined,
    archived: false,
    cloud: true,
  });
  assert.equal(view.meetings[0].status, "complete");
  assert.deepEqual(view.meetings[0].participants, ["bibi-02"]);
  assert.equal(view.meetings[0].entries[0].text, "회귀를 먼저 수정합니다.");
});

test("cloud archive adapter reads merged cloud messages, exports a safe contract and deletes by conversation id", async () => {
  const calls = [];
  const adapter = createCloudArchiveAdapter({
    archive: [{ id: "conv-1", profile_id: "bibi-02", title: "제품 점검", messages: [] }],
    loadMessagesFn: async (id) => {
      calls.push(["load", id]);
      return [{
        id: "m-1",
        role: "assistant",
        body: "검증 완료",
        created_at: "2026-08-24T12:00:00.000Z",
        internal_context: "never-export",
      }];
    },
    deleteConversationFn: async (id) => { calls.push(["delete", id]); },
  });
  const { sessions } = await adapter.list();
  const messages = await adapter.loadMessages(sessions[0]);
  const payload = await adapter.export(sessions[0]);
  await adapter.remove(sessions[0]);

  assert.equal(messages[0].content, "검증 완료");
  assert.equal(payload.schema, "bibi-cloud-conversation-export/v1");
  assert.equal(payload.messages[0].content, "검증 완료");
  assert.equal("internal_context" in payload.messages[0], false);
  assert.deepEqual(calls, [["load", "conv-1"], ["load", "conv-1"], ["delete", "conv-1"]]);
});
