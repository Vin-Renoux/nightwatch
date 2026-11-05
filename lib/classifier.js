/**
 * NightWatch — Layer 1 (text) classification.
 *
 * A rule can narrow itself three ways, all aimed at false positives:
 *   notPatterns          — if one matches the same text, the hit is dropped
 *                          ("Temu won't ask for extra fees" is not a hidden cost)
 *   minDistinctPatterns  — needs that many *different* patterns to match
 *                          somewhere on the page before it reports
 *                          (a header "Sign in / Register" link is not a login wall)
 *   requiresCommerce     — only reports on a page that looks like a shop
 *                          ("Browse most popular courses" on LinkedIn Learning
 *                          is a section heading, not a popularity badge)
 */

/** Display order for the five Gray et al. (2024) high-level strategies. */
export const CATEGORY_ORDER = [
  "Interface Interference",
  "Sneaking",
  "Obstruction",
  "Forced Action",
  "Nagging",
];

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };
const MAX_EVIDENCE_PER_RULE = 3;
const SNIPPET_CHARS = 100;

const COMMERCE_SIGNALS = [
  /\badd to (cart|basket|bag|trolley)\b/i,
  /\bbuy (now|it now)\b/i,
  /\b(proceed to )?check ?out\b/i,
  /\bfree\b.{0,12}\b(shipping|delivery|returns)\b/i,
  /\b(in|out of) stock\b/i,
  /(au|us|nz|ca|c)?\$\s?\d/i,
  /\bshop (now|deals|all|by)\b/i,
  /\bdeals?\b/i,
  /\badd to (wish ?list|favou?rites)\b/i,
  /\b(product|item) (details|description|reviews)\b/i,
  /\b(sold by|ships? (to|from))\b/i,
  /\b(cart|basket)\b/i,
];
const COMMERCE_THRESHOLD = 2;

export function compileRules(ruleData) {
  return (ruleData?.rules ?? []).map((rule) => ({
    ...rule,
    matchers: rule.patterns.map((pattern) => new RegExp(pattern, "i")),
    notMatchers: (rule.notPatterns ?? []).map((pattern) => new RegExp(pattern, "i")),
    minDistinctPatterns: rule.minDistinctPatterns ?? 1,
  }));
}

export function commerceScore(segments) {
  const seen = new Set();
  for (const segment of segments ?? []) {
    if (typeof segment !== "string") continue;
    for (const [index, signal] of COMMERCE_SIGNALS.entries()) {
      if (!seen.has(index) && signal.test(segment)) seen.add(index);
    }
  }
  return seen.size;
}

export function looksLikeShop(segments) {
  return commerceScore(segments) >= COMMERCE_THRESHOLD;
}

export function classifySegments(segments, compiledRules) {
  const hits = new Map();
  const isShop = looksLikeShop(segments);

  for (const segment of segments ?? []) {
    if (typeof segment !== "string" || segment.length === 0) continue;

    for (const rule of compiledRules) {
      if (rule.requiresCommerce && !isShop) continue;
      if (rule.notMatchers.some((matcher) => matcher.test(segment))) continue;

      for (const [index, matcher] of rule.matchers.entries()) {
        const match = matcher.exec(segment);
        if (!match) continue;

        let hit = hits.get(rule.id);
        if (!hit) {
          hit = newHit(rule);
          hits.set(rule.id, hit);
        }

        hit.matchCount += 1;
        hit.matchedPatterns.add(index);
        addEvidence(hit, segment, match);
        break;
      }
    }
  }

  return [...hits.values()]
    .filter((hit) => hit.matchedPatterns.size >= hit.minDistinctPatterns)
    .map(stripInternals)
    .sort(compareFindings);
}

export function mergeFindings(existing, incoming) {
  const byId = new Map();
  for (const finding of existing ?? []) {
    byId.set(finding.id, { ...finding, evidence: [...finding.evidence] });
  }

  for (const finding of incoming ?? []) {
    const prior = byId.get(finding.id);
    if (!prior) {
      byId.set(finding.id, { ...finding, evidence: [...finding.evidence] });
      continue;
    }
    prior.matchCount = Math.max(prior.matchCount, finding.matchCount);
    for (const quote of finding.evidence) {
      if (prior.evidence.length >= MAX_EVIDENCE_PER_RULE) break;
      if (!prior.evidence.includes(quote)) prior.evidence.push(quote);
    }
  }

  return [...byId.values()].sort(compareFindings);
}

export function foldScan(previous, incoming, supersedes = []) {
  const superseded = [...new Set([...(previous?.superseded ?? []), ...supersedes])];
  const findings = mergeFindings(previous?.findings, incoming).filter(
    (finding) => !superseded.includes(finding.id),
  );
  return { findings, superseded };
}

export function groupByCategory(findings) {
  const groups = new Map();
  for (const finding of findings) {
    const bucket = groups.get(finding.category) ?? [];
    bucket.push(finding);
    groups.set(finding.category, bucket);
  }

  const known = CATEGORY_ORDER.filter((category) => groups.has(category));
  const unknown = [...groups.keys()].filter((category) => !CATEGORY_ORDER.includes(category));

  return [...known, ...unknown].map((category) => ({
    category,
    findings: groups.get(category),
  }));
}

function newHit(rule) {
  return {
    id: rule.id,
    category: rule.category,
    approach: rule.approach,
    mechanism: rule.mechanism,
    explanation: rule.explanation,
    severity: rule.severity ?? "medium",
    source: rule.source ?? null,
    layer: "text",
    matchCount: 0,
    evidence: [],
    matchedPatterns: new Set(),
    minDistinctPatterns: rule.minDistinctPatterns,
  };
}

function addEvidence(hit, segment, match) {
  if (hit.evidence.length >= MAX_EVIDENCE_PER_RULE) return;
  const quote = snippet(segment, match.index, match[0].length);
  if (!hit.evidence.includes(quote)) hit.evidence.push(quote);
}

function stripInternals({ matchedPatterns, minDistinctPatterns, ...finding }) {
  return finding;
}

function compareFindings(a, b) {
  const bySeverity = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
  if (bySeverity !== 0) return bySeverity;
  if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
  return a.approach.localeCompare(b.approach);
}

function snippet(text, index, length) {
  const padding = Math.max(0, Math.floor((SNIPPET_CHARS - length) / 2));
  const start = Math.max(0, index - padding);
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  const body = text.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}
