// On-screen text as an ASS subtitle file (rendered by libass inside ffmpeg): animated word slams,
// the hook title, and word-by-word captions for dialogue.
import { TEXT_STYLES } from "./looks.js";

const assTime = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

/** RRGGBB → ASS &HAABBGGRR */
const assColor = (hex, alpha = 0) => {
  const h = String(hex).replace(/^#/, "").padStart(6, "0").slice(0, 6);
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
};

const clean = (s) => String(s ?? "").replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();

function wrap(text, maxChars) {
  const lines = [];
  let cur = "";
  for (const word of text.split(" ")) {
    if (cur && (cur + " " + word).length > maxChars) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  return lines;
}

function styleLine(name, s, { scale, accent, size }) {
  const outlineColor = s.outlineColor === "accent" ? accent : s.outlineColor;
  const fields = [
    name, s.font, Math.round(size * scale), assColor(s.color), assColor(accent), assColor(outlineColor), assColor("000000", 0x70),
    s.bold ? -1 : 0, 0, 0, 0, 100, 100, s.spacing, 0, s.box ? 3 : 1, Math.round(s.outline * scale), Math.round(s.shadow * scale), 5, 40, 40, 0, 1,
  ];
  return `Style: ${fields.join(",")}`;
}

function animation(anim, ms) {
  const outFade = Math.min(160, Math.round(ms * 0.2));
  switch (anim) {
    case "slam":
      return `\\fscx165\\fscy165\\alpha&HFF&\\t(0,90,\\fscx100\\fscy100\\alpha&H00&)\\t(90,160,\\fscx104\\fscy104)\\t(160,240,\\fscx100\\fscy100)\\fad(0,${outFade})`;
    case "rise":
      return `\\fad(110,${outFade})`;
    case "flicker":
      return `\\alpha&HFF&\\t(0,50,\\alpha&H00&)\\t(50,100,\\alpha&H90&)\\t(100,150,\\alpha&H00&)\\t(150,200,\\alpha&H60&)\\t(200,260,\\alpha&H00&)\\fad(0,${outFade})`;
    default:
      return `\\fad(220,${Math.max(outFade, 200)})`;
  }
}

/**
 * @param texts    [{ start, end, text, y (0–1 from top), size? (1 = style default) }]
 * @param captions [{ start, end, words: [{ s, e, text }] }]
 */
export function buildAss({ width, height, textStyle = "slam", accent = "FFE600", texts = [], captions = [] }) {
  const style = TEXT_STYLES[textStyle] || TEXT_STYLES.slam;
  const scale = width / 1080;
  const maxChars = Math.max(8, Math.round(((width * 0.86) / (style.size * scale * 0.5)) * (style.font === "Impact" ? 1.05 : 0.9)));

  const events = [];
  for (const item of texts) {
    const text = clean(style.upper ? String(item.text).toUpperCase() : item.text);
    if (!text || item.end - item.start < 0.15) continue;
    const lines = wrap(text, maxChars);
    const shrink = lines.length > 2 ? 0.78 : lines.length === 2 ? 0.9 : 1;
    const x = Math.round(width / 2);
    const y = Math.round(height * (item.y ?? 0.5));
    const ms = Math.round((item.end - item.start) * 1000);
    const size = `\\fs${Math.round(style.size * scale * shrink * (item.size || 1))}`;
    const pos = style.anim === "rise" ? `\\move(${x},${y + Math.round(46 * scale)},${x},${y},0,200)` : `\\pos(${x},${y})`;
    const body = lines.join("\\N");
    if (style.glow) {
      events.push(`Dialogue: 0,${assTime(item.start)},${assTime(item.end)},Text,,0,0,0,,{\\an5${pos}${size}\\blur9\\bord${Math.round(10 * scale)}${animation(style.anim, ms)}}${body}`);
    }
    events.push(`Dialogue: 1,${assTime(item.start)},${assTime(item.end)},Text,,0,0,0,,{\\an5${pos}${size}\\blur0.6${animation(style.anim, ms)}}${body}`);
  }

  // Captions: one event per spoken word, with that word lit in the accent color.
  const capY = Math.round(height * 0.74);
  const accentTag = `\\c${assColor(accent)}`;
  for (const group of captions) {
    const words = group.words.map((w) => ({ ...w, text: clean(w.text).toUpperCase() })).filter((w) => w.text);
    words.forEach((w, i) => {
      const start = i === 0 ? group.start : w.s;
      const end = i + 1 < words.length ? words[i + 1].s : group.end;
      if (end - start < 0.02) return;
      const body = words.map((x, j) => (j === i ? `{${accentTag}}${x.text}{\\c${assColor("FFFFFF")}}` : x.text)).join(" ");
      const pop = i === 0 ? "\\fscx88\\fscy88\\t(0,80,\\fscx100\\fscy100)" : "";
      events.push(`Dialogue: 2,${assTime(start)},${assTime(end)},Caption,,0,0,0,,{\\an5\\pos(${Math.round(width / 2)},${capY})${pop}}${body}`);
    });
  }

  // The bold flag on "Avenir Next Condensed" picks the italic cut through CoreText; the Heavy face by name doesn't.
  const captionStyle = { font: "Avenir Next Condensed Heavy", color: "FFFFFF", outlineColor: "000000", bold: 0, spacing: 0, outline: 6, shadow: 3 };
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLine("Text", style, { scale, accent, size: style.size })}
${styleLine("Caption", captionStyle, { scale, accent, size: 88 })}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}
