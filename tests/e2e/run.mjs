#!/usr/bin/env node
/**
 * End-to-end checks: load the real extension into a headless browser, open the
 * fixture pages, click where a shopper would, and read back what NightWatch
 * stored for each page. Not part of `npm test`, because it needs a browser.
 *
 *   npm run test:e2e
 *   npm run test:e2e -- --verbose        (show the evidence for every finding)
 *   NIGHTWATCH_BROWSER=/path/to/chrome npm run test:e2e
 *   NIGHTWATCH_EXTENSION=/path/to/unzipped/package npm run test:e2e   (test a release build)
 *
 * Clicks go through the DevTools protocol, so the page receives trusted input
 * exactly as it would from a person — which matters, because NightWatch tells a
 * pop-up the shopper opened apart from one that opened by itself.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// Test a built package instead of the source tree: NIGHTWATCH_EXTENSION=/path/to/unzipped
const EXTENSION = process.env.NIGHTWATCH_EXTENSION ?? ROOT;
// --verbose prints the evidence behind every finding, not only failures.
const VERBOSE = process.argv.includes("--verbose");
const FIXTURES = join(ROOT, "tests", "fixtures");
const BROWSER_CANDIDATES = [
  process.env.NIGHTWATCH_BROWSER,
  "/usr/bin/brave",
  "/usr/bin/brave-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/**
 * Each scenario opens one fixture. `exactly` lists every rule id that must be
 * stored for the page — anything missing or extra fails. `actions` are clicks
 * at a time after the page starts loading. `check` adds any further assertion.
 */
const SCENARIOS = [
  {
    name: "Layer 1 — product page wording",
    page: "mock-product-page.html",
    settle: 3500,
    exactly: [
      "cancellation-obstruction",
      "confirmshaming",
      "forced-account-creation",
      "forced-continuity",
      "hidden-costs",
      "nagging-newsletter",
      "price-anchoring",
      "scarcity-low-stock",
      "sneak-into-basket",
      "social-proof-activity",
      "social-proof-badges",
      "trick-wording",
      "urgency-deadline",
    ],
  },
  { name: "Layer 1 — login wall", page: "mock-login-wall.html", settle: 3000, exactly: ["login-wall"] },
  { name: "Layer 1 — course catalogue is not a shop", page: "mock-non-commerce-page.html", settle: 3000, exactly: [] },
  {
    name: "Layer 1 — late content behind a ticking countdown",
    page: "mock-dynamic-page.html",
    settle: 7000,
    exactly: ["scarcity-low-stock", "urgency-deadline"],
  },
  {
    name: "Layer 2 — screenshots 190443 and 190529",
    page: "mock-popups.html",
    settle: 9000,
    exactly: ["biased-buttons", "nagging-notifications", "unprompted-popup"],
    check: (record) => expectCount(record, "unprompted-popup", 2),
  },
  {
    name: "Layer 2 — screenshot 222652",
    page: "mock-trial-modal.html",
    settle: 6000,
    exactly: ["forced-continuity", "price-anchoring", "unprompted-popup", "urgency-deadline"],
  },
  {
    name: "Layer 2 — pop-up and box the shopper opened and ticked",
    page: "mock-prompted.html",
    // Tick the box first: once the size guide is open, its mask covers the page.
    actions: [
      { at: 2000, click: "#newsletter-label" },
      { at: 3500, click: "#size-guide" },
    ],
    settle: 8000,
    exactly: [],
    // Without this, a click that missed would pass with nothing to report.
    pageCheck: `document.getElementById("guide").classList.contains("open") &&
      document.querySelector('input[name="newsletter"]').checked`,
    check: (record) => (record?.findings ? null : "no record was stored — the page was never scanned"),
  },
  {
    name: "Layer 2 — the same page, where the site does both by itself",
    page: "mock-prompted.html?auto=1",
    settle: 6000,
    exactly: ["preticked-consent", "unprompted-popup"],
  },
  {
    name: "Layer 2 — checkout with pre-ticked boxes",
    page: "mock-checkout.html",
    settle: 3500,
    exactly: ["biased-buttons", "preticked-addon", "preticked-consent"],
    check: (record) =>
      expectCount(record, "preticked-addon", 2) ?? expectCount(record, "preticked-consent", 2),
  },
  {
    name: "Layer 2 — balanced cookie banner",
    page: "mock-cookie-banner.html?style=balanced",
    settle: 4500,
    exactly: [],
    check: (record) =>
      record?.superseded?.includes("biased-cookie-choices")
        ? null
        : "the wording-based cookie guess was not settled by measuring the buttons",
  },
  {
    name: "Layer 2 — biased cookie banner",
    page: "mock-cookie-banner.html?style=biased",
    settle: 4500,
    exactly: ["biased-buttons"],
  },
  {
    name: "Layer 1 — Temu badges, including a picture badge",
    page: "mock-temu-listing.html",
    settle: 3500,
    exactly: ["social-proof-activity", "social-proof-badges"],
    check: (record) => {
      const badges = record?.findings?.find((finding) => finding.id === "social-proof-badges");
      if (!badges) return "social-proof-badges missing";
      // Read from <img alt>, so this proves picture badges are seen.
      if (badges.matchCount < 5) return `only ${badges.matchCount} of 5 badges seen`;
      return null;
    },
  },
  {
    name: "Layer 2 — a tucked-away cancel link",
    page: "mock-account-page.html",
    settle: 3500,
    exactly: ["hidden-cancel-link"],
    check: (record) => expectCount(record, "hidden-cancel-link", 1),
  },
  {
    name: "Layer 2 — app shell with a pop-up inside it",
    page: "mock-app-shell.html",
    settle: 6000,
    exactly: ["biased-buttons", "unprompted-popup"],
    check: (record) => expectCount(record, "unprompted-popup", 1),
  },
];

