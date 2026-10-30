/**
 * NightWatch content script — Layer 2 (structure) measurement.
 *
 * Loaded before content-script.js, in the same isolated world. Finds what is
 * floating over the page (pop-ups, banners, prompts), measures the buttons in
 * them, and lists the boxes that are ticked. It only measures: whether any of
 * it is a dark pattern is decided by lib/structural.js in the service worker,
 * where it can be unit-tested (brief §9).
 *
 * Two things can only be known here, at the moment they happen:
 *   - whether a pop-up opened just after a click or key press (the shopper
 *     asked for it) or on its own;
 *   - whether a box was ticked by the shopper or by the site.
 * Both are tracked from trusted input events only, so a page cannot fake a
 * click to make its pop-up look requested.
 */

// One global, because content scripts cannot import modules.
// eslint-disable-next-line no-unused-vars
var NightWatchStructure = (() => {
  // Where to look for things floating over the page: a 5×5 grid across the
  // viewport, which lands on centred modals, top banners and corner prompts.
  const GRID_COLUMNS = [0.1, 0.3, 0.5, 0.7, 0.9];
  const GRID_ROWS = [0.06, 0.28, 0.5, 0.72, 0.94];
  const BEHIND_PROBES = [
    [0.5, 0.5],
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ];

  const MODAL_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const CONTROL_SELECTOR =
    'button, a[href], [role="button"], [role="link"], input[type="button"], input[type="submit"], [onclick]';
  const BOX_SELECTOR = 'input[type="checkbox"], [role="checkbox"], [role="switch"]';

  // A pop-up that appears this soon after a click or key press was asked for.
  const INTERACTION_GRACE_MS = 2000;
  // A layer must stay put across two looks this far apart before it is judged.
  const SETTLE_MS = 800;
  const DIMMING_COVERAGE = 0.85;
  const MIN_LAYER_AREA = 3000;

  const MAX_LAYERS = 8;
  const MAX_CONTROLS = 12;
  const MAX_GROUPS = 6;
  const MAX_GROUP_CONTROLS = 6;
  const MAX_BOXES = 25;
  const MAX_TEXT = 300;
  const MAX_LABEL = 120;
  const SHORT_LABEL = 40;
  const MAX_POINTER_SCAN = 400;

  function create({ onInteraction } = {}) {
    let lastInteractionAt = -Infinity;
    const touchedBoxes = new WeakSet();
    const touchedKeys = new Set();
    const layerState = new WeakMap();

    const listen = (type, handler) =>
      addEventListener(type, handler, { capture: true, passive: true });

    listen("pointerdown", (event) => {
      if (!event.isTrusted) return;
      const path = event.composedPath();
      const target = path[0];
      // A click on bare page background or the scrollbar asks for nothing.
      if (target instanceof Element && target !== document.body && target !== document.documentElement) {
        noteInteraction();
      }
      const box = boxFromPath(path);
      if (box) markTouched(box);
    });

    listen("keydown", (event) => {
      if (!event.isTrusted || (event.key !== "Enter" && event.key !== " ")) return;
      const target = event.composedPath()[0];
      if (!(target instanceof Element) || target === document.body || target === document.documentElement) {
        return;
      }
      noteInteraction();
      const box = target.closest(BOX_SELECTOR);
      if (box) markTouched(box);
    });

    listen("change", (event) => {
      const target = event.composedPath()[0];
      if (event.isTrusted && target instanceof Element && target.matches(BOX_SELECTOR)) {
        markTouched(target);
      }
    });

    function noteInteraction() {
      lastInteractionAt = performance.now();
      onInteraction?.();
    }

    function markTouched(box) {
      touchedBoxes.add(box);
      touchedKeys.add(boxKey(box));
    }

    /**
     * Measure the page.
     *   declinePattern — the "no" wording, for finding choices in the page itself
     *   changedSince   — when the page first changed since the last look, which is
     *                    when anything new on screen must have appeared
     */
    function collect({ declinePattern = null, changedSince = 0 } = {}) {
      const now = performance.now();
      const styleOf = memoStyles();
      const viewport = { width: innerWidth, height: innerHeight };
      const prompted = lastInteractionAt >= changedSince - INTERACTION_GRACE_MS;

      const layers = findLayers(viewport, styleOf);
      const overlays = [];
      let pendingConfirm = false;

      for (const layer of layers) {
        let state = layerState.get(layer);
        if (!state) {
          state = { firstSeenAt: now, unprompted: !prompted, sightings: 0 };
          layerState.set(layer, state);
        }
        state.sightings += 1;
        // A toast that flashes past, or a dialog caught mid-animation, is never judged.
        if (state.sightings < 2 || now - state.firstSeenAt < SETTLE_MS) {
          pendingConfirm = true;
          continue;
        }
        overlays.push(describeLayer(layer, state, viewport, styleOf));
      }

      return {
        structure: {
          viewport,
          overlays,
          groups: findInlineChoices(layers, declinePattern, styleOf),
          checkboxes: findTickedBoxes(),
        },
        pendingConfirm,
      };
    }

    function findTickedBoxes() {
      const boxes = [];
      for (const box of document.querySelectorAll(BOX_SELECTOR)) {
        if (boxes.length >= MAX_BOXES) break;
        const checked =
          box instanceof HTMLInputElement ? box.checked : box.getAttribute("aria-checked") === "true";
        if (!checked || !boxIsShown(box)) continue;
        const label = boxLabel(box);
        if (!label) continue;
        boxes.push({
          label,
          checked: true,
          // Sites re-render checkboxes, so also remember them by name and label.
          touched: touchedBoxes.has(box) || touchedKeys.has(boxKey(box, label)),
        });
      }
      return boxes;
    }

    return { collect };
  }

  // -------------------------------------------------------------------------
  // Floating layers

  function findLayers(viewport, styleOf) {
    const behindCache = new Map();
    const considered = new Set();
    const found = new Set();
    const consider = (start) => {
      if (considered.has(start)) return;
      considered.add(start);
      const layer = floatingLayer(start, viewport, styleOf, behindCache);
      if (layer) found.add(layer);
    };

    // Every element under each grid point, not just the topmost: pop-ups stack,
    // and a prompt covered by a later interstitial is still a pop-up.
    for (const fy of GRID_ROWS) {
      for (const fx of GRID_COLUMNS) {
        for (const hit of deepElementsFromPoint(fx * viewport.width, fy * viewport.height)) {
          consider(hit);
        }
      }
    }
    for (const element of document.querySelectorAll(MODAL_SELECTOR)) {
      if (isShown(element)) consider(element);
    }

    const visible = [...found].filter(
      (layer) => isShown(layer) && onScreenArea(layer.getBoundingClientRect(), viewport) >= MIN_LAYER_AREA,
    );
    // A dialog inside a full-screen mask is one pop-up, not two.
    return visible
      .filter((layer) => !visible.some((other) => other !== layer && composedContains(other, layer)))
      .slice(0, MAX_LAYERS);
  }

  /**
   * The pop-up a point on screen belongs to: its outermost fixed-position
   * ancestor that has page content behind it. Needing content behind is what
   * tells a pop-up from an app shell — a site that renders its whole page in
   * one fixed container, with nothing underneath — while still finding a modal
   * opened *inside* such a shell.
   */
  function floatingLayer(start, viewport, styleOf, behindCache) {
    const candidates = [];
    for (let node = start; node instanceof Element; node = composedParent(node)) {
      if (node === document.body || node === document.documentElement) break;
      const style = styleOf(node);
      const floats =
        style.position === "fixed" ||
        (style.position === "absolute" && (isModalElement(node) || dimsPage(node, style, viewport)));
      if (floats) candidates.push(node);
    }

    for (const candidate of candidates.reverse()) {
      let behind = behindCache.get(candidate);
      if (behind === undefined) {
        behind = hasContentBehind(candidate);
        behindCache.set(candidate, behind);
      }
      if (behind) return candidate;
    }
    return null;
  }

  function hasContentBehind(layer) {
    const rect = layer.getBoundingClientRect();
    const ancestors = new Set();
    for (let node = layer; node; node = composedParent(node)) ancestors.add(node);

    for (const [fx, fy] of BEHIND_PROBES) {
      const x = clamp(rect.left + rect.width * fx, 0, innerWidth - 1);
      const y = clamp(rect.top + rect.height * fy, 0, innerHeight - 1);
      for (const element of document.elementsFromPoint(x, y)) {
        if (ancestors.has(element) || composedContains(layer, element)) continue;
        return true;
      }
    }
    return false;
  }

  function describeLayer(layer, state, viewport, styleOf) {
    const rect = layer.getBoundingClientRect();
    // Fixed when first reported, so the evidence for one pop-up reads the same on every look.
    state.dims ??=
      dimsPage(layer, styleOf(layer), viewport) ||
      // The dimming is often a child of the pop-up's container rather than the container itself.
      [...layer.children].some((child) => dimsPage(child, styleOf(child), viewport));
    return {
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      z: parseInt(styleOf(layer).zIndex, 10) || 0,
      dims: state.dims,
      modal: isModalElement(layer) || Boolean(layer.querySelector(MODAL_SELECTOR)),
      unprompted: state.unprompted,
      text: clean(layer.innerText).slice(0, MAX_TEXT),
      hasImage: Boolean(layer.querySelector("img, picture, video, canvas")),
      hasFrame: layer.tagName === "IFRAME" || Boolean(layer.querySelector("iframe")),
      controls: findControls(layer, styleOf)
        .slice(0, MAX_CONTROLS)
        .map((control) => measureControl(control, styleOf)),
    };
  }

  /** Does this element dim or blur the whole page behind it? */
  function dimsPage(element, style, viewport) {
    try {
      if (element.matches("dialog") && element.matches(":modal")) {
        return alphaOf(getComputedStyle(element, "::backdrop").backgroundColor) > 0.05;
      }
    } catch {
      // :modal unsupported — fall through to the geometry check.
    }
    const area = onScreenArea(element.getBoundingClientRect(), viewport);
    if (area < DIMMING_COVERAGE * viewport.width * viewport.height) return false;
    if (style.backdropFilter && style.backdropFilter !== "none") return true;
    const alpha = alphaOf(style.backgroundColor);
    return alpha > 0.05 && alpha < 0.98;
  }

  function isModalElement(element) {
    return element.matches(MODAL_SELECTOR) || element.tagName === "DIALOG";
  }

  // -------------------------------------------------------------------------
  // Controls

  function findControls(layer, styleOf) {
    const labels = new Map();
    const labelFor = (element) => {
      if (!labels.has(element)) labels.set(element, labelOf(element));
      return labels.get(element);
    };

    const semantic = [...layer.querySelectorAll(CONTROL_SELECTOR)];
    const semanticSet = new Set(semantic);
    const clickable = [];

    // Plenty of sites build buttons from <div>s with a pointer cursor and a
    // click handler. Take the element where the pointer cursor *starts*, not
    // every child that inherits it.
    const all = layer.querySelectorAll("*");
    if (all.length <= MAX_POINTER_SCAN) {
      for (const element of all) {
        if (semanticSet.has(element) || styleOf(element).cursor !== "pointer") continue;
        const parent = element.parentElement;
        if (parent && styleOf(parent).cursor === "pointer") continue;
        if (element.querySelector(CONTROL_SELECTOR)) continue;
        const label = labelFor(element);
        if (label && label.length <= SHORT_LABEL) clickable.push(element);
      }
    }

    const visible = [...semantic, ...clickable].filter((element) => isShown(element) && hasBox(element));
    return visible.filter((element) => {
      const holdsOthers = visible.some((other) => other !== element && element.contains(other));
      // A clickable card holding real buttons is a container, not a choice.
      if (holdsOthers && labelFor(element).length > SHORT_LABEL) return false;
      // An <a> wrapping a <button> is one control, not two: keep the outer one.
      return !visible.some(
        (other) => other !== element && other.contains(element) && labelFor(other).length <= SHORT_LABEL,
      );
    });
  }

  /** Raw computed styles; lib/structural.js turns these into prominence. */
  function measureControl(control, styleOf) {
    const rect = control.getBoundingClientRect();
    const textStyle = styleOf(textCarrier(control) ?? control);
    const painted = paintCarrier(control, rect, styleOf);
    const paint = styleOf(painted);
    return {
      text: labelOf(control),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      fontSize: textStyle.fontSize,
      fontWeight: textStyle.fontWeight,
      color: textStyle.color,
      fill: { color: paint.backgroundColor, image: paint.backgroundImage },
      behind: backgroundChain(composedParent(painted), styleOf),
      border: {
        width: paint.borderTopWidth,
        style: paint.borderTopStyle,
        color: paint.borderTopColor,
      },
      opacity: effectiveOpacity(control, styleOf),
    };
  }

  /** The element whose background makes this control look like a button. */
  function paintCarrier(control, rect, styleOf) {
    if (isPainted(styleOf(control))) return control;

    // <a class="link"><span class="btn">Shop now</span></a>: the paint is on a child.
    let node = control;
    for (let depth = 0; depth < 2; depth++) {
      const children = [...node.children].filter(hasBox);
      if (children.length !== 1) break;
      const child = children[0];
      const childRect = child.getBoundingClientRect();
      if (childRect.width * childRect.height < 0.6 * rect.width * rect.height) break;
      if (isPainted(styleOf(child))) return child;
      node = child;
    }

    // <div class="btn"><button class="reset">…</button></div>: the paint is on a hugging parent.
    const parent = control.parentElement;
    if (parent) {
      const parentRect = parent.getBoundingClientRect();
      const hugs =
        Math.abs(parentRect.width - rect.width) <= 6 && Math.abs(parentRect.height - rect.height) <= 6;
      if (hugs && isPainted(styleOf(parent))) return parent;
    }
    return control;
  }

  /** Backgrounds from the nearest ancestor outward, stopping at the first opaque one. */
  function backgroundChain(start, styleOf) {
    const chain = [];
    for (let node = start; node instanceof Element && chain.length < 12; node = composedParent(node)) {
      const style = styleOf(node);
      chain.push({ color: style.backgroundColor, image: style.backgroundImage });
      if (style.backgroundImage !== "none" || alphaOf(style.backgroundColor) >= 0.98) break;
    }
    return chain;
  }

  function effectiveOpacity(element, styleOf) {
    let opacity = 1;
    for (let node = element; node instanceof Element; node = composedParent(node)) {
      opacity *= parseFloat(styleOf(node).opacity) || 0;
      if (opacity === 0) break;
    }
    return Number(opacity.toFixed(3));
  }

  function textCarrier(control) {
    const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue.trim()) return node.parentElement;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Choices in the page itself (not in a pop-up)

  function findInlineChoices(layers, declinePattern, styleOf) {
    if (!declinePattern) return [];
    const groups = [];
    const seen = new Set();

    for (const element of document.querySelectorAll(CONTROL_SELECTOR)) {
      if (groups.length >= MAX_GROUPS) break;
      // textContent is cheap; only the few matches get measured.
      const quick = clean(element.textContent);
      if (!quick || quick.length > 60 || !declinePattern.test(quick)) continue;
      if (layers.some((layer) => composedContains(layer, element))) continue; // judged with its pop-up
      if (!isShown(element) || !hasBox(element)) continue;

      const container = choiceContainer(element);
      if (!container || seen.has(container)) continue;
      seen.add(container);

      const controls = [...container.querySelectorAll(CONTROL_SELECTOR)]
        .filter((control) => isShown(control) && hasBox(control))
        .slice(0, MAX_GROUP_CONTROLS);
      groups.push({
        text: clean(container.innerText).slice(0, MAX_TEXT),
        controls: controls.map((control) => measureControl(control, styleOf)),
      });
    }
    return groups;
  }

  /** The nearest ancestor holding this "no" with its "yes", and little else. */
  function choiceContainer(element) {
    let node = element.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const count = node.querySelectorAll(CONTROL_SELECTOR).length;
      if (count > MAX_GROUP_CONTROLS) return null;
      if (count >= 2) return node;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Checkboxes

  function boxFromPath(path) {
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      if (node.matches(BOX_SELECTOR)) return node;
      if (node.tagName === "LABEL") return node.control ?? null;
    }
    return null;
  }

  function boxIsShown(box) {
    if (isShown(box) && hasBox(box)) return true;
    // Custom checkboxes hide the real input and draw their own; judge by the label.
    if ([...(box.labels ?? [])].some((label) => isShown(label) && hasBox(label))) return true;
    const parent = box.parentElement;
    return Boolean(parent && isShown(parent) && hasBox(parent));
  }

  function boxLabel(box) {
    const parts = [];
    for (const label of box.labels ?? []) parts.push(label.innerText);
    parts.push(box.getAttribute("aria-label") ?? "");
    for (const id of (box.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)) {
      parts.push(document.getElementById(id)?.innerText ?? "");
    }
    let label = clean(parts.join(" "));
    if (!label && !(box instanceof HTMLInputElement)) label = clean(box.innerText);
    if (!label) {
      const nearby = clean(box.closest("label, li, p, div")?.innerText);
      if (nearby.length <= 200) label = nearby;
    }
    return label.slice(0, 160);
  }

  function boxKey(box, label = boxLabel(box)) {
    return `${box.id || box.getAttribute("name") || ""}|${label.slice(0, 60)}`;
  }

  // -------------------------------------------------------------------------
  // DOM helpers

  function labelOf(element) {
    const text = element instanceof HTMLInputElement ? element.value : element.innerText;
    const label =
      clean(text) || clean(element.getAttribute("aria-label")) || clean(element.getAttribute("title"));
    return label.slice(0, MAX_LABEL);
  }

  /** Everything under a point, top to bottom, including inside open shadow roots. */
  function deepElementsFromPoint(x, y) {
    const stack = [];
    for (const element of document.elementsFromPoint(x, y)) {
      if (element === document.body || element === document.documentElement) continue;
      if (element.shadowRoot) {
        for (const inner of element.shadowRoot.elementsFromPoint(x, y)) {
          if (inner !== element && !stack.includes(inner)) stack.push(inner);
        }
      }
      stack.push(element);
    }
    return stack;
  }

  function composedParent(node) {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode?.();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function composedContains(outer, inner) {
    for (let node = inner; node; node = composedParent(node)) {
      if (node === outer) return true;
    }
    return false;
  }

  function isShown(element) {
    if (typeof element.checkVisibility === "function") {
      return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  }

  function hasBox(element) {
    const rect = element.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1;
  }

  function isPainted(style) {
    return alphaOf(style.backgroundColor) > 0.05 || style.backgroundImage !== "none";
  }

  /** Alpha of a computed colour; just enough parsing to tell clear from solid. */
  function alphaOf(color) {
    if (!color || color === "transparent") return 0;
    const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
    if (slash) return slash[2] ? parseFloat(slash[1]) / 100 : parseFloat(slash[1]);
    const legacy = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/.exec(color);
    return legacy ? parseFloat(legacy[1]) : 1;
  }

  function onScreenArea(rect, viewport) {
    const width = Math.max(0, Math.min(rect.right, viewport.width) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0));
    return width * height;
  }

  function memoStyles() {
    const cache = new Map();
    return (element) => {
      let style = cache.get(element);
      if (!style) {
        style = getComputedStyle(element);
        cache.set(element, style);
      }
      return style;
    };
  }

  function clean(text) {
    return String(text ?? "")
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  return { create };
})();
