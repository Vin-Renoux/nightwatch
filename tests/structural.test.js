/**
 * Unit tests for Layer 2 (structure) judgement. The measurements here have the
 * same shape content/structure.js sends from a real page, so each test reads as
 * "a page that measured like this".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CATEGORY_ORDER } from "../lib/classifier.js";
import { classifyStructure, compileStructuralRules, labelKind } from "../lib/structural.js";

const ruleData = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "rules", "structural-rules.json"), "utf8"),
);
const rules = compileStructuralRules(ruleData);

const VIEWPORT = { width: 1280, height: 800 };
const WHITE = "rgb(255, 255, 255)";
const CLEAR = "rgba(0, 0, 0, 0)";

// --- measurement builders ---------------------------------------------------

/** A control as the content script measures it: unstyled text on white by default. */
function control(text, overrides = {}) {
  return {
    text,
    width: 120,
    height: 36,
    fontSize: "14px",
    fontWeight: "600",
    color: "rgb(51, 51, 51)",
    fill: { color: CLEAR, image: "none" },
    behind: [{ color: WHITE, image: "none" }],
    border: { width: "0px", style: "none", color: "rgb(0, 0, 0)" },
    opacity: 1,
    ...overrides,
  };
}

function filled(text, fillColor, overrides = {}) {
  return control(text, { fill: { color: fillColor, image: "none" }, color: WHITE, ...overrides });
}

const closeButton = () => control("Close", { width: 24, height: 24 });

function overlay(overrides = {}) {
  return {
    rect: { x: 390, y: 165, width: 500, height: 470 },
    dims: false,
    modal: false,
    unprompted: true,
    text: "Bundle deals US $0.33 on 1 item Free shipping Shop now",
    hasImage: true,
    hasFrame: false,
    controls: [],
    ...overrides,
  };
}

const backdrop = () =>
  overlay({ rect: { x: 0, y: 0, width: 1280, height: 800 }, dims: true, text: "", hasImage: false });

const judge = (structure) => classifyStructure({ viewport: VIEWPORT, ...structure }, rules);
const idsOf = (structure) => judge(structure).findings.map((finding) => finding.id).sort();
const findingFor = (structure, id) => judge(structure).findings.find((finding) => finding.id === id);

// --- the three screenshots --------------------------------------------------

// docs/Screenshot_20260915_190443.png
const notificationSoftAsk = () =>
  overlay({
    rect: { x: 405, y: 12, width: 470, height: 150 },
    hasImage: false,
    text: "AliExpress Subscribe to notifications Get order updates, tips about the latest discounts, coupons and more! Allow Don't allow",
    controls: [
      filled("Allow", "rgb(253, 56, 79)"),
      control("Don’t allow", { fill: { color: "rgb(242, 242, 242)", image: "none" } }),
      closeButton(),
    ],
  });

test("screenshot 190443: a notification prompt that opened by itself is an interruption", () => {
  assert.ok(idsOf({ overlays: [notificationSoftAsk()] }).includes("unprompted-popup"));
});

test("screenshot 190443: a bright “Allow” beside a grey “Don't allow” is biased", () => {
  const finding = findingFor({ overlays: [notificationSoftAsk()] }, "biased-buttons");
  assert.ok(finding, "expected biased-buttons");
  assert.equal(
    finding.evidence[0],
    "“Allow” is a bright, coloured button, while “Don't allow” is grey.",
  );
});

// docs/Screenshot_20260915_190529.png
test("screenshot 190529: an interstitial over a dimmed page is an interruption", () => {
  const bundle = overlay({
    controls: [
      filled("Shop now", CLEAR, {
        width: 300,
        height: 56,
        fill: { color: CLEAR, image: "linear-gradient(rgb(255, 64, 96), rgb(255, 32, 80))" },
      }),
      closeButton(),
    ],
  });
  const finding = findingFor({ overlays: [backdrop(), bundle] }, "unprompted-popup");
  assert.ok(finding);
  assert.equal(
    finding.evidence[0],
    "“Bundle deals US $0.33 on 1 item Free shipping Shop now” opened by itself and dimmed the page behind it.",
  );
  // Only a close button to say no with, so there is no pair of choices to compare.
  assert.ok(!idsOf({ overlays: [backdrop(), bundle] }).includes("biased-buttons"));
});

