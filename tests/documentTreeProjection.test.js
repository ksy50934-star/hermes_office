import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { collectDocumentTree } from "../connector/documentTreeProjection.js";
import { createCloudDataRoomAdapter } from "../src/bibi/dataRoomAdapter.js";

const PROFILE_IDS = Array.from({ length: 18 }, (_, index) => `bibi-${String(index + 1).padStart(2, "0")}`);

test("document tree collector projects folders only and excludes private runtime trees", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bibi-tree-"));
  try {
    const profile = path.join(root, "bibi-02");
    await mkdir(path.join(profile, "information", "approved"), { recursive: true });
    await mkdir(path.join(profile, "70-자료", "campaign"), { recursive: true });
    await mkdir(path.join(profile, ".omc", "state"), { recursive: true });
    await mkdir(path.join(profile, "logs", "legacy-conversations"), { recursive: true });
    await writeFile(path.join(profile, "information", "approved", "note.md"), "not projected");
    await symlink(path.join(root, "outside"), path.join(profile, "linked-outside"));

    const tree = await collectDocumentTree({ root, profileId: "bibi-02" });
    assert.deepEqual(tree.directories, ["70-자료", "70-자료/campaign", "information", "information/approved", "logs"]);
    assert.equal(tree.directories.includes("logs/legacy-conversations"), false);
    assert.equal(tree.collectionError, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cloud data room always exposes all Bibi roots and browses projected bibi-world folders", async () => {
  const adapter = createCloudDataRoomAdapter({
    artifacts: [],
    profileIds: PROFILE_IDS,
    documentTrees: [{
      profile_id: "bibi-02",
      directories: ["70-자료", "70-자료/campaign", "information", "information/approved"],
      collected_at: "2026-08-25T01:00:00.000Z",
    }],
  });

  const root = await adapter.request("browse", { root: "profiles", path: "" });
  assert.deepEqual(root.items.map((item) => item.relativePath), PROFILE_IDS);

  const profile = await adapter.request("browse", { root: "profiles", path: "bibi-02" });
  assert.deepEqual(profile.items.map((item) => [item.type, item.relativePath]), [
    ["folder", "bibi-02/70-자료"],
    ["folder", "bibi-02/information"],
  ]);

  const nested = await adapter.request("browse", { root: "profiles", path: "bibi-02/information" });
  assert.deepEqual(nested.items.map((item) => item.relativePath), ["bibi-02/information/approved"]);
});
