// Money reads like money in captions: "$1", "$20k", "$100k/month", "$1M". The speech model writes amounts every
// which way — "20 K,", "20 Kper", "a hundred Ka month", "twenty thousand dollars" — so caption words are rewritten
// here, merging the words an amount was spoken across into one caption word (timed from its first word to its last).

const UNITS = { zero: 0, one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// Things counted, not paid: "100 patients", "20k followers" never get a dollar sign.
const COUNTED = /^(people|persons?|patients?|doctors?|clients?|customers?|members?|followers?|views?|subscribers?|likes?|comments?|users?|leads?|visits?|visitors?|calls?|times?|years?|months?|weeks?|days?|hours?|minutes?|seconds?|steps?|reps?|sessions?|miles?|pounds?|lbs|percent|%|x|feet|inches|employees?|staff|locations?|offices?|clinics?|practices?|videos?|posts?|reels?|episodes?|kids?|students?)$/;
const PERIOD = { month: "month", year: "year", week: "week", day: "day", hour: "hr", annually: "year", monthly: "month" };

const bare = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9$.']/g, "");
const trailing = (t) => String(t || "").match(/[,;:.!?]+$/)?.[0] || "";

/** Split words the model glued to a "k": "Kper" → "k" "per", "Ka" → "k" "a", "20K," stays whole. */
function unglue(words) {
  const out = [];
  for (const w of words) {
    // A corrected phrase can arrive as one caption word ("K a month"): look at its words one by one.
    const parts = String(w.text).trim().split(/\s+/);
    const step = (w.e - w.s) / parts.length;
    parts.forEach((text, n) => {
      const piece = { ...w, text, s: w.s + step * n, e: w.s + step * (n + 1) };
      const m = text.match(/^(\$?\d[\d,.]*)?([kK])(per|a|an|weeks?|months?|years?)([,;:.!?]*)$/);
      if (!m) return out.push(piece);
      const mid = piece.s + (piece.e - piece.s) / 2;
      out.push({ ...piece, text: `${m[1] || ""}k`, e: mid });
      // "Kweeks" is "k a week": the unit becomes a period.
      const unit = m[3].replace(/s$/, "");
      if (["week", "month", "year"].includes(unit)) {
        out.push({ ...piece, text: "a", s: mid, e: mid });
        out.push({ ...piece, text: `${unit}${m[4]}`, s: mid });
      } else out.push({ ...piece, text: `${m[3]}${m[4]}`, s: mid });
    });
  }
  return out;
}

/** A spoken number starting at words[i]: { value, used } or null. Handles digits ("20", "1.5", "$20") and words. */
function readNumber(words, i) {
  const t = bare(words[i]?.text).replace(/^\$/, "").replace(/,/g, "");
  if (/^\d+(\.\d+)?$/.test(t)) return { value: Number(t), used: 1, digits: true };
  let value = 0;
  let used = 0;
  let seen = false;
  for (let k = i; k < words.length && k < i + 5; k++) {
    const w = bare(words[k].text);
    const article = w === "a" || w === "an";
    if (article && !seen && ["hundred", "thousand", "million", "grand"].includes(bare(words[k + 1]?.text))) {
      value += 1;
      seen = true;
      used = k - i + 1;
    } else if (!article && w in UNITS) {
      value += UNITS[w];
      seen = true;
      used = k - i + 1;
    } else if (w in TENS) {
      value += TENS[w];
      seen = true;
      used = k - i + 1;
    } else if (w === "hundred" && seen) {
      value *= 100;
      used = k - i + 1;
    } else break;
  }
  return seen ? { value, used } : null;
}

// Whole amounts get thousands separators ("$12,000"); k and M amounts stay short ("$20k", "$1.5M").
const fmt = (n, scale) => (scale ? String(Math.round(n * 100) / 100) : Math.round(n * 100) / 100 >= 1000 ? (Math.round(n * 100) / 100).toLocaleString("en-US") : String(Math.round(n * 100) / 100));

/** A title or line of copy with its money written the creator's way ("Walk Out With $20K" → "... $20k"). */
export function formatMoneyText(text) {
  const words = String(text || "").split(/\s+/).filter(Boolean).map((t, i) => ({ text: t, s: i, e: i + 1 }));
  return words.length ? formatMoney(words).map((w) => w.text).join(" ") : String(text || "");
}

/**
 * Caption words [{ text, s, e }] with every money amount written the creator's way.
 */
export function formatMoney(input) {
  const words = unglue(input || []);
  const out = [];
  for (let i = 0; i < words.length; ) {
    const raw = String(words[i].text);
    // Already written as money or with a k/M suffix: "$20K", "700k", "1.5M".
    const glued = raw.match(/^(\$)?(\d[\d,]*(?:\.\d+)?)([kKmM])(\/[a-zA-Z]+)?([,;:.!?]*)$/);
    let num = null;
    let used = 0;
    let scale = "";
    let dollar = false;
    if (glued) {
      num = Number(glued[2].replace(/,/g, ""));
      scale = glued[3].toLowerCase() === "m" ? "M" : "k";
      dollar = Boolean(glued[1]);
      used = 1;
    } else {
      const read = readNumber(words, i);
      if (read) {
        num = read.value;
        used = read.used;
        dollar = raw.startsWith("$");
        const unit = bare(words[i + used]?.text);
        if (unit === "k") {
          scale = "k";
          used += 1;
        } else if (unit === "thousand" || unit === "grand") {
          scale = "k";
          used += 1;
          if (unit === "grand") dollar = true;
        } else if (unit === "million" || unit === "m") {
          scale = "M";
          used += 1;
        } else if (!read.digits && !dollar && !["dollar", "dollars", "bucks"].includes(unit)) {
          num = null; // a spoken number that isn't money ("two things") stays as said
        }
      } else if (bare(raw) === "million" && ["dollar", "dollars"].includes(bare(words[i + 1]?.text))) {
        num = 1;
        scale = "M";
        used = 1;
      }
    }
    if (num === null || !used) {
      out.push(words[i]);
      i += 1;
      continue;
    }
    let end = i + used; // first word after the amount
    const next = bare(words[end]?.text);
    if (["dollar", "dollars", "bucks"].includes(next)) {
      dollar = true;
      end += 1;
    }
    const counted = COUNTED.test(bare(words[end]?.text));
    // A bare number with no money words ("300 people", "45 minutes") isn't money.
    if (!dollar && (!scale || counted)) {
      out.push(words[i]);
      i += 1;
      continue;
    }
    // "a month" / "per month" / "a year" after an amount becomes "/month".
    let period = "";
    const per = bare(words[end]?.text);
    const unit = bare(words[end + 1]?.text).replace(/[.']+$/, "").replace(/s$/, "");
    if ((per === "a" || per === "per" || per === "an") && PERIOD[unit]) {
      period = `/${PERIOD[unit]}`;
      end += 2;
    } else if (per === "monthly" || per === "annually") {
      period = `/${PERIOD[per]}`;
      end += 1;
    }
    // A period already written onto the amount ("$100K/Month") keeps its place, lowercased.
    if (!period && glued?.[4]) period = glued[4].toLowerCase();
    const last = words[end - 1];
    out.push({ ...words[i], text: `$${fmt(num, scale)}${scale}${period}${trailing(last.text)}`, e: last.e });
    i = end;
  }
  return out;
}
