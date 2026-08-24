/**
 * Contract for the sign-in → signed-in workspace scroll reset.
 *
 * Measured at 390px with a real browser: sign in, and the shell's `<main>` goes
 * from scrollTop 0 to 1679 with the header at top -1601, so the first frame of
 * the signed-in workspace is its middle — around bibi-13 in the roster rail.
 * The workspace does not own that element; it renders inside it, and the
 * browser preserves the container's offset across a subtree swap because from
 * its side nothing scrolled, the content just got taller.
 *
 * These are behavioural tests against duck-typed elements rather than a
 * stylesheet assertion, because no CSS property expresses "this offset is
 * meaningless now". They cover the two-pass reset, the ancestor walk, the
 * deferred pass, cancellation, and the component wiring that makes it a
 * transition rather than a scroll-to-top on every render.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  afterLayout,
  resetScrollOnAuthTransition,
  resetWorkspaceScroll,
} from "../src/bibi/authTransitionScroll.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFile(path.join(projectRoot, relative), "utf8");

/** The measured failure: the shell container two screens down. */
const OBSERVED_MAIN_SCROLL_TOP = 1679;

function element(tagName, { scrollTop = 0, scrollLeft = 0, parentElement = null } = {}) {
  return { tagName, scrollTop, scrollLeft, parentElement };
}

/** The real nesting: workspace root inside the app shell's `<main>`. */
function shell({ mainScrollTop = OBSERVED_MAIN_SCROLL_TOP, rootScrollTop = 0 } = {}) {
  const body = element("BODY");
  const main = element("MAIN", { scrollTop: mainScrollTop, parentElement: body });
  const root = element("DIV", { scrollTop: rootScrollTop, parentElement: main });
  return { body, main, root };
}

/**
 * A frame queue that behaves like the real one: cancelling removes the
 * callback, so a paint after a cancel runs nothing. A double that merely
 * recorded the handle would let a broken cancel pass.
 */
function fakeView({ scrollY = 0, documentScrollTop = 0, withRaf = true } = {}) {
  const frames = new Map();
  let nextHandle = 0;

  const view = {
    scrollY,
    pageYOffset: scrollY,
    scrolledTo: [],
    frames,
    cancelled: [],
    document: { scrollingElement: element("HTML", { scrollTop: documentScrollTop }) },
    scrollTo(x, y) {
      this.scrolledTo.push([x, y]);
      this.scrollY = y;
      this.pageYOffset = y;
    },
  };
  if (withRaf) {
    view.requestAnimationFrame = (callback) => {
      nextHandle += 1;
      frames.set(nextHandle, callback);
      return nextHandle;
    };
    view.cancelAnimationFrame = (handle) => {
      view.cancelled.push(handle);
      frames.delete(handle);
    };
  }
  return view;
}

/** Run whatever the fake view has queued, the way a paint would. */
function paint(view) {
  const queued = [...view.frames.values()];
  view.frames.clear();
  for (const callback of queued) callback();
}

// ---------------------------------------------------------------------------
// The measured failure
// ---------------------------------------------------------------------------

test("the owning main is reset from the offset the live 390px run measured", () => {
  const { main, root } = shell();
  const view = fakeView();

  const reset = resetWorkspaceScroll(root, { view });

  assert.equal(main.scrollTop, 0, "the first signed-in view must start at the top");
  assert.ok(reset.includes("main"), "the reset must name what it actually found");
});

test("the reset walks ancestors rather than assuming which element scrolls", () => {
  // Which container scrolls moves between the shell's main and the document
  // depending on viewport, and a media query can move it without this module
  // hearing about it. Resetting every scrolled ancestor is correct either way.
  const { body, main, root } = shell({ rootScrollTop: 40 });
  body.scrollTop = 300;
  const view = fakeView();

  resetWorkspaceScroll(root, { view });

  assert.equal(root.scrollTop, 0);
  assert.equal(main.scrollTop, 0);
  assert.equal(body.scrollTop, 0);
});

test("the document scroller and the window offset are reset too", () => {
  const { root } = shell({ mainScrollTop: 0 });
  const view = fakeView({ scrollY: 820, documentScrollTop: 820 });

  const reset = resetWorkspaceScroll(root, { view });

  assert.equal(view.document.scrollingElement.scrollTop, 0);
  assert.deepEqual(view.scrolledTo, [[0, 0]], "iOS keeps a window offset that outlives an element reset");
  assert.ok(reset.includes("document"));
  assert.ok(reset.includes("window"));
});

test("a horizontal offset is cleared alongside the vertical one", () => {
  const { main, root } = shell();
  main.scrollLeft = 120;
  const view = fakeView();

  resetWorkspaceScroll(root, { view });

  assert.equal(main.scrollLeft, 0);
});

// ---------------------------------------------------------------------------
// Not touching what is already correct
// ---------------------------------------------------------------------------

test("an already-topped container is left alone rather than written to", () => {
  const { main, root } = shell({ mainScrollTop: 0 });
  const view = fakeView();

  let writes = 0;
  Object.defineProperty(main, "scrollTop", {
    get: () => 0,
    set: () => { writes += 1; },
  });

  const reset = resetWorkspaceScroll(root, { view });

  assert.equal(writes, 0, "a redundant write can interrupt a scroll legitimately in progress");
  assert.deepEqual(reset, []);
  assert.deepEqual(view.scrolledTo, [], "the window is not scrolled when it is already at the top");
});

