// Per-person AI usage limits, matching the Hatch app: 20 answers an hour, 80 a day.
// Pure: the caller passes the current time. The Durable Object that stores counters is
// in src/usage-store.ts; this file only decides whether a request is allowed.

import { istTimeText } from "./time.js";

export const LIMIT_HOUR = 20;
export const LIMIT_DAY = 80;

const HOUR_SECONDS = 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;

export type UsageWindow = {
  // Unix seconds of accepted requests, most recent last. Only the last 24h matter.
  timestamps: number[];
};

export type LimitDecision =
  | { allowed: true; window: UsageWindow; remainingHour: number; remainingDay: number }
  | {
      allowed: false;
      reason: "hour" | "day";
      retryAfterSeconds: number;
      window: UsageWindow;
      remainingHour: number;
      remainingDay: number;
    };

export function emptyWindow(): UsageWindow {
  return { timestamps: [] };
}

export function countInWindow(timestamps: readonly number[], now: number, seconds: number): number {
  const from = now - seconds;
  let count = 0;
  for (const ts of timestamps) if (ts > from) count += 1;
  return count;
}

// Oldest timestamp still inside the window, for working out when a limit frees up.
function oldestInside(timestamps: readonly number[], now: number, seconds: number): number | null {
  const from = now - seconds;
  let oldest: number | null = null;
  for (const ts of timestamps) {
    if (ts > from && (oldest === null || ts < oldest)) oldest = ts;
  }
  return oldest;
}

// Decides without recording. Call recordUse only after the model answered, so a failed
// request does not spend the person's quota.
export function checkLimit(window: UsageWindow, now: number): LimitDecision {
  const pruned = window.timestamps.filter((ts) => ts > now - DAY_SECONDS).sort((a, b) => a - b);
  const hour = countInWindow(pruned, now, HOUR_SECONDS);
  const day = pruned.length;

  if (day >= LIMIT_DAY) {
    const oldest = oldestInside(pruned, now, DAY_SECONDS) ?? now;
    return {
      allowed: false,
      reason: "day",
      retryAfterSeconds: Math.max(1, oldest + DAY_SECONDS - now),
      window: { timestamps: pruned },
      remainingHour: Math.max(0, LIMIT_HOUR - hour),
      remainingDay: 0,
    };
  }

  if (hour >= LIMIT_HOUR) {
    const oldest = oldestInside(pruned, now, HOUR_SECONDS) ?? now;
    return {
      allowed: false,
      reason: "hour",
      retryAfterSeconds: Math.max(1, oldest + HOUR_SECONDS - now),
      window: { timestamps: pruned },
      remainingHour: 0,
      remainingDay: Math.max(0, LIMIT_DAY - day),
    };
  }

  return {
    allowed: true,
    window: { timestamps: pruned },
    remainingHour: LIMIT_HOUR - hour,
    remainingDay: LIMIT_DAY - day,
  };
}

export function recordUse(window: UsageWindow, now: number): UsageWindow {
  return { timestamps: [...window.timestamps, now].filter((ts) => ts > now - DAY_SECONDS) };
}

// Plain language for the person. Says it once, no scolding.
export function limitMessage(reason: "hour" | "day", retryAfterSeconds: number, now: number): string {
  const when = istTimeText(now + retryAfterSeconds);
  return reason === "hour"
    ? `You've reached the hourly limit for Ask Hatch. You can ask again after ${when}.`
    : `You've reached today's limit for Ask Hatch. You can ask again after ${when}.`;
}
