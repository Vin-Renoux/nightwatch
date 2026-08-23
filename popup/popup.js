/**
 * NightWatch popup — renders the patterns the service worker found.
 *
 * All page-derived strings go in via textContent, never innerHTML: evidence
 * quotes are untrusted text lifted straight off the site being scanned.
 */

import { groupByCategory } from "../lib/classifier.js";

const statusEl = document.querySelector("#status");
const resultsEl = document.querySelector("#results");
const contextEl = document.querySelector("#context");

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const origin = originOf(tab?.url);

  if (!origin) {
    setStatus("NightWatch only works on normal web pages.");
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: "NW_GET_RESULTS", origin });

  if (!response?.ok) {
    setStatus("Could not read results. Try reloading the page.");
    return;
  }

  render(response.record);
}

function render(record) {
  if (!record) {
    setStatus("Nothing scanned here yet — reload the page, then reopen NightWatch.");
    return;
  }

  if (record.findings.length === 0) {
    setStatus("No dark patterns found in this page's text.");
    renderContext(record);
    return;
  }

  const count = record.findings.length;
  setStatus(`Warning! ${count} dark pattern${count === 1 ? "" : "s"} detected.`, true);

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
  article.className = `finding ${finding.severity}`;

  article.append(element("h3", finding.approach));
  article.append(element("p", `Uses: ${finding.mechanism}`, "mechanism"));
  article.append(element("p", finding.explanation, "explanation"));

  if (finding.evidence.length > 0) {
    const list = document.createElement("ul");
    list.className = "evidence";
    for (const quote of finding.evidence) list.append(element("li", `“${quote}”`));
    article.append(list);
  }

  if (finding.source) {
    article.append(element("p", finding.source, "source"));
  }

  return article;
}

function renderContext(record) {
  const when = new Date(record.scannedAt).toLocaleTimeString();
  contextEl.textContent = `Scanned ${record.url} at ${when}. Text checks only — structural checks are still to come.`;
}

function setStatus(text, isAlert = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("alert", isAlert);
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function originOf(url) {
  try {
    const { origin, protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? origin : null;
  } catch {
    return null;
  }
}
