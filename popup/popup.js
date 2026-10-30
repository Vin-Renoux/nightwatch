/**
 * NightWatch popup — renders the patterns the service worker found.
 *
 * All page-derived strings go in via textContent, never innerHTML: evidence
 * quotes are untrusted text lifted straight off the site being scanned.
 */

import { groupByCategory } from "../lib/classifier.js";
import { friendlyUrl, skipReason, storageKeyFor } from "../lib/scope.js";

const SKIP_MESSAGES = {
  search: "NightWatch skips search results, because the snippets quote text from other sites.",
  unsupported: "NightWatch only works on normal web pages.",
};

const SEVERITY_LABELS = {
  high: "Higher concern",
  medium: "Moderate concern",
  low: "Lower concern",
};

// Which detection layer found it — the hybrid approach in brief §1, made visible.
const LAYER_LABELS = {
  text: { label: "Wording", title: "Found by reading what the page says" },
  structure: { label: "Layout", title: "Found by checking how the page is built" },
};

const statusEl = document.querySelector("#status");
const resultsEl = document.querySelector("#results");
const contextEl = document.querySelector("#context");
const tallyEl = document.querySelector("#tally");

let storageKey = null;

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? "";

  const skipped = skipReason(url);
  if (skipped) {
    setStatus(SKIP_MESSAGES[skipped]);
    return;
  }

  storageKey = storageKeyFor(url);

  const response = await chrome.runtime.sendMessage({ type: "NW_GET_RESULTS", url });
  if (!response?.ok) {
    setStatus("Could not read results. Try reloading the page.");
    return;
  }

  render(response.record, url);

  // A rescan can land while the popup is sitting open — follow it rather than
  // leaving a stale count on screen while the toolbar badge moves on without us.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !storageKey) return;
    const change = changes[storageKey];
    if (change?.newValue) render(change.newValue, url);
  });
}

function render(record, url) {
  resultsEl.replaceChildren();
  contextEl.replaceChildren();

  if (!record) {
    // Content scripts do not run on local files unless the user turns on
    // "Allow access to file URLs", which is easy to miss when testing fixtures.
    setStatus(
      url.startsWith("file:")
        ? "Nothing scanned here yet. For local files, turn on “Allow access to file URLs” on the NightWatch card in chrome://extensions, then reload the page."
        : "Nothing scanned here yet — reload the page, then reopen NightWatch.",
    );
    return;
  }

  const count = record.findings.length;
  setTally(count);

  if (count === 0) {
    setStatus("No dark patterns found in this page's text.");
    renderContext(record);
    return;
  }

  setStatus(`Warning — ${count} dark pattern${count === 1 ? "" : "s"} found on this page.`, true);

  for (const group of groupByCategory(record.findings)) {
    resultsEl.append(renderCategory(group));
  }
  renderContext(record);
}

function renderCategory({ category, findings }) {
  const section = document.createElement("section");
  section.className = "category";
  section.append(element("h2", category));
  for (const finding of findings) section.append(renderFinding(finding));
  return section;
}

function renderFinding(finding) {
  const article = document.createElement("article");
  article.className = "finding";

  const head = document.createElement("div");
  head.className = "finding-head";

  const dot = document.createElement("span");
  dot.className = `dot ${finding.severity}`;
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", SEVERITY_LABELS[finding.severity] ?? "");
  head.append(dot, element("h3", finding.approach));

  const layer = LAYER_LABELS[finding.layer];
  if (layer) {
    const chip = element("span", layer.label, "layer");
    chip.title = layer.title;
    head.append(chip);
  }

  if (finding.matchCount > 1) {
    head.append(element("span", `${finding.matchCount}×`, "seen"));
  }

  article.append(head);
  article.append(element("p", `Plays on: ${finding.mechanism}`, "mechanism"));
  article.append(element("p", finding.explanation, "explanation"));

  if (finding.evidence.length > 0) {
    const list = document.createElement("ul");
    list.className = "evidence";
    // Wording evidence is quoted straight off the page; layout evidence is
    // NightWatch's own description of what it measured, so it is not.
    const quoted = finding.layer !== "structure";
    for (const line of finding.evidence) list.append(element("li", quoted ? `“${line}”` : line));
    article.append(list);
  }

  if (finding.source) {
    article.append(element("p", finding.source, "source"));
  }

  return article;
}

function renderContext(record) {
  const when = new Date(record.scannedAt).toLocaleTimeString();
  contextEl.append(element("span", friendlyUrl(record.url), "context-url"));
  contextEl.append(element("span", `Scanned ${when} · wording and layout checked`));
}

function setStatus(text, isAlert = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("alert", isAlert);
}

function setTally(count) {
  tallyEl.textContent = String(count);
  tallyEl.hidden = count === 0;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
