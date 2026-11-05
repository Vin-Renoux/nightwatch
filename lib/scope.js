/**
 * Which pages NightWatch will look at.
 * Search engines are excluded on purpose
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

export function isScannable(url) {
  const parsed = parse(url);
  if (!parsed) return false;
  if (!SCANNABLE_PROTOCOLS.has(parsed.protocol)) return false;
  return !isSearchPage(url);
}

export function skipReason(url) {
  const parsed = parse(url);
  if (!parsed) return "unsupported";
  if (!SCANNABLE_PROTOCOLS.has(parsed.protocol)) return "unsupported";
  if (isSearchPage(url)) return "search";
  return null;
}

export const PAGE_KEY_PREFIX = "page:";

export function storageKeyFor(url) {
  const pageKey = pageKeyFor(url);
  return pageKey ? PAGE_KEY_PREFIX + pageKey : null;
}

export function pageKeyFor(url) {
  const parsed = parse(url);
  if (!parsed) return null;
  parsed.hash = "";
  return parsed.href;
}

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
