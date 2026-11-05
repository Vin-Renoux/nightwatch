export const WHITE = [255, 255, 255, 1];
export const BLACK = [0, 0, 0, 1];

const COLOR_FUNCTION = /^([a-z-]+)\((.*)\)$/;
const COLOR_TOKEN = /(?:rgba?|oklch|oklab|color)\([^()]*\)/gi;

export function parseCssColor(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text === "transparent") return [0, 0, 0, 0];
  if (text === "white") return [...WHITE];
  if (text === "black") return [...BLACK];
  if (text.startsWith("#")) return fromHex(text);

  const match = COLOR_FUNCTION.exec(text);
  if (!match) return null;
  const [, name, body] = match;
  const { values, alpha } = splitArguments(body);

  switch (name) {
    case "rgb":
    case "rgba":
      return fromRgb(values, alpha);
    case "color":
      return fromColorFunction(values, alpha);
    case "oklab":
      return fromOklab(values, alpha);
    case "oklch":
      return fromOklch(values, alpha);
    default:
      return null;
  }
}

export function parseBackgroundImage(value) {
  if (typeof value !== "string" || value === "none") return { colors: [], image: false };
  const colors = (value.match(COLOR_TOKEN) ?? []).map(parseCssColor).filter(Boolean);
  return { colors, image: /url\(/i.test(value) };
}

export function averageColor(colors) {
  if (!colors?.length) return null;
  const sum = [0, 0, 0, 0];
  for (const color of colors) for (let i = 0; i < 4; i++) sum[i] += color[i];
  return sum.map((total) => total / colors.length);
}

export function composite(top, bottom) {
  const alpha = clamp(top[3] ?? 1, 0, 1);
  return [0, 1, 2].map((i) => top[i] * alpha + bottom[i] * (1 - alpha)).concat(1);
}

export function mix(a, b, amount) {
  const t = clamp(amount, 0, 1);
  return [0, 1, 2].map((i) => a[i] * t + b[i] * (1 - t)).concat(1);
}

export function relativeLuminance([r, g, b]) {
  const [R, G, B] = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function chroma([r, g, b]) {
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

// -------------------------------------------------

function splitArguments(body) {
  const [main, slashAlpha] = body.split("/");
  const values = main.split(/[\s,]+/).filter(Boolean);
  const alpha = slashAlpha === undefined ? null : parseAlpha(slashAlpha.trim());
  return { values, alpha };
}

function fromHex(text) {
  let hex = text.slice(1);
  if (!/^([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(hex)) return null;
  if (hex.length <= 4) hex = [...hex].map((digit) => digit + digit).join("");
  const bytes = hex.match(/../g).map((pair) => parseInt(pair, 16));
  return [bytes[0], bytes[1], bytes[2], bytes.length === 4 ? bytes[3] / 255 : 1];
}

function fromRgb(values, alpha) {
  if (values.length < 3) return null;
  const channels = values.slice(0, 3).map((value) =>
    value.endsWith("%") ? parseFloat(value) * 2.55 : parseFloat(value),
  );
  if (channels.some(Number.isNaN)) return null;
  const a = alpha ?? (values[3] === undefined ? 1 : parseAlpha(values[3]));
  return [...channels.map((c) => clamp(c, 0, 255)), a];
}

function fromColorFunction(values, alpha) {
  const [space, ...rest] = values;
  const channels = rest.slice(0, 3).map(parseFloat);
  if (channels.length < 3 || channels.some(Number.isNaN)) return null;
  const a = alpha ?? 1;

  if (space === "srgb" || space === "display-p3") return [...channels.map(toByte), a];
  if (space === "srgb-linear") return [...channels.map((c) => toByte(gammaEncode(c))), a];
  return null;
}

function fromOklab(values, alpha) {
  const [L, a, b] = values.slice(0, 3).map((value, index) => parseComponent(value, index === 0 ? 1 : 0.4));
  if ([L, a, b].some(Number.isNaN)) return null;
  return oklabToRgb(L, a, b, alpha ?? 1);
}

function fromOklch(values, alpha) {
  const L = parseComponent(values[0], 1);
  const C = parseComponent(values[1], 0.4);
  const H = values[2] === "none" ? 0 : parseFloat(values[2]);
  if ([L, C, H].some(Number.isNaN)) return null;
  const radians = (H * Math.PI) / 180;
  return oklabToRgb(L, C * Math.cos(radians), C * Math.sin(radians), alpha ?? 1);
}

function oklabToRgb(L, a, b, alpha) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return [...linear.map((c) => toByte(gammaEncode(c))), alpha];
}

function gammaEncode(c) {
  const x = clamp(c, 0, 1);
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

function parseComponent(value, percentScale) {
  if (value === undefined || value === "none") return 0;
  return value.endsWith("%") ? (parseFloat(value) / 100) * percentScale : parseFloat(value);
}

function parseAlpha(value) {
  if (value === undefined || value === "none") return 1;
  const number = value.endsWith("%") ? parseFloat(value) / 100 : parseFloat(value);
  return Number.isNaN(number) ? 1 : clamp(number, 0, 1);
}

function toByte(unit) {
  return clamp(Math.round(unit * 255), 0, 255);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
