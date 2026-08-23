/**
 * NightWatch — Layer 1 (text) classification.
 *
 * Deliberately free of chrome.* APIs and DOM access: this file takes plain
 * strings in and returns plain objects out, so the detection logic can be
 * unit-tested in Node without a browser (brief §9).
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

/** Turn the JSON rule file into rules with compiled regexes. */
export function compileRules(ruleData) {
  return (ruleData?.rules ?? []).map((rule) => ({
    ...rule,
    matchers: rule.patterns.map((pattern) => new RegExp(pattern, "i")),
  }));
}

/**
 * Run every rule over every visible text segment.
 * Returns one finding per matched rule, ordered worst-first.
 */
export function classifySegments(segments, compiledRules) {
  const hits = new Map();

  for (const segment of segments ?? []) {
    if (typeof segment !== "string" || segment.length === 0) continue;

    for (const rule of compiledRules) {
      for (const matcher of rule.matchers) {
        const match = matcher.exec(segment);
        if (!match) continue;

        let hit = hits.get(rule.id);
        if (!hit) {
          hit = {
            id: rule.id,
            category: rule.category,
            approach: rule.approach,
            mechanism: rule.mechanism,
            explanation: rule.explanation,
            severity: rule.severity ?? "medium",
            source: rule.source ?? null,
            matchCount: 0,
            evidence: [],
          };
          hits.set(rule.id, hit);
        }

        hit.matchCount += 1;
        if (hit.evidence.length < MAX_EVIDENCE_PER_RULE) {
          const quote = snippet(segment, match.index, match[0].length);
          if (!hit.evidence.includes(quote)) hit.evidence.push(quote);
        }
        break; // one hit per rule per segment, however many patterns match
      }
    }
  }

  return [...hits.values()].sort(compareFindings);
}

/** Group findings for the popup, in taxonomy order. */
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

function compareFindings(a, b) {
  const bySeverity = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
  if (bySeverity !== 0) return bySeverity;
  if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
  return a.approach.localeCompare(b.approach);
}

/** A short quote of the matched text, for showing the user what triggered a rule. */
function snippet(text, index, length) {
  const padding = Math.max(0, Math.floor((SNIPPET_CHARS - length) / 2));
  const start = Math.max(0, index - padding);
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  const body = text.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}
