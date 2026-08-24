import test from "node:test";
import assert from "node:assert/strict";
import { createCloudDataRoomAdapter } from "../src/bibi/dataRoomAdapter.js";

const artifacts = [{
  id: "work-1",
  profile_id: "bibi-02",
  title: "운영 감사",
  results: [{ id: "result-1", summary: "감사 결과", detail: "회귀 0건", created_at: "2026-08-24T12:00:00.000Z" }],
  evidence: [{ id: "evidence-1", label: "테스트 로그", kind: "log", inline_excerpt: "648 pass", sha256: "abc", byte_size: 8, storage_path: "owner/work/log.txt", created_at: "2026-08-24T12:01:00.000Z" }],
}];

test("cloud data room exposes the original explorer browse contract", async () => {
  const adapter = createCloudDataRoomAdapter({ artifacts });
  assert.equal(adapter.defaultRootId, "profiles");

  const root = await adapter.request("browse", { root: "profiles", path: "" });
  assert.deepEqual(root.roots.map((item) => item.id), ["profiles", "workspace", "drive"]);
  assert.deepEqual(root.items.map((item) => [item.type, item.relativePath]), [["folder", "bibi-02"]]);

  const member = await adapter.request("browse", { root: "profiles", path: "bibi-02" });
  assert.equal(member.items.length, 2);
  assert.equal(member.items.every((item) => item.rootId === "profiles"), true);

  const workspace = await adapter.request("browse", { root: "workspace", path: "" });
  const drive = await adapter.request("browse", { root: "drive", path: "" });
  assert.deepEqual(workspace.items.map((item) => item.id), ["workspace:result:result-1"]);
  assert.deepEqual(drive.items.map((item) => item.id), ["drive:evidence:evidence-1"]);
});

test("cloud data room returns immutable provenance detail and searchable rows", async () => {
  const adapter = createCloudDataRoomAdapter({ artifacts, connector: { health: { state: "online", lastHeartbeatAt: "2026-08-24T12:02:00.000Z" } } });
  const detail = await adapter.request("item", { id: "drive:evidence:evidence-1" });
  assert.equal(detail.editable, false);
  assert.match(detail.preview, /648 pass/);
  assert.match(detail.preview, /SHA-256\nabc/);
  assert.match(detail.preview, /Cloud storage path/);

  const search = await adapter.request("list", { q: "감사" });
  assert.equal(search.files.some((item) => item.name === "감사 결과"), true);
  const health = await adapter.request("drive-status");
  assert.equal(health.phase, "ready");
  assert.equal(health.files, 1);

  await assert.rejects(
    adapter.request("item", { id: detail.id }, { method: "PUT", body: "{}" }),
    /불변 기록/,
  );
});
