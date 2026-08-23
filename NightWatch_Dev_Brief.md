# NightWatch — Dark Pattern Detection Browser Extension
### Development Brief for Claude Code

**Author:** Ali (UTS Software Engineering, Capstone B)
**Status:** Capstone A (research + planning) complete. Starting Capstone B build in Week 5 (running ~3 weeks behind schedule due to internship).
**Purpose of this doc:** Everything Claude Code needs to know to start scaffolding and building the extension, without re-deriving the research context.

---

## 1. Project Summary

NightWatch is a browser extension that detects and flags **dark patterns** (manipulative UI/UX design techniques) on e-commerce and related websites in real time, and explains to the user — in plain language — what psychological mechanism is being used against them.

The core research problem: dark pattern classification is fragmented across academic and regulatory frameworks, and no existing tool combines **text-based** and **structural (DOM)** detection in a real-time, consumer-facing browser extension validated against platforms Australians actually use.

NightWatch addresses this by:
1. Operationalising a **mechanism-first classification taxonomy** (based on Gray et al., 2024) into detection rules.
2. Combining **keyword/phrase matching** with **DOM structural analysis** (a hybrid approach most prior tools lack).
3. Being validated against real e-commerce sites (e.g. AliExpress) rather than only lab-simulated interfaces.
4. Explaining detected patterns to users in plain language rather than just flagging them.

---

## 2. Classification Taxonomy (Gray et al., 2024 — three-tier ontology)

This is the **primary classification framework** driving the whole rule engine. Every detection rule should map to one of these categories.

| High-level Strategy | Representative meso-level approaches | Example implementation |
|---|---|---|
| **Nagging** | Repeated interruption, persistent prompting | Pop-ups requesting newsletter signup on every page visit |
| **Obstruction** | Roach Motel (easy in, hard out), cognitive obstruction | Multi-step cancellation flows, misleading navigation labels |
| **Sneaking** | Hidden costs, sneak-into-basket, pre-selection | Optional items pre-ticked in checkout basket |
| **Interface Interference** | Confirmshaming, visual misdirection, trick questions | Default opt-in checkboxes styled to blend with required fields; false visual hierarchy in buttons |
| **Forced Action** | Forced account creation, forced social engagement | Requiring account registration to complete a guest purchase |

Additional psychological mechanisms to encode into detection logic (from lit review — not 1:1 with the table above, these are the *why*):
- **Scarcity / loss aversion** — fake urgency, low-stock warnings, countdown timers
- **Social proof manipulation** — "X people viewing this", inflated review counts, "best seller" badges
- **Cognitive overload** — layered discount displays, excessive information, confusing opt-outs
- **Anchoring** — inflated "was" price next to a discounted price
- **Sunk cost / commitment bias** — roach motel, forced continuity
- **Confirmshaming** — guilt-framed decline buttons ("No thanks, I like paying full price")

**Design implication:** the classifier should not rely purely on surface keyword matching — it needs to consider the underlying mechanism so it generalises to phrasing it hasn't seen before (this was a specific problem identified in the literature review).

---

## 3. System Architecture (Manifest V3)

Standard 3-component WebExtension architecture:

```
Content Script (runs in page)
   ↓ extracts text + DOM structure
   ↓ sends signals via browser messaging API
Service Worker (background script)
   ↓ runs classification logic (Layer 1 + Layer 2)
   ↓ manages persistent state (chrome.storage.local)
   ↓ sends results to popup
Extension Popup (user-facing UI)
   → displays detected patterns grouped by Gray et al. category
   → plain-language explanation per pattern
   → links to source evidence where available (e.g. CPRC 2022, FTC)
```

### Detection Layers

**Layer 1 — Text-based detection**
- Keyword/phrase matching on visible text extracted from the DOM.
- Targets: urgency language, confirmshaming phrases, countdown timer text, "X left in stock", "X people viewing/in carts".
- Rule source: labelled Kaggle datasets (see §5) + manually observed examples.

**Layer 2 — DOM structural detection**
- Traverses DOM to detect structural manipulation that text alone won't catch:
  - Multi-step cancellation overlays / hidden unsubscribe links (Obstruction)
  - False visual hierarchy (e.g. "Buy Now" button styled prominent, "No thanks" tiny/greyed) (Interface Interference)
  - Pre-ticked optional checkboxes at checkout (Sneaking)
- This layer exists because many dark patterns (e.g. confirmshaming buttons) use benign text but convey manipulation through position, size, color contrast — text extraction alone misses this.

