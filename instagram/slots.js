// Posting-time math: turn an account's daily slots ("09:00" in its own timezone) into concrete instants.

const SLOT_RE = /^(\d{1,2}):(\d{2})$/;

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function normalizeSlots(slots) {
  if (!Array.isArray(slots)) throw new Error("Slots must be a list of HH:MM times.");
  const clean = slots.map((raw) => {
    const match = String(raw).trim().match(SLOT_RE);
    const [h, m] = match ? [Number(match[1]), Number(match[2])] : [];
    if (!match || h > 23 || m > 59) throw new Error(`"${raw}" isn't a valid time — use 24-hour HH:MM, e.g. 09:00 or 18:30.`);
    return `${String(h).padStart(2, "0")}:${match[2]}`;
  });
  return [...new Set(clean)].sort();
}

function wallClock(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, min: p.minute, s: p.second };
}

/** Minutes timeZone is ahead of UTC at the given instant. */
function offsetMinutes(date, timeZone) {
  const w = wallClock(date, timeZone);
  return Math.round((Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - date.getTime()) / 60000);
}

/** The instant when the wall clock in timeZone reads y-m-d h:min. */
export function zonedTime(y, m, d, h, min, timeZone) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = guess - offsetMinutes(new Date(guess), timeZone) * 60000;
  // A second pass settles days where the offset changes (DST) between the guess and the answer.
  return new Date(guess - offsetMinutes(new Date(first), timeZone) * 60000);
}

/**
 * The earliest slot at or after `from` that is at least minGapMin away from every taken time
 * and doesn't push that local day past dailyLimit. Returns null if nothing fits within horizonDays.
 */
export function nextSlot({ slots, timeZone, taken = [], from = new Date(), minGapMin = 30, dailyLimit = 0, horizonDays = 60 }) {
  const times = normalizeSlots(slots).map((s) => s.split(":").map(Number));
  if (!times.length) return null;
  const today = wallClock(from, timeZone);

  for (let offset = 0; offset < horizonDays; offset++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + offset));
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    const dayStart = zonedTime(y, m, d, 0, 0, timeZone).getTime();
    const dayEnd = zonedTime(y, m, d + 1, 0, 0, timeZone).getTime();
    if (dailyLimit && taken.filter((t) => t >= dayStart && t < dayEnd).length >= dailyLimit) continue;

    for (const [h, min] of times) {
      const at = zonedTime(y, m, d, h, min, timeZone);
      if (at < from) continue;
      if (taken.some((t) => Math.abs(t - at.getTime()) < minGapMin * 60000)) continue;
      return at;
    }
  }
  return null;
}

/** The next `count` open slots, booking each one before looking for the next. */
export function nextSlots({ count = 3, taken = [], ...options }) {
  const booked = [...taken];
  const found = [];
  while (found.length < count) {
    const at = nextSlot({ ...options, taken: booked });
    if (!at) break;
    found.push(at);
    booked.push(at.getTime());
  }
  return found;
}
