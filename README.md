# NightWatch 🌙

**A browser extension that notifies you about dark patterns on sites you visit.**

Dark patterns are design tricks that push you into decisions you might not otherwise make. NightWatch watches the page as you browse, flags these tricks with a red count on its toolbar icon, and tells you what each one is and why it works.

Everything happens inside your browser. NightWatch has no server, collects no browsing history, and sends nothing anywhere.

---

## Install

NightWatch works in Chromium-based browsers: **Chrome, Brave, Edge, Opera and Vivaldi**. It is not on the Chrome Web Store, so it is installed in developer mode.

1. Download `nightwatch-<version>.zip` from this repository's **Releases** page.
2. **Unzip it.** Browsers cannot load the zip file directly — you need the folder inside, the one containing `manifest.json`. Keep that folder somewhere permanent: the browser loads the extension from it every time it starts.
3. Open your browser's extensions page by typing one of these into the address bar:
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`
4. Turn on **Developer mode** (a switch in the top-right corner; in Edge it is in the left sidebar).
5. Click **Load unpacked** and choose the unzipped folder.
6. Click the puzzle-piece icon in the toolbar and **pin** NightWatch so its icon is always visible.

To update, download the new release, replace the folder's contents, and click the circular reload arrow on NightWatch's card in the extensions page.

> **Testing with local HTML files?** Extensions do not run on `file://` pages unless you allow it: on NightWatch's card in the extensions page, click **Details** and turn on **Allow access to file URLs**.

---

## Using it

NightWatch checks every page you visit and keeps checking as the page changes — pop-ups appearing, prices updating, checkout steps opening.

- **The toolbar icon** shows a red number when dark patterns are found on the current page.
- **Click the icon** to see them, grouped into five categories. Each row shows the pattern's name; click it to drop down an explanation of the trick, what it plays on, and the evidence NightWatch found.
- **Wording** or **Layout** tags show how each one was found — from what the page *says*, or from how it is *built* (button sizes and colours, pop-ups, ticked boxes).
- **On record** appears on sites run by companies that a regulator has taken legal action against over dark patterns, with the case cited. It is background about the company, not something found on the page, and is never counted in the red number.
- The **sun/moon button** switches between the night theme and a light theme. Your choice is remembered.

NightWatch does not scan search engine result pages, because their snippets quote text from other sites.

---

## What it detects

Every pattern belongs to one of the five strategies in the dark-pattern taxonomy of Gray et al. (2024).

| Family | Patterns |
|---|---|
| **Interface Interference** — design that steers your choice | Biased Buttons · Pre-ticked Opt-in · Confirmshaming · Trick Questions · Scarcity Claim · Urgency Pressure · Social Proof Pressure · Popularity Badges · Price Anchoring · Biased Choice Presentation |
| **Sneaking** — things added or hidden without asking | Hidden Costs · Sneak into Basket · Pre-ticked Add-on · Forced Continuity |
| **Obstruction** — making it hard to leave or say no | Roach Motel (Hard to Cancel) · Hidden Cancel Link · Hard to Leave |
| **Forced Action** — making you do something before you can continue | Forced Account Creation · Login Wall · Forced Registration to View · App-Only Access |
| **Nagging** — interrupting you to get a yes | Pop-up Interruption · Newsletter Nagging · Notification Nagging |

### How it decides

NightWatch combines two kinds of check:

- **Wording (Layer 1)** reads the visible text — including the alt text of image badges — and matches it against phrasing rules, such as "Only 2 left in stock" or "No thanks, I prefer to pay full price". Rules can be narrowed so that, for example, "we won't charge extra fees" is not read as a hidden cost, and marketing words like "most popular" only count on pages that sell something.
- **Layout (Layer 2)** measures the page itself:
  - a pop-up only counts as an interruption if it **opened without you clicking anything** — one you opened yourself is not nagging;
  - buttons are compared using the WCAG accessibility contrast formula, so "Allow" in bright red beside "Don't allow" in pale grey is caught even though the words are harmless;
  - a box only counts as pre-ticked if **you didn't tick it yourself**.

The two layers also check each other's work: once NightWatch has measured a cookie banner's buttons, that measurement replaces the guess it made from the banner's wording.

### Honest limits

- NightWatch flags the **tactic**, not whether a claim is true. It cannot tell from a page whether "Only 1 left" is real, so it says the claim is there to rush you, not that it is false.
- A cancellation flow spread across several pages cannot be seen from one page view. The **On record** notes cover some well-documented cases.
- To avoid false alarms it leans towards missing things: a pop-up that appears within two seconds of an unrelated click is treated as one you asked for.
- Pop-ups served inside an iframe can be detected, but the buttons inside them cannot be measured.

---

## Privacy

- No account, no server, no analytics.
- Results for the pages you visit are stored only in the browser's own extension storage, and only the 100 most recent pages are kept.
- The **On record** list ships inside the extension; nothing is looked up online.
- The `<all_urls>` permission exists so NightWatch can read pages you visit. It never sends their content anywhere.

---

## For developers

No build step and no dependencies — plain JavaScript, HTML and CSS on Manifest V3. To work on it, clone the repository and use **Load unpacked** on the repository folder itself.

```
manifest.json
background/service-worker.js   classifies pages and stores results
content/content-script.js      collects page text and watches for changes
content/structure.js           measures pop-ups, buttons and ticked boxes
lib/                           detection logic as pure functions (no browser APIs)
rules/keyword-rules.json       Layer 1 wording rules
rules/structural-rules.json    Layer 2 thresholds and wordlists
rules/known-records.json       cited regulator actions for "On record"
popup/                         the toolbar popup (popup/preview.html is a dev preview)
tests/                         unit tests, test pages and the browser test runner
scripts/package.mjs            builds the release zip
```

Requires Node.js 22 or later.

| Command | What it does |
|---|---|
| `npm test` | Unit tests for the detection logic, colour maths and popup contrast |
| `npm run test:e2e` | Loads the extension into a headless Chromium browser, opens the test pages, clicks like a shopper, and checks what NightWatch stored. Needs Brave, Chrome or Chromium installed (set `NIGHTWATCH_BROWSER` to point at another). Add `-- --verbose` to print the evidence. |
| `npm run package` | Builds `dist/nightwatch-<version>.zip` containing only the files the browser needs |

To check a release before publishing it, unzip the package and run the browser tests against it:

```
NIGHTWATCH_EXTENSION=/path/to/unzipped/folder npm run test:e2e
```

Rules are data, not code: to add a phrasing, adjust a threshold or add a regulator case, edit the JSON in `rules/` — each file's `notes` explain its fields. Entries in `known-records.json` must be legal actions by a regulator, worded as what was alleged and cited with agency, case and date; a test enforces this.

---

## References

- Gray, C. M., et al. (2024). An ontology of dark patterns knowledge — the five-strategy taxonomy used to group detections.
- Mathur, A., et al. (2019). Dark patterns at scale: findings from a crawl of 11K shopping websites.
- Consumer Policy Research Centre (2022). Duped by design — Australian consumer survey cited in the Hidden Costs and Roach Motel explanations.
- Regulator cases cited in the **On record** notes are listed in `rules/known-records.json`.
