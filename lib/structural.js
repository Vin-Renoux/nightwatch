/**
 * NightWatch — Layer 2 (structure) classification.
 *
 * Layer 1 reads what a page says; this layer judges how the page is built.
 * content/structure.js measures the page and sends plain JSON — what is
 * floating over it, the buttons inside with their computed colours and sizes,
 * and any ticked boxes. Everything here works on that JSON alone, with no DOM
 * and no chrome.*, so it is unit-tested in Node like the text classifier
 * (brief §9).
 *
 * Shapes (missing fields are tolerated):
 *   structure = { viewport: {width, height}, overlays: [overlay], groups: [group],
 *                 checkboxes: [box], cancelLinks: [control] }
 *   overlay   = { rect: {x, y, width, height}, z, dims, modal, unprompted, text, hasImage, hasFrame,
 *                 controls: [control] }
 *   group     = { text, controls: [control] }   — a choice found in the page itself
 *   control   = { text, width, height, fontSize, color, fill: {color, image},
 *                 behind: [{color, image}] (nearest ancestor first), border: {width, style, color},
 *                 opacity }
 *   box       = { label, checked, touched }
 */

import {
  BLACK,
  WHITE,
  averageColor,
  chroma,
  composite,
  contrastRatio,
  mix,
  parseBackgroundImage,
  parseCssColor,
} from "./color.js";

const MAX_EVIDENCE_PER_RULE = 3;
const QUOTE_CHARS = 60;
const LABEL_CHARS = 32;
const MAX_CONTROL_LABEL = 80;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const FILL_SIGNALS = new Set(["plain", "muted", "outlined"]);

const THRESHOLD_KEYS = [
  "barMinWidth",
  "barMaxHeight",
  "smallMaxCoverage",
  "dialogMinCoverage",
  "minContentChars",
  "visibleFillContrast",
  "strongFillChroma",
  "strongFillContrast",
  "outlineContrast",
  "sizeRatio",
  "fontRatio",
  "faintContrast",
  "biasThreshold",
  "hiddenLinkContrast",
  "hiddenLinkFontPx",
];

/** Turn rules/structural-rules.json into compiled vocabulary and checked thresholds. */
export function compileStructuralRules(data) {
  const thresholds = { ...data?.thresholds };
  for (const key of THRESHOLD_KEYS) {
    if (typeof thresholds[key] !== "number") {
      throw new Error(`structural-rules.json is missing the "${key}" threshold`);
    }
  }

  const vocab = {};
  for (const [name, patterns] of Object.entries(data?.vocabulary ?? {})) {
    vocab[name] = patterns.map((pattern) => new RegExp(pattern, "i"));
  }

  return {
    vocab,
    thresholds,
    rules: new Map((data?.rules ?? []).map((rule) => [rule.id, rule])),
    // The content script needs this wording to know which links are worth measuring.
    declineSources: [...(data?.vocabulary?.decline ?? [])],
    cancelSources: [...(data?.vocabulary?.cancelLink ?? [])],
  };
}

/**
 * Judge one scan's measurements.
 * Returns Layer 2 findings, plus the Layer 1 rule ids this scan has settled by
 * measuring what they could only guess at from wording.
 */
export function classifyStructure(structure, compiled) {
  if (!structure || !compiled) return { findings: [], supersedes: [] };

  const viewport = viewportOf(structure.viewport);
  const overlays = (structure.overlays ?? []).filter(Boolean);
  const hits = new Map();
  const supersedes = new Set();

  for (const overlay of overlays) {
    const dimmed = isDimmed(overlay, overlays);
    if (isInterruption(overlay, viewport, dimmed, compiled)) {
      record(hits, compiled, "unprompted-popup", describeInterruption(overlay, viewport, dimmed));
    }
  }

  for (const group of [...overlays, ...(structure.groups ?? [])]) {
    if (!group?.controls?.length) continue;
    const consent = matchesAny(compiled.vocab.consentContext, clean(group.text));
    const verdict = judgeChoice(group.controls, consent, compiled);
    if (consent && verdict.measured) {
      for (const id of compiled.rules.get("biased-buttons")?.settles ?? []) supersedes.add(id);
    }
    if (verdict.biased) record(hits, compiled, "biased-buttons", verdict.evidence);
  }

  for (const box of structure.checkboxes ?? []) {
    const ruleId = tickedBoxRule(box, compiled);
    if (ruleId) {
      record(hits, compiled, ruleId, `Already ticked: “${shorten(clean(box.label), QUOTE_CHARS)}”`);
    }
  }

  for (const link of structure.cancelLinks ?? []) {
    const evidence = hiddenLinkEvidence(link, compiled);
    if (evidence) record(hits, compiled, "hidden-cancel-link", evidence);
  }

  return { findings: [...hits.values()], supersedes: [...supersedes] };
}

