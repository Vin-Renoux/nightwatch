/**
 * Which pages NightWatch will look at.
 *
 * Search engines are excluded on purpose: their result snippets quote text
 * from other sites, so scanning them flags dark patterns that are not on the
 * page in front of you (see docs/Screenshot_20260823_153225.png — a Google
 * results page flagged Amazon's "30-day free trial" snippet).
 */

const SEARCH_HOST_PATTERNS = [
  /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2})?$/,
  /(^|\.)bing\.com$/,
  /(^|\.)duckduckgo\.com$/,
  /(^|\.)search\.brave\.com$/,
  /(^|\.)search\.yahoo\.com$/,
  /(^|\.)ecosia\.org$/,
  /(^|\.)startpage\.com$/,
  /(^|\.)yandex\.[a-z.]+$/,
  /(^|\.)baidu\.com$/,
];

const SCANNABLE_PROTOCOLS = new Set(["http:", "https:", "file:"]);

export function isSearchPage(url) {
  const parsed = parse(url);
  if (!parsed) return false;
  return SEARCH_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname));
}

/** Normal web page (or a local test fixture) that is not a search engine. */
export function isScannable(url) {
  const parsed = parse(url);
  if (!parsed) return false;
  if (!SCANNABLE_PROTOCOLS.has(parsed.protocol)) return false;
  return !isSearchPage(url);
}

/** Why a page was skipped, for the popup to explain. */
export function skipReason(url) {
  const parsed = parse(url);
  if (!parsed) return "unsupported";
  if (!SCANNABLE_PROTOCOLS.has(parsed.protocol)) return "unsupported";
  if (isSearchPage(url)) return "search";
  return null;
}

/** Storage key for a page: the URL without its fragment. */
export function pageKeyFor(url) {
  const parsed = parse(url);
  if (!parsed) return null;
  parsed.hash = "";
  return parsed.href;
}

/** Short, readable version of a URL for display. */
export function friendlyUrl(url, maxLength = 64) {
  const parsed = parse(url);
  if (!parsed) return url;
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  const text = `${parsed.hostname}${path}`;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
