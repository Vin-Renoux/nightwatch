/**
 * Tests for which pages NightWatch will look at.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { friendlyUrl, isScannable, isSearchPage, pageKeyFor, skipReason } from "../lib/scope.js";

test("skips search engines", () => {
  const searchPages = [
    "https://www.google.com/search?q=amazon",
    "https://google.com.au/search?q=shoes",
    "https://www.bing.com/search?q=temu",
    "https://duckduckgo.com/?q=aliexpress",
    "https://search.brave.com/search?q=deals",
    "https://au.search.yahoo.com/search?p=deals",
  ];
  for (const url of searchPages) {
    assert.ok(isSearchPage(url), `${url} should be treated as search`);
    assert.ok(!isScannable(url), `${url} should not be scanned`);
    assert.equal(skipReason(url), "search");
  }
});

test("scans ordinary shopping pages", () => {
  const shops = [
    "https://www.aliexpress.com/item/1005011592568391.html",
    "https://www.temu.com/au",
    "https://inbusiness.aliexpress.com/",
  ];
  for (const url of shops) {
    assert.ok(isScannable(url), `${url} should be scanned`);
    assert.equal(skipReason(url), null);
  }
});

test("does not mistake other sites for Google", () => {
  assert.ok(!isSearchPage("https://www.googleshopping.example.com/"));
  assert.ok(isScannable("https://store.google.example.org/"));
});

test("scans local files so the test fixtures work", () => {
  assert.ok(isScannable("file:///home/ash/Projects/nightwatch/tests/fixtures/mock-product-page.html"));
});

test("refuses browser-internal pages", () => {
  for (const url of ["chrome://extensions/", "about:blank", "", "not a url"]) {
    assert.ok(!isScannable(url));
    assert.equal(skipReason(url), "unsupported");
  }
});

test("page keys ignore the fragment but keep the query", () => {
  assert.equal(
    pageKeyFor("https://shop.example.com/item?id=7#reviews"),
    "https://shop.example.com/item?id=7",
  );
  assert.equal(
    pageKeyFor("https://shop.example.com/item?id=7"),
    pageKeyFor("https://shop.example.com/item?id=7#specs"),
  );
});

test("different product pages get different keys", () => {
  assert.notEqual(
    pageKeyFor("https://shop.example.com/item/1"),
    pageKeyFor("https://shop.example.com/item/2"),
  );
});

test("friendly URLs stay short enough for the popup", () => {
  const monster =
    "https://www.aliexpress.com/item/1005011592568391.html?sourceType=562&pvid=8d3931de-cded&pdp_ext_f=%7B%22ship_from%22%3A%22CN%22%7D&spm=a2g0o.tm1000029706";
  const shown = friendlyUrl(monster);
  assert.ok(shown.length <= 64, `too long: ${shown.length}`);
  assert.ok(shown.startsWith("www.aliexpress.com/item/"));
  assert.equal(friendlyUrl("https://www.temu.com/au"), "www.temu.com/au");
});

// The content script cannot import ES modules, so it carries its own copy of
// the search-host list. Fail loudly if the two drift apart.
test("the content script's search-host list matches lib/scope.js", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "content", "content-script.js"),
    "utf8",
  );
  const scope = readFileSync(join(import.meta.dirname, "..", "lib", "scope.js"), "utf8");

  const listFrom = (text) => {
    const block = text.match(/SEARCH_HOST_PATTERNS = \[([\s\S]*?)\];/);
    assert.ok(block, "could not find SEARCH_HOST_PATTERNS");
    return block[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/"));
  };

  assert.deepEqual(listFrom(source), listFrom(scope));
});