function expectCount(record, id, count) {
  const finding = record?.findings?.find((candidate) => candidate.id === id);
  if (!finding) return `${id} missing`;
  return finding.matchCount === count ? null : `${id} seen ${finding.matchCount}×, expected ${count}×`;
}

// ---------------------------------------------------------------------------

async function main() {
  const browserPath = BROWSER_CANDIDATES.find((path) => path && existsSync(path));
  if (!browserPath) {
    console.error("No Chromium-based browser found. Set NIGHTWATCH_BROWSER to its executable.");
    return 2;
  }

  const server = await serveFixtures();
  const profile = mkdtempSync(join(tmpdir(), "nightwatch-e2e-"));
  const browser = spawn(
    browserPath,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--window-size=1280,900",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      `--load-extension=${EXTENSION}`,
      `--disable-extensions-except=${EXTENSION}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let failures = 0;
  try {
    const cdp = await Cdp.connect(await devtoolsUrl(profile));
    const extensionId = await waitForExtension(cdp);
    const storage = await openStorageReader(cdp, extensionId);

    console.log(`NightWatch end-to-end — ${browserPath}\nextension: ${EXTENSION}\n`);
    for (const [index, scenario] of SCENARIOS.entries()) {
      const url = withQuery(`${server.origin}/${scenario.page}`, `run=${index}`);
      const { record, pageOk } = await runScenario(cdp, storage, url, scenario);
      failures += report(scenario, record, pageOk) ? 0 : 1;
    }
    console.log(`\n${SCENARIOS.length - failures} passed, ${failures} failed`);
    cdp.close();
  } catch (error) {
    failures += 1;
    console.error(error);
  } finally {
    // The browser keeps writing to its profile while it shuts down.
    const exited = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill();
    await Promise.race([exited, sleep(5000)]);
    server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return failures ? 1 : 0;
}

// ---------------------------------------------------------------------------

async function runScenario(cdp, storage, url, scenario) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  try {
    const started = Date.now();
    await cdp.send("Page.navigate", { url }, sessionId);
    for (const action of scenario.actions ?? []) {
      await sleep(started + action.at - Date.now());
      await click(cdp, sessionId, action.click);
    }
    await sleep(started + scenario.settle - Date.now());
    const pageOk = scenario.pageCheck ? await evaluate(cdp, sessionId, scenario.pageCheck) : true;
    return { record: await storage.read(storageKey(url)), pageOk };
  } finally {
    await cdp.send("Target.closeTarget", { targetId });
  }
}

function report(scenario, record, pageOk) {
  const ids = [...new Set((record?.findings ?? []).map((finding) => finding.id))].sort();
  const expected = [...scenario.exactly].sort();
  const missing = expected.filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !expected.includes(id));
  const problem =
    (pageOk ? null : "the page did not end up in the expected state — did a click miss?") ??
    scenario.check?.(record) ??
    null;
  const passed = !missing.length && !extra.length && !problem;

  console.log(`  ${passed ? "✓" : "✗"} ${scenario.name}  (${ids.length} found)`);
  if (missing.length) console.log(`      missing: ${missing.join(", ")}`);
  if (extra.length) console.log(`      unexpected: ${extra.join(", ")}`);
  if (problem) console.log(`      ${problem}`);
  if (!passed || VERBOSE) {
    for (const finding of record?.findings ?? []) {
      console.log(`      · ${finding.id}: ${finding.evidence.join(" | ")}`);
    }
  }
  return passed;
}

async function evaluate(cdp, sessionId, expression) {
  const { result } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  return result.value;
}

/** A trusted click in the middle of the element. */
async function click(cdp, sessionId, selector) {
  const { result } = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return null;
        element.scrollIntoView({ block: "center" });
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
      returnByValue: true,
    },
    sessionId,
  );
  const point = result.value;
  if (!point) throw new Error(`nothing matches ${selector}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.send(
      "Input.dispatchMouseEvent",
      { type, x: point.x, y: point.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 },
      sessionId,
    );
  }
}

