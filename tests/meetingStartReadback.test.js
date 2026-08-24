import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startMeetingWithReadback } from "../src/cloud/workspaceClient.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("meeting start returns the authoritative created meeting after readback", async () => {
  const calls = [];
  const result = await startMeetingWithReadback(
    { topic: "주간 점검", profileIds: ["bibi-02", "bibi-03"] },
    {
      start: async (input) => { calls.push(["start", input]); return "meeting-1"; },
      load: async () => {
        calls.push(["load"]);
        return [{ id: "meeting-1", topic: "주간 점검", participants: [] }];
      },
    },
  );
  assert.deepEqual(calls.map(([name]) => name), ["start", "load"]);
  assert.equal(result.meetingId, "meeting-1");
  assert.equal(result.meeting.id, "meeting-1");
  assert.equal(result.meetings.length, 1);
});

test("meeting start publishes readback before selecting the live cloud meeting", async () => {
  const app = await read("src/App.jsx");
  assert.match(app, /startMeetingWithReadback/);
  assert.match(app, /setBibiCloudSnapshot\(\(current\) => \(\{[\s\S]*meetings/);
  assert.match(app, /setSelectedMeetingId\(meetingId\)/);
});

test("meeting lobby exposes progress and cloud failures instead of appearing inert", async () => {
  const app = await read("src/App.jsx");
  assert.match(app, /const \[starting, setStarting\] = useState\(false\)/);
  assert.match(app, /await onStartMeeting/);
  assert.match(app, /starting \? "회의 여는 중…" : "회의 시작"/);
  assert.match(app, /startError && <p className="meeting-start-error" role="alert">/);
  assert.match(app, /setMeetingStartError\(meetingError\.message/);
  assert.match(app, /error && !officeNotice && !bibiCloudView/);
});
