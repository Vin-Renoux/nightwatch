/**
 * Tests for the colour maths behind button-prominence checks.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BLACK,
  WHITE,
  averageColor,
  chroma,
  composite,
  contrastRatio,
  parseBackgroundImage,
  parseCssColor,
} from "../lib/color.js";

const near = (actual, expected, tolerance = 1) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test("reads the colour formats browsers report for computed styles", () => {
  assert.deepEqual(parseCssColor("rgb(255, 77, 90)"), [255, 77, 90, 1]);
  assert.deepEqual(parseCssColor("rgba(0, 0, 0, 0.45)"), [0, 0, 0, 0.45]);
  assert.deepEqual(parseCssColor("rgb(255 0 0 / 50%)"), [255, 0, 0, 0.5]);
  assert.deepEqual(parseCssColor("transparent"), [0, 0, 0, 0]);
  assert.deepEqual(parseCssColor("color(srgb 1 0 0)"), [255, 0, 0, 1]);
});

test("reads oklch, which Tailwind v4 sites hand back for every palette colour", () => {
  // Tailwind v4 red-500.
  const red = parseCssColor("oklch(0.637 0.237 25.331)");
  assert.ok(red[0] > 230 && red[1] < 80 && red[2] < 90, `got ${red}`);
  assert.deepEqual(parseCssColor("oklch(1 0 0)").slice(0, 3), [255, 255, 255]);
  assert.deepEqual(parseCssColor("oklch(0% 0 0)").slice(0, 3), [0, 0, 0]);
  assert.equal(parseCssColor("oklch(0.5 0.1 200 / 0.25)")[3], 0.25);
});

test("returns null rather than guessing at colours it cannot read", () => {
  for (const value of ["garbage", "", "lab(50% 40 59)", "rgb(1, 2)", undefined, 42]) {
    assert.equal(parseCssColor(value), null, `should not parse ${value}`);
  }
});

test("finds the colours inside a gradient and notices pictures", () => {
  const gradient = parseBackgroundImage(
    "linear-gradient(90deg, rgb(255, 160, 96) 0%, rgb(255, 64, 96) 100%)",
  );
  assert.equal(gradient.colors.length, 2);
  assert.equal(gradient.image, false);
  assert.deepEqual(averageColor(gradient.colors), [255, 112, 96, 1]);

  assert.equal(parseBackgroundImage('url("deal.png")').image, true);
  assert.deepEqual(parseBackgroundImage("none"), { colors: [], image: false });
});

test("contrast follows WCAG 2", () => {
  near(contrastRatio(BLACK, WHITE), 21, 0.01);
  near(contrastRatio(WHITE, WHITE), 1, 0.01);
  // #777 on white is the textbook "just fails AA" grey.
  near(contrastRatio([119, 119, 119, 1], WHITE), 4.48, 0.01);
});

test("compositing a translucent layer lands between the two colours", () => {
  const half = composite([0, 0, 0, 0.5], WHITE);
  near(half[0], 127.5, 0.01);
  assert.equal(half[3], 1);
  assert.deepEqual(composite([10, 20, 30, 1], WHITE), [10, 20, 30, 1]);
  assert.deepEqual(composite([10, 20, 30, 0], WHITE), [255, 255, 255, 1]);
});

test("chroma separates colourful from grey", () => {
  assert.equal(chroma([128, 128, 128]), 0);
  assert.ok(chroma([253, 56, 79]) > 0.7);
  assert.ok(chroma([242, 242, 242]) < 0.01);
});
