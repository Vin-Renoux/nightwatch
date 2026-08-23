/**
 * NightWatch service worker — classification and state.
 *
 * Content scripts send page text here; this runs the Layer 1 rules over it,
 * persists the result per site in chrome.storage.local, and answers the popup.
 * Nothing leaves the browser (brief §11).
 */

import { classifySegments, compileRules } from "../lib/classifier.js";

console.log("[NightWatch] service worker started");

const RULES_PATH = "rules/keyword-rules.json";
const SITE_KEY_PREFIX = "site:";
const MAX_STORED_SITES = 50;

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
    readSiteRecord(message.origin)
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
  const origin = originOf(message.url);
  if (!origin) return { ok: true, skipped: "unsupported-scheme" };

  const rules = await loadRules();
  const findings = classifySegments(message.segments, rules);

  await writeSiteRecord({
    origin,
    url: message.url,
    title: message.title ?? "",
    scannedAt: Date.now(),
    findings,
  });

  const tabId = sender.tab?.id;
  if (typeof tabId === "number") await updateBadge(tabId, findings.length);

  console.log(
    `[NightWatch] ${findings.length} pattern(s) on ${message.url} (${message.reason})`,
  );
  return { ok: true, count: findings.length };
}

/** Only normal web pages are scannable — chrome:// and extension pages are not. */
function originOf(url) {
  try {
    const { origin, protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? origin : null;
  } catch {
    return null;
  }
}

async function readSiteRecord(origin) {
  if (!origin) return null;
  const key = SITE_KEY_PREFIX + origin;
  const stored = await chrome.storage.local.get(key);
  return stored[key] ?? null;
}

async function writeSiteRecord(record) {
  await chrome.storage.local.set({ [SITE_KEY_PREFIX + record.origin]: record });
  await pruneStoredSites();
}

/** Keep local storage bounded — drop the least recently scanned sites. */
async function pruneStoredSites() {
  const everything = await chrome.storage.local.get(null);
  const keys = Object.keys(everything).filter((key) => key.startsWith(SITE_KEY_PREFIX));
  if (keys.length <= MAX_STORED_SITES) return;

  keys.sort((a, b) => (everything[a]?.scannedAt ?? 0) - (everything[b]?.scannedAt ?? 0));
  await chrome.storage.local.remove(keys.slice(0, keys.length - MAX_STORED_SITES));
}

async function updateBadge(tabId, count) {
  try {
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" });
  } catch {
    // Tab was closed while we were classifying.
  }
}