/** Mirrors storageKeyFor() in lib/scope.js. */
function storageKey(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  return `page:${parsed.href}`;
}

function withQuery(url, query) {
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

async function waitForExtension(cdp) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const worker = targetInfos.find(
      (target) => target.type === "service_worker" && target.url.endsWith("/background/service-worker.js"),
    );
    if (worker) return new URL(worker.url).host;
    await sleep(100);
  }
  throw new Error("the extension's service worker never started — check the manifest loads");
}

/**
 * Reads chrome.storage from an extension page rather than the service worker,
 * which the browser may stop whenever it is idle.
 */
async function openStorageReader(cdp, extensionId) {
  const { targetId } = await cdp.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/popup/popup.html`,
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await sleep(500);
  return {
    async read(key) {
      const { result, exceptionDetails } = await cdp.send(
        "Runtime.evaluate",
        {
          expression: `chrome.storage.local.get(${JSON.stringify(key)}).then((all) => all[${JSON.stringify(key)}] ?? null)`,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      );
      if (exceptionDetails) throw new Error(`reading storage failed: ${exceptionDetails.text}`);
      return result.value;
    },
  };
}

async function devtoolsUrl(profileDir) {
  const portFile = join(profileDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 150 && !existsSync(portFile); attempt++) await sleep(100);
  if (!existsSync(portFile)) throw new Error("the browser did not open a DevTools port");
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  return `ws://127.0.0.1:${port}${path}`;
}

async function serveFixtures() {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
  const httpServer = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = normalize(join(FIXTURES, path));
    if (!file.startsWith(FIXTURES + sep) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": types[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(readFileSync(file));
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${httpServer.address().port}`,
    close: () => httpServer.close(),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** A minimal DevTools protocol client over Node's built-in WebSocket. */
class Cdp {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error(`could not connect to ${url}`));
    });
    return new Cdp(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiter = message.id && this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
    };
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close() {
    this.socket.close();
  }
}

process.exit(await main());
