/**
 * NightWatch content script — page-side signal extraction.
 *
 * Collects what the service worker needs to judge the page (brief §3):
 *   - Layer 1: the visible text, split into segments;
 *   - Layer 2: measurements of pop-ups, buttons and ticked boxes, taken by
 *     content/structure.js, which the manifest loads just before this file.
 * All classification happens in the service worker. Keeping the page-side
 * work this small matters for the low-resource-device goal in §11.
 */

// Keep in sync with SEARCH_HOST_PATTERNS in lib/scope.js — content scripts
// cannot import ES modules, and tests/scope.test.js checks the two match.
const SEARCH_HOST_PATTERNS = [
  /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/,
  /(^|\.)bing\.com$/,
  /(^|\.)duckduckgo\.com$/,
  /(^|\.)search\.brave\.com$/,
  /(^|\.)search\.yahoo\.com$/,
  /(^|\.)ecosia\.org$/,
  /(^|\.)startpage\.com$/,
  /(^|\.)yandex\.[a-z.]+$/,
  /(^|\.)baidu\.com$/,
];

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "IFRAME",
  "SVG",
  "CANVAS",
  "HEAD",
]);
const MIN_SEGMENT_CHARS = 3;
const MAX_SEGMENT_CHARS = 400;
const MAX_SEGMENTS = 1500;
// Product photos often carry the whole product title as alt text; badges are short.
const MAX_ALT_CHARS = 60;

// Rescans after the page changes: quick at first, then backing off, so a tab
// left open on a ticking countdown costs little.
const RESCAN_DEBOUNCE_MS = 800;
const RESCAN_MAX_WAIT_MS = 4000;
const SLOW_RESCAN_DEBOUNCE_MS = 3000;
const SLOW_RESCAN_MAX_WAIT_MS = 12000;
const FAST_RESCANS = 20;
const MAX_RESCANS = 60;
// A click often opens a checkout step or a panel without changing the URL, so
// it buys a few more looks even after the budget is spent.
const RESCANS_PER_INTERACTION = 5;
// A newly seen pop-up is judged on a second look this long after the first.
const CONFIRM_DELAY_MS = 1200;
const MAX_CONFIRMS = 15;

// Pop-ups are usually already in the page, hidden, and shown by flipping one
// of these — which a childList-only observer never sees.
const WATCHED_ATTRIBUTES = [
  "class",
  "style",
  "hidden",
  "open",
  "aria-hidden",
  "aria-modal",
  "aria-checked",
];

if (SEARCH_HOST_PATTERNS.some((pattern) => pattern.test(location.hostname))) {
  console.log("[NightWatch] search results page — not scanning:", location.href);
} else {
  start();
}

