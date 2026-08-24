import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

test("the exact LNB 01 CEO landing surface owns a bounded viewport", async () => {
  const [workspace, css] = await Promise.all([
    read("src/BibiWorkspace.jsx"),
    read("src/bibiWorkspace.css"),
  ]);
  assert.match(workspace, /className=\{`bibi-workspace is-surface-\$\{surface\}`\}/);
  const root = rule(css, ".bibi-workspace.is-surface-ceo");
  assert.match(root, /flex:\s*1 1 auto/);
  assert.match(root, /min-height:\s*0/);
  assert.match(root, /overflow:\s*hidden/);
  const layout = rule(css, ".bibi-workspace.is-surface-ceo > .bibi-layout");
  assert.match(layout, /flex:\s*1 1 auto/);
  assert.match(layout, /min-height:\s*0/);
  assert.match(layout, /align-items:\s*stretch/);
  assert.match(layout, /overflow:\s*hidden/);
});

test("only the CEO message history scrolls while its composer stays reachable", async () => {
  const [workspace, css] = await Promise.all([
    read("src/BibiWorkspace.jsx"),
    read("src/bibiWorkspace.css"),
  ]);
  assert.match(workspace, /<ol className="bibi-messages"[^>]*>[\s\S]*?<form className="bibi-composer"/);
  const chat = rule(css, ".bibi-workspace.is-surface-ceo .bibi-chat");
  assert.match(chat, /min-height:\s*0/);
  assert.match(chat, /height:\s*100%/);
  assert.match(chat, /overflow:\s*hidden/);
  const messages = rule(css, ".bibi-workspace.is-surface-ceo .bibi-messages");
  assert.match(messages, /min-height:\s*0/);
  assert.match(messages, /overflow-y:\s*auto/);
  assert.match(messages, /overscroll-behavior:\s*contain/);
  const composer = rule(css, ".bibi-workspace.is-surface-ceo .bibi-composer");
  assert.match(composer, /flex:\s*0 0 auto/);
});

test("office and sibling Bibi surfaces scroll to their actual cloud content", async () => {
  const css = await read("src/bibiWorkspace.css");
  const siblings = rule(css, ".bibi-workspace:not(.is-surface-ceo)");
  assert.match(siblings, /flex:\s*1 1 auto/);
  assert.match(siblings, /min-height:\s*0/);
  assert.match(siblings, /overflow-y:\s*auto/);
  const warnings = rule(css, ".bibi-workspace > .bibi-warning");
  assert.match(warnings, /max-height:/);
  assert.match(warnings, /overflow-y:\s*auto/);
});

test("mobile CEO chat reserves the fixed navigation dock", async () => {
  const css = await read("src/bibiWorkspace.css");
  assert.match(css, /\.bibi-workspace\.is-surface-ceo \.bibi-header > div:first-child,[\s\S]*?display:\s*none/);
  assert.match(
    css,
    /@media \(max-width: 640px\)[\s\S]*?\.bibi-workspace\.is-surface-ceo \.bibi-chat\s*\{[\s\S]*?height:\s*max\(320px,\s*calc\(100dvh\s*-\s*var\(--mobile-dock-height,\s*74px\)\s*-\s*270px\)\)/,
  );
});
