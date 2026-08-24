/**
 * Unit tests for the pure Layer 1 logic. No browser, no dependencies:
 *   npm test        (or: node --test)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CATEGORY_ORDER,
  classifySegments,
  compileRules,
  groupByCategory,
  mergeFindings,
} from "../lib/classifier.js";

const ruleData = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "rules", "keyword-rules.json"), "utf8"),
);
const rules = compileRules(ruleData);

const idsFor = (segments) => classifySegments(segments, rules).map((finding) => finding.id);

test("every rule compiles and maps to a Gray et al. category", () => {
  assert.ok(rules.length >= 15, "expected at least 15 Layer 1 rules");
  for (const rule of rules) {
    assert.ok(CATEGORY_ORDER.includes(rule.category), `${rule.id} has category "${rule.category}"`);
    assert.ok(rule.explanation.length > 0, `${rule.id} needs a plain-language explanation`);
    assert.ok(rule.matchers.length > 0, `${rule.id} needs at least one pattern`);
    assert.ok(
      rule.matchers.length >= rule.minDistinctPatterns,
      `${rule.id} can never reach minDistinctPatterns`,
    );
  }
});

test("rule ids are unique", () => {
  const ids = rules.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("no rule claims a pattern is false, only that it applies pressure", () => {
  // NightWatch cannot verify a countdown or stock count from the page, so the
  // wording must not assert falsity (brief §11).
  for (const rule of rules) {
    assert.doesNotMatch(rule.approach, /\bfalse\b/i, `${rule.id} approach asserts falsity`);
  }
});

test("detects low-stock scarcity", () => {
  assert.ok(idsFor(["Only 3 left in stock!"]).includes("scarcity-low-stock"));
});

test("detects confirmshaming", () => {
  assert.ok(idsFor(["No thanks, I prefer to pay full price"]).includes("confirmshaming"));
});

test("detects forced account creation", () => {
  const findings = classifySegments(["You must create an account to continue"], rules);
  assert.ok(findings.some((finding) => finding.category === "Forced Action"));
});

test("ignores ordinary product copy", () => {
  const findings = classifySegments(
    [
      "Wireless mouse with 1000Hz polling rate",
      "Free returns within 30 days",
      "Ships from Sydney",
    ],
    rules,
  );
  assert.deepEqual(findings, []);
});

// Regression tests for the misses in docs/Screenshot_20260823_152806.png and
// docs/Screenshot_20260823_152712.png — real AliExpress wording that v0.1 read
// straight past.
test("detects a deadline written as a date rather than a countdown", () => {
  assert.ok(idsFor(["Sale Ends: Aug 27, 16:59 AEST"]).includes("urgency-deadline"));
  assert.ok(idsFor(["WINTER SALE · Welcome deal Ends: Aug 27"]).includes("urgency-deadline"));
});

test("detects a saving stated as an amount rather than a percentage", () => {
  assert.ok(idsFor(["Save AU$54.44"]).includes("price-anchoring"));
});

test("detects tax excluded from the displayed price", () => {
  assert.ok(idsFor(["Tax excluded, add at checkout if applicable"]).includes("hidden-costs"));
});

test("detects sales counts in all the shapes shops write them", () => {
  for (const text of ["10,000+ sold", "8.2K+ sold", "600+ sold", "89 sold"]) {
    assert.ok(idsFor([text]).includes("social-proof-activity"), `missed "${text}"`);
  }
});

// Regression test for docs/Screenshot_20260823_153446.png — Temu's anti-scam
// notice was reported as a hidden cost.
test("a promise not to charge fees is not a hidden cost", () => {
  const negated = [
    "Temu won't ask for extra fees via SMS or email.",
    "No hidden fees, ever.",
    "Delivered without additional charges.",
  ];
  for (const text of negated) {
    assert.ok(!idsFor([text]).includes("hidden-costs"), `wrongly flagged "${text}"`);
  }
});

test("a fee warning is still caught when nothing negates it", () => {
  assert.ok(idsFor(["Additional fees apply at checkout"]).includes("hidden-costs"));
});

// Regression test for docs/Screenshot_20260823_152845.png — "Sign in / Register"
// sits in the header of every AliExpress page, so one match cannot be enough.
test("a header sign-in link alone is not a login wall", () => {
  assert.ok(!idsFor(["Welcome", "Sign in / Register", "Add to cart"]).includes("login-wall"));
});

test("a real sign-in wall is a login wall", () => {
  const page = [
    "Register/Sign in",
    "Your information is protected",
    "Email or phone number",
    "Trouble signing in?",
    "Or continue with",
  ];
  assert.ok(idsFor(page).includes("login-wall"));
});

test("a lone cookie phrase is not a biased choice", () => {
  assert.ok(!idsFor(["Cookie policy"]).includes("biased-cookie-choices"));
  assert.ok(idsFor(["Accept all cookies", "Manage preferences"]).includes("biased-cookie-choices"));
});

test("counts repeats but reports one finding per rule", () => {
  const findings = classifySegments(
    ["Only 2 left in stock", "Almost sold out", "Selling fast"],
    rules,
  );
  const lowStock = findings.filter((finding) => finding.id === "scarcity-low-stock");
  assert.equal(lowStock.length, 1);
  assert.equal(lowStock[0].matchCount, 3);
});

test("keeps at most three pieces of evidence per rule", () => {
  const segments = ["Only 1 left", "Only 2 left", "Only 3 left", "Only 4 left"];
  const [finding] = classifySegments(segments, rules);
  assert.equal(finding.matchCount, 4);
  assert.equal(finding.evidence.length, 3);
});

test("evidence quotes the matched text", () => {
  const [finding] = classifySegments(["Hurry — this deal ends in 5 minutes"], rules);
  assert.match(finding.evidence[0], /deal ends/i);
});

test("findings are plain JSON, with no internal bookkeeping left on them", () => {
  const [finding] = classifySegments(["Only 1 left in stock"], rules);
  assert.ok(!("matchedPatterns" in finding));
  assert.ok(!("minDistinctPatterns" in finding));
  assert.deepEqual(finding, JSON.parse(JSON.stringify(finding)));
});

test("orders findings worst-first", () => {
  const findings = classifySegments(["Best seller", "Only 5 left in stock"], rules);
  assert.equal(findings[0].severity, "high");
  assert.equal(findings.at(-1).severity, "low");
});

test("groups by category in taxonomy order", () => {
  const findings = classifySegments(
    ["Join our newsletter", "Only 5 left in stock", "Additional fees apply"],
    rules,
  );
  const categories = groupByCategory(findings).map((group) => group.category);
  assert.deepEqual(categories, ["Interface Interference", "Sneaking", "Nagging"]);
});

test("tolerates empty and malformed input", () => {
  assert.deepEqual(classifySegments([], rules), []);
  assert.deepEqual(classifySegments(undefined, rules), []);
  assert.deepEqual(classifySegments([null, "", 42], rules), []);
});

// Regression test for docs/Screenshot_20260823_152630.png — a later scan caught
// the page mid-rebuild and replaced a real detection with nothing.
test("a thinner rescan never erases what an earlier scan found", () => {
  const first = classifySegments(["Only 1 left in stock", "Best seller"], rules);
  const thin = classifySegments([], rules);
  const merged = mergeFindings(first, thin);
  assert.equal(merged.length, first.length);
});

test("a rescan adds newly appeared patterns", () => {
  const first = classifySegments(["Only 1 left in stock"], rules);
  const later = classifySegments(["Join our newsletter"], rules);
  const merged = mergeFindings(first, later);
  assert.deepEqual(
    merged.map((finding) => finding.id).sort(),
    ["nagging-newsletter", "scarcity-low-stock"],
  );
});

test("merging keeps the high-water mark rather than double-counting rescans", () => {
  const scan = classifySegments(["Only 1 left", "Only 2 left"], rules);
  const merged = mergeFindings(scan, scan);
  assert.equal(merged[0].matchCount, 2);
  assert.equal(merged[0].evidence.length, 2);
});

test("merging tolerates a missing previous record", () => {
  const scan = classifySegments(["Only 1 left in stock"], rules);
  assert.deepEqual(mergeFindings(undefined, scan), scan);
  assert.deepEqual(mergeFindings(scan, undefined), scan);
});