/** What a control's label means: accept, decline, exit, other or unlabelled. */
export function labelKind(label, compiled, { consent = false } = {}) {
  return kindOf(clean(label), consent, compiled.vocab);
}

// ---------------------------------------------------------------------------
// Pop-up interruptions

/**
 * Is the page dimmed *under* this pop-up? Either it brings its own backdrop, or
 * a separate dimming layer sits at or below it. A prompt that a later
 * interstitial's backdrop has covered was not the one that dimmed the page.
 */
function isDimmed(overlay, overlays) {
  if (overlay.dims) return true;
  const z = Number(overlay.z) || 0;
  return overlays.some((other) => other !== overlay && other.dims && (Number(other.z) || 0) <= z);
}

function isInterruption(overlay, viewport, dimmed, { vocab, thresholds: t }) {
  // Something the shopper opened themselves is not nagging.
  if (!overlay.unprompted) return false;

  // Cookie banners are legally required and region or age gates do a job;
  // neither is an interruption, although their buttons are still judged below.
  const text = clean(overlay.text);
  if (matchesAny(vocab.consentContext, text) || matchesAny(vocab.functionalContext, text)) {
    return false;
  }

  const hasContent = text.length >= t.minContentChars || overlay.hasImage || overlay.hasFrame;
  if (!hasContent) return false; // e.g. a dimming backdrop on its own

  const shape = shapeOf(overlay.rect, viewport, t);
  if (shape === "bar") return false; // headers, footers, sticky add-to-cart strips

  const asks = asksSomething(overlay.controls ?? [], vocab);
  // A small floating box is only nagging when it wants something from you —
  // otherwise it is a chat bubble, a back-to-top arrow or a toast.
  if (shape === "small") return asks;

  return (
    dimmed ||
    Boolean(overlay.modal) ||
    coverageOf(overlay.rect, viewport) >= t.dialogMinCoverage ||
    asks
  );
}

function describeInterruption(overlay, viewport, dimmed) {
  const quote = shorten(clean(overlay.text), QUOTE_CHARS);
  const subject = quote ? `“${quote}”` : "A pop-up";
  let trait = "";
  if (dimmed) trait = " and dimmed the page behind it";
  else if (coverageOf(overlay.rect, viewport) >= 0.5) trait = " and covered half the screen or more";
  return `${subject} opened by itself${trait}.`;
}

function asksSomething(controls, vocab) {
  return controls.some((control) => {
    const kind = kindOf(clean(control?.text), false, vocab);
    return kind === "accept" || kind === "decline";
  });
}

function shapeOf(rect, viewport, t) {
  const r = rectOf(rect);
  const { width: vw, height: vh } = viewport;
  const fullWidth = r.width >= t.barMinWidth * vw;
  const short = r.height <= t.barMaxHeight * vh;
  const atEdge = r.y <= 0.05 * vh || r.y + r.height >= 0.95 * vh;
  if (fullWidth && short && atEdge) return "bar";
  if (coverageOf(r, viewport) < t.smallMaxCoverage) return "small";
  return "dialog";
}

// ---------------------------------------------------------------------------
// Biased buttons

function judgeChoice(controls, consent, { vocab, thresholds: t }) {
  const options = [];
  for (const control of controls) {
    if (!control) continue;
    const label = clean(control.text);
    const kind = kindOf(label, consent, vocab);
    if (kind === "exit" || kind === "unlabelled") continue;
    options.push({ kind, look: assess(control, label, t) });
  }

  const declines = options.filter((option) => option.kind === "decline");
  const accepts = options.filter((option) => option.kind === "accept");
  const pool = accepts.length ? accepts : options.filter((option) => option.kind === "other");
  if (!declines.length || !pool.length) return { measured: false, biased: false };

  const primary = pool.reduce((best, option) =>
    prominence(option.look) > prominence(best.look) ? option : best,
  );

  // The choice is fair if *any* way of saying no holds its own: a cookie banner
  // with an equal "Reject all" is balanced even when "Manage settings" is a link.
  let fairest = null;
  for (const decline of declines) {
    const signals = compare(primary.look, decline.look, t);
    const score = signals.reduce((sum, signal) => sum + signal.weight, 0);
    if (!fairest || score < fairest.score) fairest = { decline, signals, score };
  }

  const biased = fairest.score >= t.biasThreshold;
  return {
    measured: true,
    biased,
    evidence: biased ? describeBias(primary.look, fairest.decline.look, fairest.signals) : null,
  };
}

