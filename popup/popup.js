import { groupByCategory } from "../lib/classifier.js";
import { recordsFor } from "../lib/records.js";
import { friendlyUrl, skipReason, storageKeyFor } from "../lib/scope.js";

const THEME_KEY = "ui:theme";
const RECORDS_PATH = "../rules/known-records.json";

const SKIP_MESSAGES = {
  search: "NightWatch skips search results, because the snippets quote text from other sites.",
  unsupported: "NightWatch only works on normal web pages.",
};

const SEVERITY_LABELS = {
  high: "Higher concern",
  medium: "Moderate concern",
  low: "Lower concern",
};

const LAYER_LABELS = {
  text: { label: "Wording", title: "Found by reading what the page says" },
  structure: { label: "Layout", title: "Found by checking how the page is built" },
};

const summaryEl = document.querySelector("#summary");
const resultsEl = document.querySelector("#results");
const recordsEl = document.querySelector("#records");
const contextEl = document.querySelector("#context");
const themeToggle = document.querySelector("#theme-toggle");

const openFindings = new Set();
let storageKey = null;

init();

async function init() {
  await initTheme();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? "";

  const skipped = skipReason(url);
  if (skipped) {
    showNote(SKIP_MESSAGES[skipped]);
    return;
  }

  storageKey = storageKeyFor(url);
  showRecords(url);

  const response = await chrome.runtime.sendMessage({ type: "NW_GET_RESULTS", url });
  if (!response?.ok) {
    showNote("Could not read results. Try reloading the page.");
    return;
  }

  render(response.record, url);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !storageKey) return;
    const change = changes[storageKey];
    if (change?.newValue) render(change.newValue, url);
  });
}

// Theme

async function initTheme() {
  let theme = "dark";
  try {
    const stored = await chrome.storage.local.get(THEME_KEY);
    if (stored[THEME_KEY] === "light") theme = "light";
  } catch {
    // Storage unavailable: stay on the default night theme.
  }
  applyTheme(theme);

  themeToggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next);
    chrome.storage.local.set({ [THEME_KEY]: next }).catch(() => {});
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggle.setAttribute("aria-pressed", String(theme === "light"));
}

// Rendering

function render(record, url) {
  resultsEl.replaceChildren();
  contextEl.replaceChildren();

  if (!record) {
    showNote(
      url.startsWith("file:")
        ? "Nothing scanned here yet. For local files, turn on “Allow access to file URLs” on the NightWatch card in chrome://extensions, then reload the page."
        : "Nothing scanned here yet — reload the page, then reopen NightWatch.",
    );
    return;
  }

  const { findings } = record;
  summaryEl.replaceChildren(findings.length ? renderTally(findings) : renderQuiet());

  for (const group of groupByCategory(findings)) {
    resultsEl.append(renderCategory(group));
  }
  renderContext(record);
}

function renderTally(findings) {
  const count = findings.length;
  const tally = element("div", "", "tally");
  tally.append(element("span", String(count), "tally-number"));

  const words = document.createElement("div");
  words.append(
    element("p", `dark pattern${count === 1 ? "" : "s"} found on this page`, "tally-label"),
  );

  const breakdown = element("ul", "", "tally-breakdown");
  for (const severity of ["high", "medium", "low"]) {
    const n = findings.filter((finding) => finding.severity === severity).length;
    if (n) breakdown.append(element("li", `${n} ${SEVERITY_LABELS[severity].toLowerCase()}`, `severity-${severity}`));
  }
  words.append(breakdown);
  tally.append(words);
  return tally;
}

function renderQuiet() {
  const quiet = element("div", "", "quiet");
  quiet.append(
    element("p", "All quiet", "quiet-title"),
    element("p", "No dark patterns found in this page's wording or layout."),
  );
  return quiet;
}

function renderCategory({ category, findings }) {
  const section = element("section", "", "category");
  const head = element("div", "", "category-head");
  head.append(element("h2", category), element("span", String(findings.length), "category-count"));
  section.append(head);

  for (const finding of findings) section.append(renderFinding(finding));
  return section;
}

function renderFinding(finding) {
  const details = element("details", "", `finding severity-${finding.severity}`);
  details.open = openFindings.has(finding.id);
  details.addEventListener("toggle", () => {
    if (details.open) openFindings.add(finding.id);
    else openFindings.delete(finding.id);
  });

  const summary = document.createElement("summary");
  summary.append(element("span", finding.approach, "finding-name"));

  const layer = LAYER_LABELS[finding.layer];
  if (layer) {
    const chip = element("span", layer.label, "layer");
    chip.title = layer.title;
    summary.append(chip);
  }
  if (finding.matchCount > 1) {
    const seen = element("span", `${finding.matchCount}×`, "seen");
    seen.title = `Seen ${finding.matchCount} times on this page`;
    summary.append(seen);
  }

  summary.append(element("span", SEVERITY_LABELS[finding.severity] ?? "", "visually-hidden"));
  summary.append(chevron());
  details.append(summary);

  const body = element("div", "", "finding-body");
  const mechanism = element("p", "", "mechanism");
  mechanism.append(element("span", "Plays on "), document.createTextNode(finding.mechanism));
  body.append(mechanism, element("p", finding.explanation, "explanation"));


  if (finding.evidence.length > 0) {
    // Wording evidence is quoted straight off the page
    const list = element("ul", "", "evidence");
    const quoted = finding.layer !== "structure";
    for (const line of finding.evidence) list.append(element("li", quoted ? `“${line}”` : line));
    body.append(list);
  }
  if (finding.source) body.append(element("p", finding.source, "source"));

  details.append(body);
  return details;
}

/**
 * Documented regulator actions against the company behind this site. Kept
 * apart from the detections, and out of the badge count: it is what a
 * regulator alleged about the company, not something seen on this page.
 */
async function showRecords(url) {
  let data;
  try {
    data = await (await fetch(RECORDS_PATH)).json();
  } catch {
    return;
  }
  const records = recordsFor(url, data);
  if (!records.length) return;

  const head = element("div", "", "records-head");
  head.append(element("h2", "On record"), element("span", "About the company, not this page", "records-hint"));
  recordsEl.replaceChildren(head);

  for (const record of records) {
    const item = element("div", "", "record");
    item.append(
      element("p", record.pattern, "record-pattern"),
      element("p", record.summary, "record-summary"),
      element("p", record.source, "record-source"),
    );
    recordsEl.append(item);
  }
  recordsEl.hidden = false;
}

function renderContext(record) {
  const when = new Date(record.scannedAt).toLocaleTimeString();
  contextEl.append(element("span", friendlyUrl(record.url), "context-url"));
  contextEl.append(element("span", `Scanned ${when} · wording and layout checked`));
}

function showNote(text) {
  summaryEl.replaceChildren(element("p", text, "note"));
}

function chevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "chevron");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4 6l4 4 4-4");
  svg.append(path);
  return svg;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
