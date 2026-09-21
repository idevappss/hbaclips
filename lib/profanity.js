// Curse words and slurs never make it into a clip: not in what's said, not in a hook, not in a title or caption.
// The creator runs a premium brand, so a sentence with one in it is cut out whole rather than bleeped.

// Whole words and their common spellings/extensions ("fuckin'", "shitty", "motherfucker", "a$$").
const PATTERN =
  /\b(?:(?:mother)?f+u+c+k+\w*|f+u+k+\w*|fk|fck\w*|s+h+i+t+\w*|bullshit\w*|horseshit|b+i+t+c+h+\w*|a+s+s+h+o+l+e+s?|dumbass\w*|jackass\w*|badass\w*|smartass\w*|a+s+s+|a\$\$|damn\w*|goddamn\w*|dammit|d+i+c+k+s?|dickhead\w*|pussy|pussies|cunt\w*|bastards?|cocks?|cocksucker\w*|piss(?:ed|ing)?|sluts?|whores?|n+i+g+(?:g+)?(?:a|er)s?|fag\w*|retard\w*|wtf|stfu)\b/i;

// "ass" and "af" also turn up inside ordinary phrases a transcript can mangle; these are the only safe spellings.
const HARMLESS = /^(?:assess\w*|assist\w*|asset\w*|assum\w*|associat\w*|assign\w*|passion\w*|class\w*|glass\w*|mass\w*|bass|pass\w*|cockpit|scunthorpe|dickens|after|afternoon)$/i;

const clean = (word) => String(word || "").toLowerCase().replace(/[^a-z$']/g, "");

/** Is this single word a curse word or slur? */
export function isProfane(word) {
  const w = clean(word).replace(/'/g, "");
  if (!w || HARMLESS.test(w)) return false;
  return PATTERN.test(w);
}

/** Does this text contain one anywhere? */
export function hasProfanity(text) {
  return String(text || "")
    .split(/\s+/)
    .some(isProfane);
}

export const PROFANITY_PATTERN = PATTERN;