function start() {
  console.log("[NightWatch] content script loaded on:", window.location.href);

  let lastUrl = location.href;
  let rescans = 0;
  let confirmsLeft = MAX_CONFIRMS;
  let debounceTimer = null;
  let maxWaitTimer = null;
  let confirmTimer = null;
  let watching = false;
  let previousScanAt = 0; // performance.now() of the last look; 0 is navigation start
  let changedSince = null; // when the page first changed after the last look
  let configPromise = requestStructureConfig();

  // If structure.js failed to load, keep the text checks running without it.
  const collector = globalThis.NightWatchStructure?.create({ onInteraction: extendBudget }) ?? null;
  const observer = new MutationObserver(onMutation);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => scan("load"), { once: true });
  } else {
    scan("load");
  }

  observe();
  // Single-page navigations (clicking a product) change the URL without a reload.
  addEventListener("popstate", checkForNavigation);

  function onMutation() {
    if (checkForNavigation()) return;
    if (changedSince === null) changedSince = performance.now();
    scheduleRescan();
  }

  function checkForNavigation() {
    if (location.href === lastUrl) return false;
    lastUrl = location.href;
    rescans = 0; // new page, fresh budget
    confirmsLeft = MAX_CONFIRMS;
    clearTimers();
    observe();
    scan("navigation");
    return true;
  }

  function scheduleRescan() {
    if (rescans >= MAX_RESCANS) return;
    const slow = rescans >= FAST_RESCANS;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runRescan, slow ? SLOW_RESCAN_DEBOUNCE_MS : RESCAN_DEBOUNCE_MS);
    // A live countdown mutates every second, which would reset the debounce
    // forever and mean the page is never rescanned. Force one through.
    if (maxWaitTimer === null) {
      maxWaitTimer = setTimeout(runRescan, slow ? SLOW_RESCAN_MAX_WAIT_MS : RESCAN_MAX_WAIT_MS);
    }
  }

  function runRescan() {
    clearTimers();
    rescans += 1;
    scan("mutation");
    if (rescans >= MAX_RESCANS) {
      stopWatching();
      console.log("[NightWatch] rescan budget reached, watching paused until the next click");
    }
  }

  function extendBudget() {
    if (rescans < MAX_RESCANS) return;
    rescans = MAX_RESCANS - RESCANS_PER_INTERACTION;
    observe();
  }

  function scheduleConfirm() {
    if (confirmTimer !== null || confirmsLeft <= 0) return;
    confirmsLeft -= 1;
    confirmTimer = setTimeout(() => {
      confirmTimer = null;
      scan("confirm");
    }, CONFIRM_DELAY_MS);
  }

  function clearTimers() {
    clearTimeout(debounceTimer);
    clearTimeout(maxWaitTimer);
    debounceTimer = null;
    maxWaitTimer = null;
  }

  function observe() {
    if (watching) return;
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRIBUTES,
    });
    watching = true;
  }

  function stopWatching() {
    observer.disconnect();
    watching = false;
  }

  async function scan(reason) {
    // Anything new on screen appeared after the page first changed since the
    // last look — which is what tells a pop-up the shopper clicked open from
    // one that opened by itself.
    const since = changedSince ?? previousScanAt;
    changedSince = null;
    previousScanAt = performance.now();

    const segments = extractVisibleText();
    let structure = null;
    if (collector) {
      const config = await configPromise;
      if (config.retry) configPromise = requestStructureConfig();
      const result = collector.collect({
        declinePattern: config.declinePattern,
        cancelPattern: config.cancelPattern,
        changedSince: since,
      });
      structure = result.structure;
      if (result.pendingConfirm) scheduleConfirm();
    }
    if (segments.length === 0 && !hasStructure(structure)) return;

    chrome.runtime
      .sendMessage({
        type: "NW_PAGE_SIGNALS",
        reason,
        url: location.href,
        title: document.title,
        segments,
        structure,
      })
      .catch(() => {
        // Service worker asleep or page unloading — the next scan will retry.
      });
  }
}

/** The "no" and "cancel" wording from rules/structural-rules.json, one pattern each. */
function requestStructureConfig() {
  return chrome.runtime
    .sendMessage({ type: "NW_GET_STRUCTURE_CONFIG" })
    .then((reply) => {
      const sources = reply?.declinePatterns ?? [];
      if (!sources.length) throw new Error("no decline wording");
      return {
        declinePattern: combine(sources),
        cancelPattern: combine(reply?.cancelPatterns ?? []),
      };
    })
    .catch(() => ({ declinePattern: null, cancelPattern: null, retry: true }));
}

// One combined pattern, so each link on a big page costs one test, not twenty.
function combine(sources) {
  return sources.length ? new RegExp(sources.map((source) => `(?:${source})`).join("|"), "i") : null;
}

function hasStructure(structure) {
  return Boolean(
    structure &&
      (structure.overlays.length ||
        structure.groups.length ||
        structure.checkboxes.length ||
        structure.cancelLinks.length),
  );
}

/** Every distinct piece of visible text on the page, as separate segments. */
function extractVisibleText() {
  if (!document.body) return [];

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const segments = [];
  const seen = new Set();

  let node;
  while ((node = walker.nextNode())) {
    if (segments.length >= MAX_SEGMENTS) break;

    const parent = node.parentElement;
    if (!parent || SKIP_TAGS.has(parent.tagName)) continue;

    // Straighten curly apostrophes so "Don’t" matches the same rules as "Don't".
    const text = node.nodeValue
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < MIN_SEGMENT_CHARS || seen.has(text)) continue;
    if (!isVisible(parent)) continue;

    seen.add(text);
    segments.push(text.slice(0, MAX_SEGMENT_CHARS));
  }

  // Some badges ("AMAZING FIND", "Best seller") are pictures of words. Their
  // alt text is what a screen reader announces, so treat it as page wording.
  for (const image of document.images) {
    if (segments.length >= MAX_SEGMENTS) break;
    const alt = (image.alt ?? "").replace(/\s+/g, " ").trim();
    if (alt.length < MIN_SEGMENT_CHARS || alt.length > MAX_ALT_CHARS || seen.has(alt)) continue;
    if (!isVisible(image)) continue;
    seen.add(alt);
    segments.push(alt);
  }

  return segments;
}

function isVisible(element) {
  if (!element) return false;
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
}
