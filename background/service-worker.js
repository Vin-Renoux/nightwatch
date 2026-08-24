/**
 * NightWatch service worker — classification and state.
 *
 * Content scripts send page text here; this runs the Layer 1 rules over it,
 * accumulates the result for that page in chrome.storage.local, and answers
 * the popup. Nothing leaves the browser (brief §11).
 */

import { classifySegments, compileRules, mergeFindings } from "../lib/classifier.js";
import { isScannable, pageKeyFor } from "../lib/scope.js";

console.log("[NightWatch] service worker started");

const RULES_PATH = "rules/keyword-rules.json";
const PAGE_KEY_PREFIX = "page:";
const MAX_STORED_PAGES = 100;

let rulesPromise = null;

chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });

chrome.runtime.onInstalled.addListener(() => {
  console.log("[NightWatch] extension installed");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "NW_PAGE_SIGNALS") {
    handlePageSignals(message, sender)
      .then(sendResponse)
      .catch((error) => {
        console.error("[NightWatch] failed to classify page:", error);
        sendResponse({ ok: false, error: String(error) });
      });
    return true; // keep the message channel open for the async reply
  }

  if (message?.type === "NW_GET_RESULTS") {
    readPageRecord(message.url)
      .then((record) => sendResponse({ ok: true, record }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});

/** Load and compile the Layer 1 rules once per service-worker lifetime. */
function loadRules() {
  if (!rulesPromise) {
    rulesPromise = fetch(chrome.runtime.getURL(RULES_PATH))
      .then((response) => {
        if (!response.ok) throw new Error(`rules request failed: HTTP ${response.status}`);
        return response.json();
      })
      .then(compileRules)
      .catch((error) => {
        rulesPromise = null; // let the next message retry rather than caching a failure
        throw error;
      });
  }
  return rulesPromise;
}

async function handlePageSignals(message, sender) {
  if (!isScannable(message.url)) return { ok: true, skipped: true };

  const key = storageKeyFor(message.url);
  if (!key) return { ok: true, skipped: true };

  const rules = await loadRules();
  const findings = classifySegments(message.segments, rules);

  // Merge rather than replace: a rescan can catch the page mid-rebuild with
  // less text than before, and replacing would wipe real detections.
  const previous = await readRecord(key);
  const merged = mergeFindings(previous?.findings, findings);

  await writeRecord(key, {
    url: message.url,
    title: message.title ?? "",
    scannedAt: Date.now(),
    findings: merged,
  });

  const tabId = sender.tab?.id;
  if (typeof tabId === "number") await updateBadge(tabId, merged.length);

  console.log(
    `[NightWatch] ${findings.length} this pass, ${merged.length} total on ${message.url} (${message.reason})`,
  );
  return { ok: true, count: merged.length };
}

function storageKeyFor(url) {
  const pageKey = pageKeyFor(url);
  return pageKey ? PAGE_KEY_PREFIX + pageKey : null;
}

async function readPageRecord(url) {
  const key = storageKeyFor(url);
  return key ? readRecord(key) : null;
}

async function readRecord(key) {
  const stored = await chrome.storage.local.get(key);
  return stored[key] ?? null;
}

async function writeRecord(key, record) {
  await chrome.storage.local.set({ [key]: record });
  await pruneStoredPages();
}

/** Keep local storage bounded — drop the least recently scanned pages. */
async function pruneStoredPages() {
  const everything = await chrome.storage.local.get(null);
  const keys = Object.keys(everything).filter((key) => key.startsWith(PAGE_KEY_PREFIX));
  if (keys.length <= MAX_STORED_PAGES) return;

  keys.sort((a, b) => (everything[a]?.scannedAt ?? 0) - (everything[b]?.scannedAt ?? 0));
  await chrome.storage.local.remove(keys.slice(0, keys.length - MAX_STORED_PAGES));
}

async function updateBadge(tabId, count) {
  try {
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" });
  } catch {
    // Tab was closed while we were classifying.
  }
}