**Layer 3 — Community reports (later sprint / stretch goal)**
- Users can submit site-specific pattern reports (stored in `chrome.storage.local`, optionally synced later).
- Needs a moderation layer: restrict to pattern-level descriptions (not brand-level judgements), character limits on free text, de-duplication.
- Not required for MVP — build Layer 1 + 2 first.

---

## 4. Tech Stack

- **Manifest V3** WebExtensions API (cross-browser target: Chrome first, Firefox regression-tested later)
- **JavaScript** for content scripts + service worker (no framework needed for MVP; keep it vanilla/lightweight per the sustainability goal of being usable on low-resource devices)
- **chrome.storage.local** for all persistence — no external data transmission, no backend server for MVP (this is also an explicit ethics/privacy commitment: no browsing history or personal data collected)
- Popup UI: plain HTML/CSS/JS, no build step needed initially — keep it simple and accessible
- Optional (Capstone B later phase): Python-based NLP backend for a more advanced classifier — **not required for MVP**, start with rule-based keyword + structural heuristics first since that's testable immediately

---

## 5. Data Sources for Rule-Building

- **Kaggle Dark Pattern Dataset (Adarsh M09)** — https://www.kaggle.com/datasets/adarshm09/dark-pattern-dataset — labelled UI text across 11 dark pattern categories. Note: category labels need remapping to the Gray et al. (2024) five-strategy taxonomy.
- **Kaggle Dark Pattern Dataset (Devitachi)** — https://www.kaggle.com/datasets/devitachi/dark-pattern — supplementary dataset, useful where Adarsh dataset has thin coverage (e.g. Confirmshaming, Cognitive Overload are under-represented in Adarsh's set).
- **Hall of Shame Design archive** — https://hallofshame.design — real, documented examples (e.g. Amazon Audible cancellation flow) useful as ground-truth references and for writing plain-language explanations with citations.
- **Direct site observation** (manual) — e.g. AliExpress product listing/checkout screenshots showing simultaneous scarcity + anchoring + urgency + hidden cost patterns (see wireframe below, based on a real observed example). Use these as hand-labelled test cases during development.

---

## 6. UI / Wireframe Reference

Two wireframes exist already: `wireframe-rev1.png` and `wireframe-captstone-b.jpg` (see §7.1 for where to place them). Key UI behaviour to build toward:

1. **On-page injected warning box** near/over the detected pattern (or at minimum, a badge on the browser toolbar icon) reading:
   > **Warning! Dark Pattern Detected: [Pattern Name]**
   > *Plain-language explanation of what the page is doing and why.*

   Example from wireframe: `False Urgency` — "This product page displays a false amount of stock availability to leverage impulse buying."

2. **Scroll-triggered / expandable list** of *other* patterns detected on the same page, e.g.:
   - Price manipulation / hidden fees
   - Nagging
   - Interface Interference

3. Each flagged pattern should map cleanly to one of the 5 Gray et al. categories so the popup can group results consistently.

4. Non-intrusive by design — accessible via toolbar click, not a forced interrupt, per accessibility/vulnerable-user commitments in the proposal. On second thought I don't know about this now since how will they know if there are dark patterns if they do not click on the extension. I think a good thing is to make it not keep popping up multiple times for the same site but different pages, but instead just have 1 general popup for the whole site no matter the product page you are on, the extension will show the most common/aggressive or worst dark pattern present on the site as a whole. And when the user clicks the extension on any of the pages they can view it any time.

**MVP UI scope:** start with the toolbar popup showing a list of detected patterns for the current page (category + plain-language explanation). The in-page floating warning box is a nice-to-have for a later sprint — build the popup first since it's simpler to implement and test.

---

## 7. Project Setup

### 7.1 Recommended folder structure