// Both AliExpress pop-ups at once: the interstitial's mask lands on top of the
// notification prompt. Only the pop-up above the mask dimmed the page.
test("a prompt under a later interstitial's backdrop is not the one that dimmed the page", () => {
  const prompt = { ...notificationSoftAsk(), z: 1000 };
  const mask = { ...backdrop(), z: 2000 };
  const bundle = overlay({ z: 2001, controls: [filled("Shop now", "rgb(255, 64, 96)")] });
  const evidence = findingFor({ overlays: [prompt, mask, bundle] }, "unprompted-popup").evidence;
  assert.deepEqual(evidence, [
    "“AliExpress Subscribe to notifications Get order updates, ti…” opened by itself.",
    "“Bundle deals US $0.33 on 1 item Free shipping Shop now” opened by itself and dimmed the page behind it.",
  ]);
});

// docs/Screenshot_20260915_222652.png
test("screenshot 222652: a free-trial modal over a dimmed page is an interruption", () => {
  const trial = overlay({
    rect: { x: 300, y: 165, width: 680, height: 470 },
    text: "Smart sourcing with AI Mode Let AI handle supplier comparison, vetting, and negotiation for you Free 30-day Pro trial",
    controls: [
      filled("Free 30-day Pro trial", CLEAR, {
        width: 600,
        height: 56,
        fill: { color: CLEAR, image: "linear-gradient(90deg, rgb(255, 160, 96), rgb(255, 64, 96))" },
      }),
      closeButton(),
    ],
  });
  assert.deepEqual(idsOf({ overlays: [backdrop(), trial] }), ["unprompted-popup"]);
});

// --- what is not an interruption --------------------------------------------

test("a pop-up the shopper opened themselves is not an interruption", () => {
  const sizeGuide = overlay({ unprompted: false, text: "Size guide Chest Waist Hip S M L XL" });
  assert.deepEqual(idsOf({ overlays: [backdrop(), sizeGuide] }), []);
});

test("cookie banners are never interruptions", () => {
  const banner = overlay({
    rect: { x: 0, y: 640, width: 1280, height: 160 },
    text: "We use cookies to improve your experience. Accept all Reject all",
  });
  assert.ok(!idsOf({ overlays: [banner] }).includes("unprompted-popup"));
  const centred = overlay({ dims: true, text: "We value your privacy. We use cookies and similar technologies." });
  assert.ok(!idsOf({ overlays: [centred] }).includes("unprompted-popup"));
});

test("region and age gates are not interruptions", () => {
  for (const text of [
    "Choose your country or region to see local prices",
    "Are you over 18? This site sells alcohol.",
  ]) {
    assert.deepEqual(idsOf({ overlays: [backdrop(), overlay({ text })] }), [], text);
  }
});

test("a fixed header or footer strip is not a pop-up", () => {
  const header = overlay({
    rect: { x: 0, y: 0, width: 1280, height: 64 },
    text: "AliExpress Bundle deals Choice SuperDeals Sign in / Register Cart",
    controls: [filled("Sign in", "rgb(20, 20, 20)")],
  });
  assert.deepEqual(idsOf({ overlays: [header] }), []);
});

test("a chat bubble or back-to-top arrow is not a pop-up", () => {
  const chat = overlay({
    rect: { x: 1200, y: 720, width: 56, height: 56 },
    text: "",
    hasImage: true,
    controls: [control("Chat with us", { width: 56, height: 56 })],
  });
  assert.deepEqual(idsOf({ overlays: [chat] }), []);
});

test("a small box that asks for something is an interruption", () => {
  const corner = overlay({
    rect: { x: 960, y: 560, width: 300, height: 220 },
    text: "Get 10% off your first order when you join our list",
    controls: [filled("Sign up", "rgb(20, 20, 20)"), closeButton()],
  });
  assert.ok(idsOf({ overlays: [corner] }).includes("unprompted-popup"));
});

// --- biased buttons, beyond the screenshots ---------------------------------

test("a filled button beside a tiny, faint text link is biased, and says why", () => {
  const modal = overlay({
    dims: true,
    text: "Get 15% off your first order Subscribe No thanks",
    controls: [
      filled("Subscribe", "rgb(17, 17, 17)", { width: 320, height: 48, fontSize: "16px" }),
      control("No thanks", { width: 70, height: 18, fontSize: "11px", color: "rgb(190, 190, 190)" }),
    ],
  });
  assert.equal(
    findingFor({ overlays: [modal] }, "biased-buttons").evidence[0],
    "“Subscribe” is a bold, filled button, while “No thanks” is plain text, less than half the size, faint against its background, and in smaller type.",
  );
});

test("two plain links can still be biased by size and contrast alone", () => {
  const group = {
    text: "Yes, protect my order No thanks",
    controls: [
      control("Yes, protect my order", { width: 260, height: 40, fontSize: "18px", color: "rgb(0, 0, 0)" }),
      control("No thanks", { width: 60, height: 16, fontSize: "11px", color: "rgb(200, 200, 200)" }),
    ],
  };
  const evidence = findingFor({ groups: [group] }, "biased-buttons").evidence[0];
  assert.match(evidence, /^Next to “Yes, protect my order”, “No thanks” is less than half the size/);
});

