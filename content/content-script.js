/**
 * NightWatch content script — Layer 1 signal extraction.
 *
 * Its only job is to pull visible text out of the page and hand it to the
 * service worker, which does the classifying (brief §3). Keeping the page-side
 * work this small matters for the low-resource-device goal in §11.
 */

// Keep in sync with SEARCH_HOST_PATTERNS in lib/scope.js — content scripts
// cannot import ES modules, and tests/classifier.test.js checks the two match.
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
const RESCAN_DEBOUNCE_MS = 800;
const RESCAN_MAX_WAIT_MS = 4000;
const MAX_RESCANS = 40;

if (SEARCH_HOST_PATTERNS.some((pattern) => pattern.test(location.hostname))) {
  console.log("[NightWatch] search results page — not scanning:", location.href);
} else {
  start();
}

function start() {
  console.log("[NightWatch] content script loaded on:", window.location.href);

  let lastUrl = location.href;
  let rescans = 0;
  let debounceTimer = null;
  let maxWaitTimer = null;

  // Shops render prices, banners and cart nudges after first paint, so one scan
  // at load is not enough — watch for changes.
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
    scheduleRescan();
  }

  function checkForNavigation() {
    if (location.href === lastUrl) return false;
    lastUrl = location.href;
    rescans = 0; // new page, fresh budget
    clearTimers();
    observe();
    scan("navigation");
    return true;
  }

  function scheduleRescan() {
    if (rescans >= MAX_RESCANS) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runRescan, RESCAN_DEBOUNCE_MS);
    // A live countdown mutates every second, which would reset the debounce
    // forever and mean the page is never rescanned. Force one through.
    if (maxWaitTimer === null) maxWaitTimer = setTimeout(runRescan, RESCAN_MAX_WAIT_MS);
  }

  function runRescan() {
    clearTimers();
    rescans += 1;
    scan("mutation");
    if (rescans >= MAX_RESCANS) {
      observer.disconnect();
      console.log("[NightWatch] rescan budget reached, watching stopped");
    }
  }

  function clearTimers() {
    clearTimeout(debounceTimer);
    clearTimeout(maxWaitTimer);
    debounceTimer = null;
    maxWaitTimer = null;
  }

  function observe() {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function scan(reason) {
    const segments = extractVisibleText();
    if (segments.length === 0) return;

    chrome.runtime
      .sendMessage({
        type: "NW_PAGE_SIGNALS",
        reason,
        url: location.href,
        title: document.title,
        segments,
      })
      .catch(() => {
        // Service worker asleep or page unloading — the next scan will retry.
      });
  }
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

    const text = node.nodeValue.replace(/\s+/g, " ").trim();
    if (text.length < MIN_SEGMENT_CHARS || seen.has(text)) continue;
    if (!isVisible(parent)) continue;

    seen.add(text);
    segments.push(text.slice(0, MAX_SEGMENT_CHARS));
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
