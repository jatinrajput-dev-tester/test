// The bot runs on Cloudflare's UTC clock but everything people see is IST. These tests pin
// the zone conversion against known instants so a change cannot silently shift a time.
import { describe, expect, it } from "vitest";
import { fromIst, istDateKey, istHour, IST_OFFSET_MINUTES } from "../src/time.js";
import { LAUNCH_TIME } from "../src/definitions.js";

const ist = (ms: number) =>
  new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "full", timeStyle: "short" });

describe("IST offset", () => {
  it("is UTC+5:30", () => {
    expect(IST_OFFSET_MINUTES).toBe(330);
  });
});

describe("launch time", () => {
  it("is 30 November 2026 at 6:00 PM IST", () => {
    expect(ist(LAUNCH_TIME * 1000)).toContain("30 November 2026");
    expect(ist(LAUNCH_TIME * 1000)).toContain("6:00 pm");
  });
  it("is 12:30 UTC", () => {
    expect(new Date(LAUNCH_TIME * 1000).toISOString()).toBe("2026-11-30T12:30:00.000Z");
  });
});

describe("daily check-in", () => {
  it("fires at 09:00 IST on the cron instant", () => {
    // wrangler.jsonc: "30 3 * * *" = 03:30 UTC.
    const cron = Date.UTC(2026, 10, 23, 3, 30, 0);
    expect(istHour(cron)).toBe(9);
    expect(ist(cron)).toContain("9:00 am");
  });
  it("uses the IST calendar day, not the UTC one", () => {
    expect(istDateKey(Date.UTC(2026, 10, 23, 3, 30))).toBe("2026-11-23");
    // 20:00 UTC is already 01:30 the next day in IST.
    expect(istDateKey(Date.UTC(2026, 10, 23, 20, 0))).toBe("2026-11-24");
    // Just before the IST day rolls over at 18:30 UTC.
    expect(istDateKey(Date.UTC(2026, 10, 23, 18, 29))).toBe("2026-11-23");
    expect(istDateKey(Date.UTC(2026, 10, 23, 18, 30))).toBe("2026-11-24");
  });
  it("names the right weekday for an IST morning", () => {
    // 2026-11-23 is a Monday; at 09:00 IST on Monday the date key must be Monday's.
    expect(new Date(Date.UTC(2026, 10, 23, 3, 30)).getUTCDay()).toBe(1);
    expect(istDateKey(Date.UTC(2026, 10, 23, 3, 30))).toBe("2026-11-23");
  });
});

describe("building an IST instant", () => {
  it("round-trips through the date key", () => {
    const at = fromIst(2026, 11, 30, 18, 0);
    expect(istDateKey(at * 1000)).toBe("2026-11-30");
    expect(istHour(at * 1000)).toBe(18);
  });
  it("handles midnight IST, which is the previous day in UTC", () => {
    const midnight = fromIst(2026, 12, 1, 0, 0);
    expect(istDateKey(midnight * 1000)).toBe("2026-12-01");
    expect(new Date(midnight * 1000).toISOString()).toBe("2026-11-30T18:30:00.000Z");
  });
  it("matches a half-hour offset for minutes", () => {
    const at = fromIst(2026, 3, 1, 10, 45);
    expect(istHour(at * 1000)).toBe(10);
    expect(new Date(at * 1000).toISOString()).toBe("2026-03-01T05:15:00.000Z");
  });
});