/** How a control actually looks on screen, reduced to the numbers we compare. */
function assess(control, label, t) {
  const surface = surfaceBehind(control.behind);
  const paint = paintOf(control.fill);
  const fill = paint.color && paint.color[3] > 0 ? composite(paint.color, surface) : null;
  const boxContrast = fill ? contrastRatio(fill, surface) : 1;
  const hasFill = paint.image || boxContrast >= t.visibleFillContrast;
  const box = hasFill && fill ? fill : surface;
  const boxChroma = chroma(box);

  // Black-on-white counts as strong as red-on-white: what matters is that the
  // button stands out from what is around it, not which colour it is.
  const strongFill =
    paint.image ||
    (hasFill && (boxChroma >= t.strongFillChroma || boxContrast >= t.strongFillContrast));

  // A translucent button fades both its text and its box into the background.
  const opacity = clampNumber(control.opacity ?? 1, 0, 1);
  const ink = composite(parseCssColor(control.color) ?? BLACK, box);
  const shownInk = mix(ink, surface, opacity);
  const shownBox = mix(box, surface, opacity);

  return {
    label,
    hasFill,
    strongFill,
    outlined: !hasFill && borderVisible(control.border, surface, t),
    colourful: hasFill && boxChroma >= t.strongFillChroma,
    boxChroma,
    textContrast: contrastRatio(shownInk, shownBox),
    area: positive(control.width) * positive(control.height),
    fontSize: parseFloat(control.fontSize) || 16,
  };
}

function compare(primary, decline, t) {
  const signals = [];
  if (primary.strongFill && !decline.strongFill) {
    if (decline.hasFill) signals.push({ key: "muted", weight: 1.5 });
    else if (decline.outlined) signals.push({ key: "outlined", weight: 0.5 });
    else signals.push({ key: "plain", weight: 2 });
  }
  if (primary.area > 0 && decline.area > 0 && decline.area / primary.area < t.sizeRatio) {
    signals.push({ key: "smaller", weight: 1 });
  }
  if (decline.textContrast < t.faintContrast && decline.textContrast + 1 < primary.textContrast) {
    signals.push({ key: "faint", weight: 1 });
  }
  if (decline.fontSize < primary.fontSize * t.fontRatio) {
    signals.push({ key: "smallType", weight: 0.5 });
  }
  return signals;
}

function describeBias(primary, decline, signals) {
  const words = {
    plain: "plain text",
    muted: decline.boxChroma < 0.08 ? "grey" : "pale",
    outlined: "only outlined",
    smaller: "less than half the size",
    faint: "faint against its background",
    smallType: "in smaller type",
  };
  const fill = signals.find((signal) => FILL_SIGNALS.has(signal.key));
  const rest = signals.filter((signal) => signal !== fill).map((signal) => words[signal.key]);
  const a = quoteLabel(primary.label, "the main button");
  const d = quoteLabel(decline.label, "the other option");

  if (fill) {
    const lead = primary.colourful ? "a bright, coloured button" : "a bold, filled button";
    return capitalise(`${a} is ${lead}, while ${d} is ${joinList([words[fill.key], ...rest])}.`);
  }
  return capitalise(`Next to ${a}, ${d} is ${joinList(rest)}.`);
}

function prominence(look) {
  const paint = look.strongFill ? 4 : look.hasFill ? 2 : look.outlined ? 1 : 0;
  return paint + Math.min(look.area / 20000, 3);
}

/** The opaque colour a control sits on, built up from its ancestors' backgrounds. */
function surfaceBehind(chain) {
  let surface = WHITE;
  for (const layer of [...(chain ?? [])].reverse()) {
    const paint = paintOf(layer);
    if (paint.color && paint.color[3] > 0) surface = composite(paint.color, surface);
  }
  return surface;
}