```
nightwatch/
├── NightWatch_Dev_Brief.md        ← this file, lives in project root
├── docs/
│   ├── wireframe-rev1.png         ← the "False Urgency" popup wireframe
│   └── wireframe-captstone-b.jpg  ← the fuller Capstone B wireframe
├── manifest.json
├── background/
│   └── service-worker.js
├── content/
│   └── content-script.js
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── rules/
│   └── keyword-rules.json         ← Layer 1 detection rules
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

Placing `NightWatch_Dev_Brief.md` directly in the project root (next to `manifest.json`) is correct — in Zed with the Claude Code integration, Claude Code reads files relative to the workspace root you have open, so anything sitting in the root or in a clearly-named subfolder (like `docs/`) is visible to it once you open/reference the folder as your project workspace. There's no special "config" location it needs to be in — it's just a reference doc, not a config file.

Practical tips for Zed + Claude Code:
- Open the `nightwatch/` folder as your project workspace in Zed (not a parent folder), so paths in the brief and any code Claude Code writes stay consistent.
- When you start a Claude Code session, point it at the brief explicitly the first time, e.g.: *"Read NightWatch_Dev_Brief.md in the project root, then scaffold the MVP described in section 7.2 (hello world extension test) so I can load it via Chrome Developer Mode."* Claude Code doesn't automatically read every file in the repo unless you tell it to or it searches for context — an explicit pointer on your first message saves back-and-forth.
- Put the two wireframe images in `docs/` (as shown above) — image files aren't something Claude Code can "see" the pixels of, but keeping them in the repo with sensible names means you can reference them in prompts (e.g. *"See docs/wireframe-rev1.png — the popup should look like that layout"*) and describe what's in them if you need Claude Code to match specific UI details.
- Keep the brief up to date as the project evolves — treat it like a living spec, not a one-time handoff. Re-open and edit it yourself (or ask Claude Code to update relevant sections) as decisions get made during development.

### 7.2 Developer Mode "Hello World" test (do this FIRST, before any detection logic)

This is the minimum working extension that proves your tooling and load-unpacked workflow function before you write a single line of detection logic. Ask Claude Code to scaffold exactly this first.

**Step 1 — `manifest.json`** (project root)

```json
{
  "manifest_version": 3,
  "name": "NightWatch",
  "version": "0.0.1",
  "description": "Detects and flags dark patterns on e-commerce sites.",
  "permissions": ["storage", "activeTab", "scripting"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background/service-worker.js"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content/content-script.js"]
    }
  ],
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": "icons/icon48.png"
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

**Step 2 — `content/content-script.js`** (proves the content script runs on real pages)

```javascript
console.log("[NightWatch] content script loaded on:", window.location.href);
```

**Step 3 — `background/service-worker.js`** (proves the background script runs)

```javascript
console.log("[NightWatch] service worker started");

chrome.runtime.onInstalled.addListener(() => {
  console.log("[NightWatch] extension installed");
});
```

**Step 4 — `popup/popup.html`** (proves the popup renders)

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>NightWatch</title>
  <style>
    body { font-family: sans-serif; width: 250px; padding: 12px; }
  </style>
</head>
<body>
  <h3>NightWatch 🌙</h3>
  <p>Hello NightWatch — extension is loaded and working.</p>
</body>
</html>
```

**Step 5 — icons.** For this hello-world test, any placeholder 16x16 / 48x48 / 128x128 PNG works (even a solid-colour square). Ask Claude Code to generate simple placeholder icons, or drop in any temporary PNGs at those sizes — you'll replace them with a real NightWatch icon later.

**Step 6 — Load it in Chrome/Chromium:**

1. Open `chrome://extensions/`
2. Toggle **Developer mode** on (top-right switch)
3. Click **Load unpacked**
4. Select the `nightwatch/` project folder (the one containing `manifest.json` directly — not a parent folder)
5. NightWatch should now appear as a card in the extensions list with no errors

**Step 7 — Verify each piece works:**

- **Content script:** visit any website, open DevTools (`F12` or right-click → Inspect) → **Console** tab → you should see `[NightWatch] content script loaded on: <url>`
- **Service worker:** go back to `chrome://extensions/` → find the NightWatch card → click the blue **"service worker"** link (appears under "Inspect views") → a DevTools window opens showing that background context's console → you should see `[NightWatch] service worker started` and `[NightWatch] extension installed`
- **Popup:** click the NightWatch icon in the browser toolbar (you may need to click the puzzle-piece icon and pin it first) → you should see the "Hello NightWatch" popup render

**Step 8 — Reload after changes:**

Every time you (or Claude Code) edit any file, go back to `chrome://extensions/` and click the small circular **reload icon** on the NightWatch card — you do *not* need to click "Load unpacked" again unless you moved the project folder. For content script changes specifically, you also need to refresh the actual webpage tab you're testing on, since content scripts only inject on page load.

Once all three consoles show the expected output and the popup renders, your environment is proven and you can move to §8 (MVP build order) with confidence that load/reload/debug workflow works.

---

## 8. MVP Feature Scope (build this after §7.2 passes)

Do **not** try to build all three detection layers + community reports at once. Suggested build order:

1. ~~**Scaffold**: Manifest V3 extension skeleton~~ — done in §7.2 above.
2. **Layer 1 (text detection) v0**: hardcode ~15–20 keyword/phrase rules (urgency, confirmshaming, low-stock, social proof) covering the 5 categories. Get this working end-to-end: content script scans DOM text → sends matches to service worker → popup displays them.
3. **Layer 1 v1**: replace hardcoded list with rules derived from the Kaggle datasets (after remapping labels to the 5-category taxonomy).
4. **Layer 2 (DOM structural)**: add heuristics for pre-ticked checkboxes, disproportionate button styling (size/color contrast between primary and secondary CTA), multi-step obstruction detection.
5. **Popup UI polish**: group by category, add plain-language explanations, add source citation links where applicable (CPRC 2022, FTC).
6. **(Stretch) Layer 3**: community reporting + local moderation rules.

---

## 9. Testing Strategy (ongoing, beyond the initial hello-world)

You're right that Chromium browsers have a **Developer Mode** toggle — this is the main way to test locally without publishing to the Chrome Web Store. See §7.2 for the full first-time walkthrough. Beyond that initial setup:

1. To test on real dark patterns, visit sites with known instances (AliExpress product pages are a good test case — persistent "Only X left" scarcity indicators, inflated reference prices, "Almost sold out!" checkout labels).
2. For automated testing later: consider `web-ext` (Mozilla's CLI tool, also works reasonably for Chrome dev workflows) or simple Jest unit tests for the pure detection-logic functions (keep DOM-parsing logic separated from browser API calls so it's unit-testable without a real browser).

No user data or backend is involved in MVP, so testing is just: load unpacked → visit real/test pages → check popup output against manually verified ground-truth (your own annotated observations, per the site observation protocol below).

---

## 10. Site Observation / Ground-Truth Protocol (for validating detection)

When manually testing/validating against a real page, record:

| Field | Description |
|---|---|
| Platform | Name + URL |
| Date/Time | Observation timestamp |
| Page Type | e.g. product listing, checkout, cancellation flow |
| Pattern Category | Gray et al. (2024) high-level strategy |
| Pattern Approach | Meso-level approach (e.g. Roach Motel, Confirmshaming) |
| Implementation Description | Plain description of what you saw |
| Detection Layer | Text-based (1) or Structural (2) |
| Screenshot Reference | File name/link |
| Notes | e.g. persisted across sessions? one-off? |

This log becomes your held-out validation set for checking detection accuracy once Layer 1/2 are built.

---

## 11. Ethical / Design Constraints to Respect in Code

- **No personal data collection.** No browsing history, no external transmission of page content. Everything stays in `chrome.storage.local`.
- **No unverified brand-level accusations.** Any platform-specific warning must be backed by documented evidence (from the literature or your own logged observations with screenshots) — don't let the extension make unverified claims about a named company that could be legally risky.
- **Plain-language explanations.** Avoid jargon in the popup text — target users have no prior knowledge of dark pattern research. This matters for accessibility (older users, lower digital literacy, non-native English speakers per the project's equity framing).
- **Lightweight/low-resource.** Avoid heavy frameworks or large bundles — relevant for users on limited data plans/older devices (explicit sustainability goal in the proposal).

---

## 12. Key Sources for Reference (don't need to re-read, just context)

- Gray et al. (2018, 2024) — strategic taxonomy → three-tier ontology (primary classification framework)
- Mathur et al. (2019) — 11K site crawl, 15-type/7-category taxonomy, empirical scale evidence
- Mamidwar & Bhutkar (2024) — comparative regulatory guideline analysis (EDPB, FTC, CCPA, KFTC)
- Zac et al. (2025) — dark patterns & consumer vulnerability; found susceptibility is broadly universal, not narrowly demographic
- Bijelac (2025) — controlled HCI experiment confirming measurable harm (spend, time-on-site, trust/control)
- Consumer Policy Research Centre (2022) — Australian survey data (83% experienced negative consequence; 88% hidden costs; 76% cancellation difficulty)
- Cara & Rughiniș (2020) — naming inconsistency across academic literature
- Kaggle datasets (Adarsh M09; Devitachi) — labelled training data
- Hall of Shame Design archive — documented real-world examples

---

## 13. Immediate Next Steps for Claude Code

1. Read this file (`NightWatch_Dev_Brief.md`) in full.
2. Scaffold the Manifest V3 "hello world" extension exactly as described in §7.2.
3. Confirm all three consoles (content script, service worker, popup) work per the verification steps in §7.2, Step 7.
4. Implement Layer 1 keyword detection with a small hardcoded rule set (§8 step 2) before touching the Kaggle datasets.
5. Iterate from there per the MVP build order in §8.