test("a missing element is a no-op, not a crash", () => {
  const view = fakeView();
  assert.doesNotThrow(() => resetWorkspaceScroll(null, { view }));
  assert.doesNotThrow(() => resetWorkspaceScroll(undefined, { view }));
  assert.deepEqual(resetWorkspaceScroll(null, { view }), []);
});

test("a view with no scrollTo and no document is tolerated", () => {
  const { root } = shell();
  assert.doesNotThrow(() => resetWorkspaceScroll(root, { view: {} }));
  assert.doesNotThrow(() => resetWorkspaceScroll(root, { view: null }));
});

test("a cyclic parent chain cannot hang the render", () => {
  const first = element("DIV", { scrollTop: 10 });
  const second = element("DIV", { scrollTop: 10, parentElement: first });
  first.parentElement = second;

  const view = fakeView();
  assert.doesNotThrow(() => resetWorkspaceScroll(second, { view }));
  assert.equal(first.scrollTop, 0);
  assert.equal(second.scrollTop, 0);
});

// ---------------------------------------------------------------------------
// The deferred pass
// ---------------------------------------------------------------------------

test("the reset runs immediately and again after layout settles", () => {
  const { main, root } = shell();
  const view = fakeView();

  resetScrollOnAuthTransition(root, { view });

  // Immediate: no visible frame at the inherited offset.
  assert.equal(main.scrollTop, 0);
  assert.equal(view.frames.size, 1, "a second pass must be queued for the taller layout");

  // The browser re-applies the preserved offset when it lays the taller
  // workspace out, which happens after the effect that mounted it. That is the
  // pass the 390px failure actually needed.
  main.scrollTop = OBSERVED_MAIN_SCROLL_TOP;
  paint(view);
  assert.equal(main.scrollTop, 0);
});

test("the deferred pass is cancellable, so an unmount mid-transition schedules nothing", () => {
  const { main, root } = shell();
  const view = fakeView();

  const cancel = resetScrollOnAuthTransition(root, { view });
  cancel();

  assert.deepEqual(view.cancelled, [1]);
  assert.equal(view.frames.size, 0, "the queued pass must be dequeued, not merely noted");

  // Nothing must touch the element after cancellation.
  main.scrollTop = 500;
  paint(view);
  assert.equal(main.scrollTop, 500, "a cancelled transition does not reach back into a replaced screen");
});

test("without requestAnimationFrame the deferred pass still runs, and still cancels", async () => {
  const { main, root } = shell();
  const view = fakeView({ withRaf: false });

  resetScrollOnAuthTransition(root, { view });
  main.scrollTop = OBSERVED_MAIN_SCROLL_TOP;
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(main.scrollTop, 0, "a background tab throttles rAF; the timeout is the floor");

  const second = shell();
  const cancel = resetScrollOnAuthTransition(second.root, { view });
  cancel();
  second.main.scrollTop = 500;
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(second.main.scrollTop, 500);
});

test("afterLayout returns a cancel for whichever scheduler it used", () => {
  const withRaf = fakeView();
  let ran = 0;
  const cancelRaf = afterLayout(() => { ran += 1; }, { view: withRaf });
  cancelRaf();
  paint(withRaf);
  assert.equal(ran, 0);

  assert.equal(typeof afterLayout(() => {}, { view: fakeView({ withRaf: false }) }), "function");
});

// ---------------------------------------------------------------------------
// Component wiring
// ---------------------------------------------------------------------------

test("the workspace resets scroll on the transition into the signed-in view", async () => {
  const source = await read("src/BibiWorkspace.jsx");

  assert.match(source, /import \{ resetScrollOnAuthTransition \} from "\.\/bibi\/authTransitionScroll\.js";/);

  // The root the reset walks up from is the signed-in workspace itself.
  assert.match(source, /const workspaceRef = useRef\(null\);/);
  assert.match(source, /<div className=\{`bibi-workspace is-surface-\$\{surface\}`\} ref=\{workspaceRef\}>/);

  // Keyed on the transition, so it fires when the signed-in view appears and
  // not on every subsequent render — a reset on each render would yank the page
  // back to the top while the user is reading the work board.
  assert.match(
    source,
    /const signedInWorkspace = cloud\.configured && !callbackPending && Boolean\(session\) && !passwordSetup;/,
  );
  const effect = source.slice(source.indexOf("const signedInWorkspace ="));
  assert.match(effect.slice(0, 400), /useEffect\(\(\) => \{\s*if \(!signedInWorkspace\) return undefined;\s*return resetScrollOnAuthTransition\(workspaceRef\.current\);\s*\}, \[signedInWorkspace\]\);/);
});

test("the effect is declared above every early return, so the hook order is stable", async () => {
  const source = await read("src/BibiWorkspace.jsx");

  const effectAt = source.indexOf("resetScrollOnAuthTransition(workspaceRef.current)");
  const firstEarlyReturn = source.indexOf("  if (!cloud.configured) {");

  assert.notEqual(effectAt, -1);
  assert.notEqual(firstEarlyReturn, -1);
  assert.ok(effectAt < firstEarlyReturn, "a conditional hook would break on the very transition it guards");
});

test("the reset is behaviour, not a stylesheet rule that could be overridden", async () => {
  const [source, css] = await Promise.all([
    read("src/BibiWorkspace.jsx"),
    read("src/bibiWorkspace.css"),
  ]);

  // Stated so a later "just add a CSS rule" does not quietly replace it: no
  // property expresses "this container's offset is meaningless now", so the
  // guarantee has to live in the code that performs the swap.
  assert.doesNotMatch(css, /overflow-anchor/);
  assert.match(source, /resetScrollOnAuthTransition\(/);
});
