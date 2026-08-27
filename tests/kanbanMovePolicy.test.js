import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canMoveBoardTask } from "../src/bibi/kanbanMovePolicy.js";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("legacy review cards cannot move back into mutable columns", () => {
  const manual = { manual: true };
  assert.equal(canMoveBoardTask({ status: "review" }, "todo", { column: manual }), false);
  assert.equal(canMoveBoardTask({ status: "todo" }, "review", { column: { manual: false } }), false);
  assert.equal(canMoveBoardTask({ status: "todo" }, "ready", { column: manual }), true);
});

test("canonical cards move only through adapter-authorized owner actions", () => {
  const manual = { manual: true };
  assert.equal(canMoveBoardTask({ status: "intake", actions: { assign: true } }, "assigned", { column: manual, canonical: true }), true);
  assert.equal(canMoveBoardTask({ status: "intake", actions: {} }, "assigned", { column: manual, canonical: true }), false);
  assert.equal(canMoveBoardTask({ status: "leased", terminal: true, actions: { cancel: true } }, "cancelled", { column: manual, canonical: true }), false);
});

test("only the latest board request may commit state", async () => {
  const source = await read("src/HermesKanban.jsx");
  assert.match(source, /const boardRequestRef = useRef\(0\)/);
  assert.match(source, /const requestId = boardRequestRef\.current \+ 1;\s*boardRequestRef\.current = requestId/);
  assert.match(source, /if \(requestId !== boardRequestRef\.current\) return;\s*setBoard/);
  assert.match(source, /if \(requestId === boardRequestRef\.current\) \{\s*setLoaded\(true\);\s*setRefreshing\(false\)/);
});
