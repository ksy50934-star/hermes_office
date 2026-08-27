import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CONNECTOR_STATE } from "../src/bibi/connectionState.js";
import {
  OFFICE_STATE,
  WORK_VIEW_STATE,
  boardMovePlan,
  describeRnbWork,
  deliberateWork,
  excludedWorkKinds,
  projectOfficeWork,
  projectWorkBoard,
} from "../src/bibi/officeProjection.js";
import { WORK_STATUS } from "../src/bibi/workLifecycle.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const online = { state: CONNECTOR_STATE.ONLINE, label: "ONLINE", lastHeartbeatAt: "2026-08-27T12:00:00.000Z" };
const offline = { state: CONNECTOR_STATE.OFFLINE, label: "OFFLINE", lastHeartbeatAt: null };

function work(overrides = {}) {
  return {
    id: "work-1",
    kind: "work",
    title: "실제 업무",
    brief: "Cloud work_items에서 읽은 업무",
    status: WORK_STATUS.ASSIGNED,
    profile_id: "bibi-02",
    attempt: 0,
    created_at: "2026-08-27T11:00:00.000Z",
    updated_at: "2026-08-27T12:00:00.000Z",
    ...overrides,
  };
}

test("Office projection counts only deliberate kind=work rows", () => {
  const rows = [
    work(),
    work({ id: "meeting-1", kind: "meeting", title: "회의 참여" }),
    work({ id: "chat-1", kind: "chat", title: "채팅 turn" }),
    work({ id: "future-1", kind: "future-kind", title: "알 수 없는 종류" }),
  ];

  assert.deepEqual(deliberateWork(rows).map((row) => row.id), ["work-1"]);
  assert.deepEqual(excludedWorkKinds(rows), { meeting: 1, chat: 1, other: 1, total: 3 });

  const projection = projectOfficeWork({ workItems: rows, loaded: true, connectorHealth: online });
  assert.equal(projection.counts.total, 1);
  assert.equal(projection.counts.active, 1);
  assert.equal(projection.cards[0].title, "실제 업무");
  assert.equal(projection.cards[0].stage.percent, null);
});

test("loading, error, empty, offline and stale are distinct honest states", () => {
  const loadingProjection = projectOfficeWork({ workItems: null, loaded: false, connectorHealth: online });
  assert.equal(loadingProjection.state, OFFICE_STATE.LOADING);
  assert.equal(describeRnbWork(loadingProjection).state, WORK_VIEW_STATE.LOADING);
  assert.equal(projectWorkBoard(loadingProjection).state, WORK_VIEW_STATE.LOADING);

  const errorProjection = projectOfficeWork({ workItems: null, loaded: false, error: "read failed", connectorHealth: online });
  assert.equal(describeRnbWork(errorProjection).state, WORK_VIEW_STATE.ERROR);

  const emptyProjection = projectOfficeWork({ workItems: [], loaded: true, connectorHealth: online });
  assert.equal(describeRnbWork(emptyProjection).state, WORK_VIEW_STATE.EMPTY);
  assert.equal(projectWorkBoard(emptyProjection).state, WORK_VIEW_STATE.EMPTY);

  const offlineProjection = projectOfficeWork({ workItems: [], loaded: true, connectorHealth: offline });
  assert.equal(describeRnbWork(offlineProjection).state, WORK_VIEW_STATE.OFFLINE);
  assert.match(describeRnbWork(offlineProjection).notice, /연결되어 있지 않습니다/);

  const staleProjection = projectOfficeWork({
    workItems: [work()],
    loaded: true,
    connectorHealth: online,
    lastSyncAt: "2026-08-27T11:00:00.000Z",
    now: Date.parse("2026-08-27T12:00:00.000Z"),
  });
  assert.equal(describeRnbWork(staleProjection).state, WORK_VIEW_STATE.STALE);
  assert.equal(projectWorkBoard(staleProjection).state, WORK_VIEW_STATE.STALE);
});

test("RNB lists exactly the real active rows and deep-links to the same work item", () => {
  const projection = projectOfficeWork({
    workItems: [
      work({ id: "active-a", title: "실제 A" }),
      work({ id: "active-b", title: "실제 B", status: WORK_STATUS.RUNNING }),
      work({ id: "done-c", title: "완료 C", status: WORK_STATUS.SUCCEEDED, result_id: "result-c" }),
    ],
    loaded: true,
    connectorHealth: online,
  });
  const rnb = describeRnbWork(projection);

  assert.equal(rnb.items.length, 2);
  assert.deepEqual(new Set(rnb.items.map((item) => item.id)), new Set(["active-a", "active-b"]));
  for (const item of rnb.items) {
    assert.deepEqual(item.navigation, {
      view: "kanban",
      target: "work",
      workItemId: item.id,
      profileId: "bibi-02",
    });
  }
  assert.equal(rnb.completed.length, 1);
  assert.equal(rnb.completed[0].hasResult, true);
});

test("terminal work is immutable from the board", () => {
  const projection = projectOfficeWork({
    workItems: [work({ id: "done", status: WORK_STATUS.SUCCEEDED })],
    loaded: true,
    connectorHealth: online,
  });
  const card = projection.cards[0];
  assert.equal(card.terminal, true);
  assert.throws(
    () => boardMovePlan(card, WORK_STATUS.ASSIGNED, { profileId: "bibi-02" }),
    (error) => error?.code === "TERMINAL_WORK_ITEM",
  );
});

test("Office runtime has no demo mission source and the board only blocks its first read", async () => {
  const [app, office, commandCenter, kanban] = await Promise.all([
    readFile(path.join(projectRoot, "src", "App.jsx"), "utf8"),
    readFile(path.join(projectRoot, "src", "HermesOffice.jsx"), "utf8"),
    readFile(path.join(projectRoot, "src", "CommandCenter.jsx"), "utf8"),
    readFile(path.join(projectRoot, "src", "HermesKanban.jsx"), "utf8"),
  ]);
  const runtime = `${app}\n${office}\n${commandCenter}`;

  assert.doesNotMatch(runtime, /operationsData|INITIAL_MISSIONS|INITIAL_APPROVALS|AGENT_ACTIVITY/);
  assert.match(app, /const \[missions, setMissions\] = useState\(null\)/);
  assert.match(app, /setMissions\(officeMissionsFromBoard\(board\)\)/);
  assert.match(kanban, /const loading = !loaded/);
  assert.match(kanban, /aria-busy=\{loading \|\| refreshing\}/);
  assert.match(kanban, /\{loading \? <p className="empty-state">/);
  assert.doesNotMatch(kanban, /localStorage.*kanban|kanban.*localStorage/);
});
