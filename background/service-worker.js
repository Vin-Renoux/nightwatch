/**
 * NightWatch service worker — classification and state.
 *
 * Content scripts send page text and layout measurements here; this runs the
 * Layer 1 (wording) and Layer 2 (structure) rules over them, accumulates the
 * result for that page in chrome.storage.local, and answers the popup.
 * Nothing leaves the browser (brief §11).
 */

import { classifySegments, compileRules, foldScan } from "../lib/classifier.js";
import { PAGE_KEY_PREFIX, isScannable, storageKeyFor } from "../lib/scope.js";
import { createSerialQueue } from "../lib/serial-queue.js";
import { classifyStructure, compileStructuralRules } from "../lib/structural.js";

console.log("[NightWatch] service worker started");

const TEXT_RULES_PATH = "rules/keyword-rules.json";
const STRUCTURE_RULES_PATH = "rules/structural-rules.json";
const MAX_STORED_PAGES = 100;

const compiledRules = new Map();
const textRules = () => loadRules(TEXT_RULES_PATH, compileRules);
const structureRules = () => loadRules(STRUCTURE_RULES_PATH, compileStructuralRules);

// One page at a time: see lib/serial-queue.js for what went wrong without it.
const pageQueue = createSerialQueue();

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

  if (message?.type === "NW_GET_STRUCTURE_CONFIG") {
    // Content scripts cannot fetch extension files without exposing them to
    // every website, so they ask for the wording they need instead.
    structureRules()
      .then((rules) =>
        sendResponse({
          ok: true,
          declinePatterns: rules.declineSources,
          cancelPatterns: rules.cancelSources,
        }),
      )
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "NW_GET_RESULTS") {
    readPageRecord(message.url)
      .then((record) => sendResponse({ ok: true, record }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});

/** Load and compile a rules file once per service-worker lifetime. */
function loadRules(path, compile) {
  if (!compiledRules.has(path)) {
    const loading = fetch(chrome.runtime.getURL(path))
      .then((response) => {
        if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
        return response.json();
      })
      .then(compile)
      .catch((error) => {
        compiledRules.delete(path); // let the next message retry rather than caching a failure
        throw error;
      });
    compiledRules.set(path, loading);
  }
  return compiledRules.get(path);
}

async function handlePageSignals(message, sender) {
  if (!isScannable(message.url)) return { ok: true, skipped: true };

  const key = storageKeyFor(message.url);
  if (!key) return { ok: true, skipped: true };

  const [text, structure] = await Promise.all([textRules(), structureRules()]);
  const wording = classifySegments(message.segments, text);
  const layout = classifyStructure(message.structure, structure);
  const tabId = sender.tab?.id;

  // Read, merge, write and badge as one unit. Interleaving these with another
  // scan of the same page is what left the badge and the popup disagreeing.
  const findings = await pageQueue(key, async () => {
    // Merge rather than replace: a rescan can catch the page mid-rebuild with
    // less text than before, and replacing would wipe real detections.
    const previous = await readRecord(key);
    const folded = foldScan(previous, [...wording, ...layout.findings], layout.supersedes);

    await writeRecord(key, {
      url: message.url,
      title: message.title ?? "",
      scannedAt: Date.now(),
      findings: folded.findings,
      superseded: folded.superseded,
    });

    if (typeof tabId === "number") await updateBadge(tabId, folded.findings.length);
    return folded.findings;
  });

  console.log(
    `[NightWatch] ${wording.length} wording + ${layout.findings.length} layout this pass, ` +
      `${findings.length} total on ${message.url} (${message.reason})`,
  );
  return { ok: true, count: findings.length };
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
