import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { composite, contrastRatio, parseCssColor } from "../lib/color.js";

const css = readFileSync(join(import.meta.dirname, "..", "popup", "popup.css"), "utf8");

function themeVariables(selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `no ${selector} block in popup.css`);
  const block = css.slice(start, css.indexOf("}", start));
  const variables = {};
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) variables[name] = value.trim();
  return variables;
}

const THEMES = {
  night: themeVariables(':root[data-theme="dark"] {'),
  day: themeVariables(':root[data-theme="light"] {'),
};

// [text, background, minimum ratio]. 4.5:1 is WCAG AA for normal text;
// 3:1 is the minimum for large text and for shapes that carry meaning.
const PAIRS = [
  ["ink", "bg", 4.5],
  ["ink", "card", 4.5],
  ["ink-soft", "card", 4.5],
  ["ink-soft", "card-hover", 4.5],
  ["ink-soft", "quote", 4.5],
  ["ink-faint", "bg", 4.5],
  ["ink-faint", "card", 4.5],
  ["chip-ink", "chip-bg", 4.5],
  ["accent", "card", 3],
  ["sev-high", "card", 3],
  ["sev-medium", "card", 3],
  ["sev-low", "card", 3],
];

for (const [themeName, variables] of Object.entries(THEMES)) {
  test(`${themeName} theme text meets WCAG contrast`, () => {
    for (const [fg, bg, minimum] of PAIRS) {
      const background = parseCssColor(variables[bg]);
      const foreground = parseCssColor(variables[fg]);
      assert.ok(background && foreground, `--${fg} or --${bg} is missing or unreadable`);
      const ratio = contrastRatio(composite(foreground, background), background);
      assert.ok(
        ratio >= minimum,
        `--${fg} on --${bg} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`,
      );
    }
  });
}

test("both themes define the same colours", () => {
  assert.deepEqual(Object.keys(THEMES.day).sort(), Object.keys(THEMES.night).sort());
});
