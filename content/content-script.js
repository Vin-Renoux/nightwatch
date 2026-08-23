/**
 * NightWatch content script — Layer 1 signal extraction.
 *
 * Its only job is to pull visible text out of the page and hand it to the
 * service worker, which does the classifying (brief §3). Keeping the page-side
 * work this small matters for the low-resource-device goal in §11.
 */

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
const MAX_RESCANS = 25; // stop following an infinitely-scrolling page forever

console.log("[NightWatch] content script loaded on:", window.location.href);

let rescans = 0;
let debounce = null;

function isVisible(element) {
  if (!element) return false;
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
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

function scheduleRescan() {
  if (rescans >= MAX_RESCANS) return;
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    rescans += 1;
    scan("mutation");
    if (rescans >= MAX_RESCANS) observer.disconnect();
  }, RESCAN_DEBOUNCE_MS);
}

// Shops render prices, banners and cart nudges after first paint, so one scan
// at load is not enough — watch for changes, debounced.
const observer = new MutationObserver(scheduleRescan);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => scan("load"), { once: true });
} else {
  scan("load");
}

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
});
