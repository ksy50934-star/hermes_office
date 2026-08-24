/**
 * Scroll reset for the sign-in → signed-in workspace transition.
 *
 * The workspace does not own the element that scrolls. It renders inside the
 * application shell's `<main>`, and on a phone that container is what carries
 * the page offset. The auth card is short; the signed-in workspace is a roster
 * rail plus a chat pane plus a work board, and it is long. React swaps one for
 * the other inside the same container, and the browser keeps the container's
 * `scrollTop` across that swap because as far as it is concerned nothing
 * scrolled — the content simply got taller underneath a preserved offset.
 *
 * At 390px that reproduced as: sign in, and the first signed-in frame lands at
 * `scrollTop` 1679 with the header at top -1601 — roughly two screens down,
 * somewhere around the seventeenth roster entry. Nothing is broken, but the
 * user's first view of their workspace is its middle.
 *
 * CSS cannot fix this. `overflow-anchor`, `scroll-behavior` and friends all
 * describe how a scroll position changes; none of them says "this container's
 * offset is meaningless now because its contents were replaced". That is a
 * statement only the code performing the replacement can make, so it is made
 * here, and it is tested here.
 *
 * Everything below is duck-typed against the small part of the DOM it touches —
 * `parentElement`, `scrollTop`, `scrollTo` — so the contract can be exercised
 * against plain objects rather than a headless browser.
 */

/**
 * Walk from an element up through its ancestors, resetting every one that is
 * actually scrolled.
 *
 * Deliberately not "find the scroll container and reset that one". Which
 * ancestor scrolls depends on the viewport: on a phone it is the shell's
 * `<main>`, on a desktop it can be the document itself, and a media query can
 * move it between the two without this module hearing about it. Resetting every
 * ancestor that holds a non-zero offset is correct in all of those cases and
 * needs no knowledge of the stylesheet.
 *
 * Only non-zero offsets are written. An element already at 0 is left untouched,
 * so this cannot interrupt a scroll animation that is legitimately in progress
 * somewhere above.
 *
 * @param {object|null} element the workspace root; ancestors are walked from it
 * @param {object} [options]
 * @param {object} [options.view] window-like object, for the document-level
 *   offsets that are not reachable through `parentElement`
 * @returns {string[]} a tag for each offset actually reset, so a caller (and a
 *   test) can see what was found rather than trusting that something was
 */
export function resetWorkspaceScroll(element, { view = globalThis } = {}) {
  const reset = [];

  for (let node = element ?? null, depth = 0; node && depth < MAX_ANCESTOR_DEPTH; node = node.parentElement, depth += 1) {
    if (typeof node.scrollTop === "number" && node.scrollTop > 0) {
      node.scrollTop = 0;
      reset.push(describeNode(node, depth));
    }
    if (typeof node.scrollLeft === "number" && node.scrollLeft > 0) {
      node.scrollLeft = 0;
    }
  }

  // The document scroller is an ancestor of the workspace but is not always
  // reachable by walking `parentElement` to the end, and on iOS Safari the
  // window offset can outlive a reset of the element that produced it.
  const scrollingElement = view?.document?.scrollingElement;
  if (scrollingElement && typeof scrollingElement.scrollTop === "number" && scrollingElement.scrollTop > 0) {
    scrollingElement.scrollTop = 0;
    reset.push("document");
  }

  if (typeof view?.scrollTo === "function" && (view.scrollY > 0 || view.pageYOffset > 0)) {
    view.scrollTo(0, 0);
    reset.push("window");
  }

  return reset;
}

/** A loop bound, so a malformed or cyclic parent chain cannot hang a render. */
const MAX_ANCESTOR_DEPTH = 64;

function describeNode(node, depth) {
  const tag = String(node.tagName ?? "").toLowerCase();
  return tag || `ancestor-${depth}`;
}

/**
 * Run a callback once the browser has laid the new screen out.
 *
 * A reset performed in the same tick as the swap can be undone: the workspace
 * is taller than the card it replaced, and the browser applies the preserved
 * offset when it lays that taller content out — which is after the effect that
 * mounted it. So this waits one animation frame, which is the point at which
 * the layout the offset applies to exists.
 *
 * `requestAnimationFrame` is absent in a test process and in a background tab,
 * where a timeout is both available and sufficient. The returned function
 * cancels whichever was used, so an unmount mid-transition schedules nothing
 * into a component that is gone.
 *
 * @returns {() => void} cancel
 */
export function afterLayout(callback, { view = globalThis } = {}) {
  if (typeof view?.requestAnimationFrame === "function") {
    const handle = view.requestAnimationFrame(() => callback());
    return () => view.cancelAnimationFrame?.(handle);
  }
  const handle = setTimeout(() => callback(), 0);
  return () => clearTimeout(handle);
}

/**
 * The whole transition: reset now, and again once layout settles.
 *
 * Both passes are kept. The immediate one covers the case where the browser
 * never re-applies the offset, and the deferred one covers the case where it
 * does — and the observed 390px failure was the second. Running only the
 * deferred pass would leave one visible frame at the inherited offset.
 *
 * @returns {() => void} cancel for the deferred pass
 */
export function resetScrollOnAuthTransition(element, { view = globalThis } = {}) {
  resetWorkspaceScroll(element, { view });
  return afterLayout(() => resetWorkspaceScroll(element, { view }), { view });
}
