// Pure daily check-in: prompt and thread name. No clock, no network.
// The date key (the IST calendar day, YYYY-MM-DD) is passed in by the caller.

export const CHECKIN_HOUR_IST = 9;

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function monthAbbr(monthIndex0: number): string {
  if (!Number.isInteger(monthIndex0)) return "";
  return MONTH_ABBR[monthIndex0] ?? "";
}

type DateParts = { year: number; month1: number; day: number };

// Parse YYYY-MM-DD strictly. Returns null for anything malformed or impossible.
function parseDateKey(dateKey: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (match === null) return null;
  const year = Number(match[1]);
  const month1 = Number(match[2]);
  const day = Number(match[3]);
  if (month1 < 1 || month1 > 12 || day < 1 || day > 31) return null;
  // Reject impossible days (e.g. 2026-02-31) by round-tripping through UTC.
  const utc = new Date(Date.UTC(year, month1 - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month1 - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month1, day };
}

// 0 = Sunday ... 6 = Saturday, derived arithmetically from the date key.
function weekdayForDateKey(dateKey: string): number | null {
  const parts = parseDateKey(dateKey);
  if (parts === null) return null;
  return new Date(
    Date.UTC(parts.year, parts.month1 - 1, parts.day),
  ).getUTCDay();
}

// The server runs one goal per week, checked in on daily (copy doc, #goals).
// Each prompt invites a daily check-in against that goal rather than a new one.
const WEEKDAY_PROMPTS: readonly string[] = [
  // Sunday
  "How's your goal for the week going? One line on where things stand is enough.",
  // Monday
  "New week. What's one thing you'll move forward on your goal today?",
  // Tuesday
  "What's one small step on your goal today? Share it here.",
  // Wednesday
  "Midweek check-in: where is your goal right now?",
  // Thursday
  "One thing you can move forward on your goal today?",
  // Friday
  "Friday: how did your goal for the week go?",
  // Saturday
  "Quiet check-in: what's one thing you did for your goal this week?",
];

const FALLBACK_PROMPT =
  "Daily check-in: how's your goal for the week going?";

export function promptForDate(dateKey: string): string {
  const weekday = weekdayForDateKey(dateKey);
  if (weekday === null) return FALLBACK_PROMPT;
  return WEEKDAY_PROMPTS[weekday] ?? FALLBACK_PROMPT;
}

export function threadNameForDate(dateKey: string): string {
  const parts = parseDateKey(dateKey);
  if (parts === null) return "Check-in";
  const month = monthAbbr(parts.month1 - 1);
  const base = month.length > 0 ? `Check-in · ${parts.day} ${month}` : "Check-in";
  // Discord thread names are 1-100 characters; the base is always short, but clip.
  return base.slice(0, 100);
}

export function isCheckinConfigured(channelId: string): boolean {
  const value = channelId.trim();
  return value.length > 0 && !value.startsWith("PASTE_");
}
