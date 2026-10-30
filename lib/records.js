/**
 * Documented regulator actions for the site being viewed (rules/known-records.json).
 *
 * This is background about the company, not a detection on the page: a single
 * page view cannot show that cancelling takes six screens, but a regulator's
 * case file can. Matching is by domain only, and nothing is fetched online.
 */

/** Records whose domains cover this URL's host (example.com also covers www.example.com). */
export function recordsFor(url, data) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return [];
  }
  return (data?.records ?? []).filter((record) =>
    (record.domains ?? []).some((domain) => host === domain || host.endsWith(`.${domain}`)),
  );
}
