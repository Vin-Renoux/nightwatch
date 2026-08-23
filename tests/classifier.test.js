/**
 * Unit tests for the pure Layer 1 logic. No browser, no dependencies:
 *   npm test        (or: node --test)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CATEGORY_ORDER, classifySegments, compileRules, groupByCategory } from "../lib/classifier.js";

const ruleData = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "rules", "keyword-rules.json"), "utf8"),
);
const rules = compileRules(ruleData);

test("every rule compiles and maps to a Gray et al. category", () => {
  assert.ok(rules.length >= 15, "expected at least 15 Layer 1 rules");
  for (const rule of rules) {
    assert.ok(CATEGORY_ORDER.includes(rule.category), `${rule.id} has category "${rule.category}"`);
    assert.ok(rule.explanation.length > 0, `${rule.id} needs a plain-language explanation`);
    assert.ok(rule.matchers.length > 0, `${rule.id} needs at least one pattern`);
  }
});

test("rule ids are unique", () => {
  const ids = rules.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("detects low-stock scarcity", () => {
  const findings = classifySegments(["Only 3 left in stock!"], rules);
  const ids = findings.map((finding) => finding.id);
  assert.ok(ids.includes("false-urgency-low-stock"));
});

test("detects confirmshaming", () => {
  const findings = classifySegments(["No thanks, I prefer to pay full price"], rules);
  assert.ok(findings.some((finding) => finding.id === "confirmshaming"));
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

test("counts repeats but reports one finding per rule", () => {
  const findings = classifySegments(
    ["Only 2 left in stock", "Almost sold out", "Selling fast"],
    rules,
  );
  const lowStock = findings.filter((finding) => finding.id === "false-urgency-low-stock");
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
  assert.match(finding.evidence[0], /deal ends in/i);
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
