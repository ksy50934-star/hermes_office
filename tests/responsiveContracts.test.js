import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stylesPath = new URL("../src/styles.css", import.meta.url);
const appPath = new URL("../src/App.jsx", import.meta.url);

test("mobile meeting and Kanban surfaces remain vertically reachable", async () => {
  const styles = await readFile(stylesPath, "utf8");

  assert.match(styles, /\.app-shell > main:has\(\.meeting-lobby-page\)[\s\S]*?overflow-y:\s*auto\s*!important/);
  assert.match(styles, /\.meeting-lobby-page\s*\{[\s\S]*?height:\s*auto\s*!important[\s\S]*?overflow-y:\s*visible\s*!important/);
  assert.match(styles, /\.native-kanban\s*\{[\s\S]*?grid-template-rows:\s*auto auto auto minmax\(0, 1fr\)\s*!important/);
  assert.match(styles, /\.native-kanban-grid\s*\{[\s\S]*?grid-row:\s*4\s*!important/);
  assert.match(styles, /\.native-kanban-grid\s*\{[\s\S]*?grid-auto-columns:\s*minmax\(260px, 320px\)\s*!important[\s\S]*?overflow-x:\s*auto\s*!important/);
  assert.doesNotMatch(styles, /\.native-kanban-grid\s*\{[^}]*grid-template-columns:\s*repeat\(8,\s*minmax\(0,\s*1fr\)/);
  assert.match(styles, /\.kanban-native-ops\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /@media \(max-width: 820px\)[\s\S]*?\.kanban-native-ops\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.kanban-empty-copy h3\s*\{[^}]*word-break:\s*keep-all/);
});

test("mobile refresh and selected navigation expose explicit state", async () => {
  const [styles, app] = await Promise.all([
    readFile(stylesPath, "utf8"),
    readFile(appPath, "utf8"),
  ]);

  assert.match(styles, /\.topbar-meta button:not\(\.meeting-jump\)::after\s*\{[\s\S]*?content:\s*"↻"\s*!important/);
  assert.match(app, /aria-current=\{view === id \? "page" : undefined\}/);
  assert.match(app, /aria-pressed=\{active\}/);
});