function paintOf(entry) {
  if (!entry) return { color: null, image: false };
  const background = parseBackgroundImage(entry.image);
  if (background.colors.length) return { color: averageColor(background.colors), image: false };
  return { color: parseCssColor(entry.color), image: background.image };
}

function borderVisible(border, surface, t) {
  if (!border || (parseFloat(border.width) || 0) < 1) return false;
  if (border.style === "none" || border.style === "hidden") return false;
  const color = parseCssColor(border.color);
  if (!color || color[3] === 0) return false;
  return contrastRatio(composite(color, surface), surface) >= t.outlineContrast;
}

// ---------------------------------------------------------------------------
// Hidden cancel links

/** Evidence if a cancel or unsubscribe link is styled to be overlooked, else null. */
function hiddenLinkEvidence(link, { vocab, thresholds: t }) {
  if (!link) return null;
  const label = clean(link.text);
  if (!label || !matchesAny(vocab.cancelLink, label)) return null;

  const look = assess(link, label, t);
  const traits = [];
  if (look.fontSize < t.hiddenLinkFontPx) traits.push(`tiny (${Math.round(look.fontSize)}px text)`);
  if (look.textContrast < t.hiddenLinkContrast) traits.push("faint against its background");
  if (!traits.length) return null;
  return `${quoteLabel(label, "The cancel link")} is ${joinList(traits)}.`;
}

// ---------------------------------------------------------------------------
// Pre-ticked boxes

function tickedBoxRule(box, { vocab }) {
  // Ticked by the shopper, or not ticked at all: nothing to report.
  if (!box || box.touched || box.checked === false) return null;
  const label = clean(box.label);
  if (!label) return null;
  if (matchesAny(vocab.optInBenign, label)) return null;
  if (matchesAny(vocab.optInAddOn, label)) return "preticked-addon";
  if (matchesAny(vocab.optInConsent, label)) return "preticked-consent";
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers

function kindOf(label, consent, vocab) {
  if (!label) return "unlabelled";
  if (label.length > MAX_CONTROL_LABEL) return "other"; // a clickable card, not a button
  if (matchesAny(vocab.exit, label)) return "exit";
  if (matchesAny(vocab.decline, label)) return "decline";
  if (consent && matchesAny(vocab.consentAlternative, label)) return "decline";
  if (matchesAny(vocab.accept, label)) return "accept";
  return "other";
}

function record(hits, compiled, ruleId, evidence) {
  const rule = compiled.rules.get(ruleId);
  if (!rule) return;

  let hit = hits.get(ruleId);
  if (!hit) {
    hit = {
      id: rule.id,
      category: rule.category,
      approach: rule.approach,
      mechanism: rule.mechanism,
      explanation: rule.explanation,
      severity: rule.severity ?? "medium",
      source: rule.source ?? null,
      layer: "structure",
      matchCount: 0,
      evidence: [],
    };
    hits.set(ruleId, hit);
  }

  hit.matchCount += 1;
  if (evidence && hit.evidence.length < MAX_EVIDENCE_PER_RULE && !hit.evidence.includes(evidence)) {
    hit.evidence.push(evidence);
  }
}

function matchesAny(patterns, text) {
  return Boolean(text) && (patterns ?? []).some((pattern) => pattern.test(text));
}

function clean(text) {
  return String(text ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function shorten(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function quoteLabel(label, fallback) {
  return label ? `“${shorten(label, LABEL_CHARS)}”` : fallback;
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function joinList(items) {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function viewportOf(viewport) {
  const width = positive(viewport?.width);
  const height = positive(viewport?.height);
  return width && height ? { width, height } : DEFAULT_VIEWPORT;
}

function rectOf(rect) {
  return {
    x: Number(rect?.x) || 0,
    y: Number(rect?.y) || 0,
    width: positive(rect?.width),
    height: positive(rect?.height),
  };
}

/** Share of the viewport a rectangle covers, counting only the part on screen. */
function coverageOf(rect, viewport) {
  const r = rectOf(rect);
  const width = Math.max(0, Math.min(r.x + r.width, viewport.width) - Math.max(r.x, 0));
  const height = Math.max(0, Math.min(r.y + r.height, viewport.height) - Math.max(r.y, 0));
  return (width * height) / (viewport.width * viewport.height);
}

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : max;
}
