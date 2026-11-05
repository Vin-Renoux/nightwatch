/**
 * Tests for matching documented regulator actions to the site being viewed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { recordsFor } from "../lib/records.js";

const data = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "rules", "known-records.json"), "utf8"),
);
const ids = (url) => recordsFor(url, data).map((record) => record.id);

test("matches the company's own domains and their subdomains", () => {
  assert.deepEqual(ids("https://www.amazon.com.au/gp/primecentral"), ["ftc-amazon-prime-2023"]);
  assert.deepEqual(ids("https://account.adobe.com/plans"), ["doj-ftc-adobe-2024"]);
});

test("does not match lookalike or unrelated domains", () => {
  for (const url of [
    "https://notamazon.com/",
    "https://amazon.com.evil.example/",
    "https://www.temu.com/au",
    "not a url",
  ]) {
    assert.deepEqual(ids(url), [], url);
  }
});

test("every record is a cited regulator action, worded as an allegation", () => {
  for (const record of data.records) {
    assert.match(record.source, /Commission|Department of Justice|ACCC|Regulat|Authority/, record.id);
    assert.match(record.source, /\b(19|20)\d\d\b/, `${record.id} needs a date`);
    assert.match(record.summary, /\balleg/, `${record.id} must say what was alleged, not assert it`);
    assert.ok(record.domains?.length, `${record.id} needs domains`);
  }
});