test("an outlined “no” beside a filled “yes” is not enough on its own", () => {
  const group = {
    text: "Allow notifications",
    controls: [
      filled("Allow", "rgb(26, 115, 232)"),
      control("Block", { border: { width: "1px", style: "solid", color: "rgb(26, 115, 232)" } }),
    ],
  };
  assert.deepEqual(idsOf({ groups: [group] }), []);
});

test("equal buttons are not biased", () => {
  const group = {
    text: "Allow notifications?",
    controls: [filled("Allow", "rgb(26, 115, 232)"), filled("Block", "rgb(26, 115, 232)")],
  };
  assert.deepEqual(idsOf({ groups: [group] }), []);
});

test("a “no” that is more prominent than the “yes” is not biased", () => {
  const group = {
    text: "Add protection?",
    controls: [control("Add protection"), filled("No thanks", "rgb(26, 115, 232)")],
  };
  assert.deepEqual(idsOf({ groups: [group] }), []);
});

test("a button made translucent counts as faint", () => {
  const group = {
    text: "Turn on alerts?",
    controls: [
      filled("Turn on", "rgb(26, 115, 232)", { color: WHITE }),
      control("Not now", { opacity: 0.25 }),
    ],
  };
  assert.match(findingFor({ groups: [group] }, "biased-buttons").evidence[0], /faint/);
});

test("Tailwind v4 oklch colours are read like any other", () => {
  const group = {
    text: "Join the club?",
    controls: [filled("Join", "oklch(0.637 0.237 25.331)"), control("No thanks")],
  };
  assert.match(findingFor({ groups: [group] }, "biased-buttons").evidence[0], /bright, coloured/);
});

test("close buttons are exits, not answers", () => {
  const promo = overlay({ controls: [filled("Shop now", "rgb(255, 64, 96)"), control("×")] });
  assert.ok(!idsOf({ overlays: [promo] }).includes("biased-buttons"));
});

// --- consent banners: Layer 2 settles Layer 1's guess ------------------------

const cookieBanner = (controls) =>
  overlay({
    rect: { x: 0, y: 640, width: 1280, height: 160 },
    text: "We value your privacy. We use cookies to personalise content and ads.",
    controls,
  });

test("a balanced cookie banner is not biased, and replaces the wording-based guess", () => {
  const result = judge({
    overlays: [
      cookieBanner([
        filled("Accept all", "rgb(26, 115, 232)"),
        filled("Reject all", "rgb(26, 115, 232)"),
        control("Manage preferences", { fontSize: "12px", width: 110, height: 16 }),
      ]),
    ],
  });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.supersedes, ["biased-cookie-choices"]);
});

test("a cookie banner whose only alternative is a faint link is biased", () => {
  const result = judge({
    overlays: [
      cookieBanner([
        filled("Accept all cookies", "rgb(26, 115, 232)", { width: 220, height: 44 }),
        control("Manage preferences", { width: 120, height: 16, fontSize: "12px", color: "rgb(160, 160, 160)" }),
      ]),
    ],
  });
  assert.deepEqual(result.findings.map((finding) => finding.id), ["biased-buttons"]);
  assert.deepEqual(result.supersedes, ["biased-cookie-choices"]);
});

test("a cookie banner with no way to say no is left to the wording check", () => {
  const result = judge({ overlays: [cookieBanner([filled("Accept", "rgb(26, 115, 232)")])] });
  assert.deepEqual(result.supersedes, []);
});

// --- pre-ticked boxes ---------------------------------------------------------

const box = (label, overrides = {}) => ({ label, checked: true, touched: false, ...overrides });

test("an extra that costs money, ticked in advance, is a pre-ticked add-on", () => {
  for (const label of [
    "Add Shipping Protection for $2.99",
    "Add a 2-year warranty",
    "Round up my order to donate to charity",
  ]) {
    assert.deepEqual(idsOf({ checkboxes: [box(label)] }), ["preticked-addon"], label);
  }
});

test("marketing or data sharing, ticked in advance, is a pre-ticked opt-in", () => {
  for (const label of [
    "Email me about new arrivals and special offers",
    "Keep me updated with news and promotions",
    "Share my details with trusted partners for personalised offers",
  ]) {
    assert.deepEqual(idsOf({ checkboxes: [box(label)] }), ["preticked-consent"], label);
  }
});

