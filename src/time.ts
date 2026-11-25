// Times are IST. This is the only place the zone is defined.
//
// IST is UTC+5:30 with no daylight saving, so a fixed offset is exact. Cloudflare's clock is
// UTC; everything here converts from it. Nothing in the bot should hardcode 330 or IST again.

export const IST_OFFSET_MINUTES = 330; // 5 hours 30 minutes
export const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;
export const IST_LABEL = "IST";

// Discord timestamps still render in each person's own zone; this is for copy and for
// working out which IST calendar day an instant falls on.
export function istDateKey(nowMs: number): string {
  const shifted = new Date(nowMs + IST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// The wall-clock hour in IST, 0-23.
export function istHour(nowMs: number): number {
  return new Date(nowMs + IST_OFFSET_MS).getUTCHours();
}

// Builds a unix-seconds instant from an IST wall-clock date and time. Month is 1-12.
export function fromIst(year: number, month1: number, day: number, hour = 0, minute = 0): number {
  return Math.floor((Date.UTC(year, month1 - 1, day, hour, minute) - IST_OFFSET_MS) / 1000);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

// 12-hour clock, the way people in India write it: "6:00 PM". Minutes always show, including
// on the hour. Returns parts so copy can place the time where it reads best.
export function istClock(unixSeconds: number): {
  hour: number;
  minute: number;
  meridiem: "AM" | "PM";
  day: number;
  month: string;
  year: number;
} {
  const shifted = new Date(unixSeconds * 1000 + IST_OFFSET_MS);
  const hour24 = shifted.getUTCHours();
  return {
    hour: hour24 % 12 === 0 ? 12 : hour24 % 12,
    minute: shifted.getUTCMinutes(),
    meridiem: hour24 < 12 ? "AM" : "PM",
    day: shifted.getUTCDate(),
    month: MONTHS[shifted.getUTCMonth()] ?? "Jan",
    year: shifted.getUTCFullYear(),
  };
}

// "10:45 AM IST" — where only the time of day matters.
export function istTimeText(unixSeconds: number): string {
  const parts = istClock(unixSeconds);
  return `${parts.hour}:${String(parts.minute).padStart(2, "0")} ${parts.meridiem} ${IST_LABEL}`;
}

// "30 Nov, 6:00 PM IST" — where the day matters too.
export function istDateTimeText(unixSeconds: number): string {
  const parts = istClock(unixSeconds);
  return `${parts.day} ${parts.month}, ${istTimeText(unixSeconds)}`;
}

// Seconds until `endsAt`, in words: "about 25 minutes left". Rough on purpose.
export function relativeText(endsAt: number, now: number): string {
  const seconds = Math.max(0, endsAt - now);
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 1) return "less than a minute left";
  return `about ${minutes} minutes left`;
}