test("convenience boxes are not dark patterns", () => {
  for (const label of [
    "Remember me",
    "Keep me signed in",
    "My billing address is the same as my shipping address",
    "Show password",
  ]) {
    assert.deepEqual(idsOf({ checkboxes: [box(label)] }), [], label);
  }
});

test("a box the shopper ticked themselves is their own choice", () => {
  assert.deepEqual(idsOf({ checkboxes: [box("Email me deals", { touched: true })] }), []);
  assert.deepEqual(idsOf({ checkboxes: [box("Email me deals", { checked: false })] }), []);
});

test("the evidence quotes the ticked box", () => {
  const finding = findingFor({ checkboxes: [box("Add Shipping Protection for $2.99")] }, "preticked-addon");
  assert.deepEqual(finding.evidence, ["Already ticked: “Add Shipping Protection for $2.99”"]);
});

// --- labels -------------------------------------------------------------------

test("button wording is sorted into yes, no and close", () => {
  const cases = {
    Allow: "accept",
    "Don't allow": "decline",
    "Don’t allow": "decline",
    "Accept all": "accept",
    "Reject all": "decline",
    "No thanks": "decline",
    "No, I prefer to pay full price": "decline",
    "Maybe later": "decline",
    "Continue without saving": "decline",
    Continue: "accept",
    "Skip to main content": "other",
    Close: "exit",
    "×": "exit",
    "Manage preferences": "other",
    "": "unlabelled",
  };
  for (const [label, kind] of Object.entries(cases)) {
    assert.equal(labelKind(label, rules), kind, `"${label}"`);
  }
  assert.equal(labelKind("Manage preferences", rules, { consent: true }), "decline");
});

// --- shape of the output ------------------------------------------------------

test("every structural rule maps to a Gray et al. category and explains itself", () => {
  for (const rule of ruleData.rules) {
    assert.ok(CATEGORY_ORDER.includes(rule.category), `${rule.id}: ${rule.category}`);
    assert.ok(rule.explanation.length > 40, `${rule.id} needs a plain-language explanation`);
    assert.doesNotMatch(rule.approach, /\bfalse\b/i);
  }
});

test("findings are marked as layout findings and stay plain JSON", () => {
  const [finding] = judge({ checkboxes: [box("Email me deals")] }).findings;
  assert.equal(finding.layer, "structure");
  assert.deepEqual(finding, JSON.parse(JSON.stringify(finding)));
});

test("repeat sightings are counted, with at most three pieces of evidence", () => {
  const boxes = ["Email me A", "Email me B", "Email me C", "Email me D"].map((label) => box(label));
  const [finding] = judge({ checkboxes: boxes }).findings;
  assert.equal(finding.matchCount, 4);
  assert.equal(finding.evidence.length, 3);
});

test("missing or malformed measurements are ignored, not fatal", () => {
  assert.deepEqual(classifyStructure(undefined, rules), { findings: [], supersedes: [] });
  assert.deepEqual(judge({}), { findings: [], supersedes: [] });
  assert.deepEqual(
    judge({ overlays: [null, {}, { controls: [null, {}] }], groups: [{}], checkboxes: [null, {}] }),
    { findings: [], supersedes: [] },
  );
});

test("a rules file with a missing threshold fails loudly", () => {
  const broken = structuredClone(ruleData);
  delete broken.thresholds.biasThreshold;
  assert.throws(() => compileStructuralRules(broken), /biasThreshold/);
});

// --- hidden cancel links ------------------------------------------------------

test("a tiny, faint cancel link is a hidden cancel link, and says why", () => {
  const link = control("Cancel membership", { fontSize: "9px", color: "rgb(200, 200, 200)", width: 90, height: 12 });
  assert.deepEqual(findingFor({ cancelLinks: [link] }, "hidden-cancel-link").evidence, [
    "“Cancel membership” is tiny (9px text) and faint against its background.",
  ]);
});

test("an ordinary grey footer link is not hidden", () => {
  // #767676 on white is the classic 'just passes AA' grey: about 4.5:1.
  const link = control("Unsubscribe", { fontSize: "12px", color: "rgb(118, 118, 118)" });
  assert.deepEqual(idsOf({ cancelLinks: [link] }), []);
});

test("small text alone is enough to hide a cancel link", () => {
  const link = control("Unsubscribe", { fontSize: "8px", color: "rgb(60, 60, 60)" });
  assert.match(findingFor({ cancelLinks: [link] }, "hidden-cancel-link").evidence[0], /tiny \(8px text\)\.$/);
});

test("only cancel and unsubscribe wording is judged", () => {
  const link = control("Terms of use", { fontSize: "8px", color: "rgb(220, 220, 220)" });
  assert.deepEqual(idsOf({ cancelLinks: [link] }), []);
});
