import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { FocusTimer } from "../src/index.js";
import { istDateKey } from "../src/time.js";
import { dispatch, handleFocus, handleLaunch, handleUnknown, handleWaitlist } from "../src/commands.js";
import { LAUNCH_TIME } from "../src/definitions.js";
import { promptForDate, threadNameForDate, isCheckinConfigured } from "../src/checkin.js";
import { hexToBytes, verifyDiscordRequest } from "../src/verify.js";
import { createThread, editMessage, isSnowflake, postMessage } from "../src/discord.js";
import { parseTimerState, timeUpMessage, type TimerState } from "../src/timer.js";
import type { Env } from "../src/env.js";

const userId = "123456789012345678";
const channelId = "223456789012345678";
const roleId = "323456789012345678";
const interactionId = "423456789012345678";
const now = 1795433400;
const timer: TimerState = { channelId, starterId: userId, interactionId, minutes: 25, endsAt: now + 1500 };
const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");

async function signed(body: string) {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in keys)) throw new Error("Expected key pair");
  const raw = await crypto.subtle.exportKey("raw", keys.publicKey);
  if (!(raw instanceof ArrayBuffer)) throw new Error("Expected raw key");
  const timestamp = String(now);
  const signature = hex(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body)));
  const headers = { "X-Signature-Timestamp": timestamp, "X-Signature-Ed25519": signature };
  return { key: hex(raw), headers, request: new Request("https://worker.test/interactions", { method: "POST", headers, body }) };
}

function environment(key = "") {
  const start = vi.fn(async () => new Response(null, { status: 204 }));
  const namespace = { idFromName: vi.fn(() => interactionId), get: vi.fn(() => ({ fetch: start })) };
  const env = {
    DISCORD_PUBLIC_KEY: key, DISCORD_BOT_TOKEN: "test-token-not-a-secret", DISCORD_APP_ID: interactionId,
    GUILD_ID: interactionId, SESSION_PINGS_ROLE_ID: roleId, GOALS_CHANNEL_ID: channelId,
    AI_BASE_URL: "https://ai.test/v1", AI_API_KEY: "test-key-not-a-secret",
    FOCUS_TIMERS: namespace, MEMORIES: namespace, USAGE: namespace, SPACES: namespace,
  } as unknown as Env;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  return { env, ctx, pending, start };
}

function stored(initial: TimerState | undefined = timer) {
  let value: TimerState | undefined = initial;
  const storage = {
    get: vi.fn(async () => value),
    put: vi.fn(async (_key: string, next: TimerState) => { value = next; }),
    setAlarm: vi.fn(async () => {}), deleteAlarm: vi.fn(async () => {}),
    delete: vi.fn(async () => { value = undefined; return true; }),
    deleteAll: vi.fn(async () => { value = undefined; }),
  };
  const object = new FocusTimer({ storage } as unknown as DurableObjectState, environment().env);
  return { object, storage };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("commands", () => {
  it.each([25, 50, 90])("starts a %i minute timer with local timestamps and role-only mentions", minutes => {
    const result = handleFocus({ userId, roleId, minutes, now, goal: "Finish chapter" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected timer");
    expect(result.endsAt).toBe(now + minutes * 60);
    expect(result.reply.content).toMatch(/Ends \d{1,2}:\d{2} [AP]M IST/);
    expect(result.reply.content).toContain("left");
    expect(result.reply.allowedMentions).toEqual({ parse: [], roles: [roleId] });
  });
  it.each([0, 30, -25, NaN, 25.5])("rejects duration %s privately", minutes => {
    const result = handleFocus({ userId, roleId, minutes, now });
    expect(result.ok).toBe(false);
    expect(result.reply.ephemeral).toBe(true);
    expect(result.reply.allowedMentions).toEqual({ parse: [] });
  });
  it.each(["", "PASTE_SESSION_PINGS_ROLE_ID"])("does not ping an unconfigured role %s", configured => {
    const result = handleFocus({ userId, roleId: configured, minutes: 25, now });
    expect(result.reply.allowedMentions).toEqual({ parse: [] });
    expect(result.reply.content).not.toContain("<@&");
  });
  it("enforces goal length and omits blank goals", () => {
    expect(handleFocus({ userId, roleId, minutes: 25, now, goal: "x".repeat(201) }).ok).toBe(false);
    expect(handleFocus({ userId, roleId, minutes: 25, now, goal: "x".repeat(200) }).ok).toBe(true);
    expect(handleFocus({ userId, roleId, minutes: 25, now, goal: "  " }).reply.content).not.toContain("Goal:");
  });
  it("keeps user-typed mentions outside the allowlist", () => {
    const result = handleFocus({ userId, roleId, minutes: 25, now, goal: "@everyone <@523456789012345678>" });
    expect(result.reply.allowedMentions).toEqual({ parse: [], roles: [roleId] });
  });
  it("switches countdown at the launch instant", () => {
    expect(handleLaunch({ now: LAUNCH_TIME - 1 }).content).toContain("6:00 PM IST");
    expect(handleLaunch({ now: LAUNCH_TIME }).content).toContain("beta is open");
    expect(LAUNCH_TIME).toBe(Date.UTC(2026, 10, 30, 12, 30) / 1000);
  });
  it("returns personal links and unknown-command replies privately", () => {
    expect(handleWaitlist().ephemeral).toBe(true);
    expect(handleWaitlist().content).toContain("https://docs.hatchh.io");
    expect(handleUnknown("@everyone <@123>").allowedMentions).toEqual({ parse: [] });
    expect(handleUnknown("@everyone <@123>").content).not.toContain("@everyone");
  });
  it("dispatches all commands and missing focus options", () => {
    for (const commandName of ["launch", "waitlist", "unknown"]) {
      expect(dispatch({ commandName, userId, roleId, now }).kind).toBe("reply");
    }
    const result = dispatch({ commandName: "focus", userId, roleId, now, minutes: null });
    expect(result.kind).toBe("focus");
    if (result.kind === "focus") expect(result.result.ok).toBe(false);
  });
});

describe("check-ins", () => {
  it("has seven distinct deterministic weekday prompts", () => {
    const prompts = Array.from({ length: 7 }, (_, index) => promptForDate(`2026-11-${23 + index}`));
    expect(new Set(prompts).size).toBe(7);
    expect(promptForDate("2026-11-23")).toContain("New week");
  });
  it.each(["", "invalid", "2026-02-31", "2026-13-01"])("handles invalid date %s", date => {
    expect(promptForDate(date)).toContain("Daily check-in");
    expect(threadNameForDate(date)).toBe("Check-in");
  });
  it("formats thread names and IST rollover", () => {
    expect(threadNameForDate("2026-11-23")).toBe("Check-in · 23 Nov");
    expect(threadNameForDate("2026-01-05")).toBe("Check-in · 5 Jan");
    expect(istDateKey(Date.UTC(2026, 10, 23, 20))).toBe("2026-11-24");
    expect(isCheckinConfigured("PASTE_GOALS_CHANNEL_ID")).toBe(false);
    expect(isCheckinConfigured(channelId)).toBe(true);
  });
});

describe("signature verification", () => {
  it("verifies a real Ed25519 signature and returns the exact body", async () => {
    const input = await signed('{"type":1}');
    expect(await verifyDiscordRequest(input.request, input.key)).toEqual({ ok: true, body: '{"type":1}' });
  });
  it("rejects tampered bodies and wrong keys", async () => {
    const input = await signed('{"type":1}');
    const wrong = await signed('{}');
    expect(await verifyDiscordRequest(new Request("https://worker.test", { method: "POST", headers: input.headers, body: '{"type":2}' }), input.key)).toEqual({ ok: false, status: 401 });
    expect(await verifyDiscordRequest(input.request, wrong.key)).toEqual({ ok: false, status: 401 });
  });
  it.each(["", "zz", "00"])("rejects malformed public key %s", async key => {
    const input = await signed('{}');
    expect(await verifyDiscordRequest(input.request, key)).toEqual({ ok: false, status: 401 });
  });
  it("rejects missing headers and invalid hex", async () => {
    expect(await verifyDiscordRequest(new Request("https://worker.test"), "")).toEqual({ ok: false, status: 401 });
    expect(hexToBytes("ff00")).toEqual(new Uint8Array([255, 0]));
    expect(hexToBytes("f")).toBeNull();
    expect(hexToBytes("gg")).toBeNull();
  });
});

describe("Discord REST", () => {
  it.each([userId, "1".repeat(17), "1".repeat(20)])("accepts snowflake %s", id => expect(isSnowflake(id)).toBe(true));
  it.each([123, "123", "", ` ${userId}`, `+${userId}`])("rejects invalid snowflake %s", id => expect(isSnowflake(id)).toBe(false));
  it("sends message payload with explicit mentions and token only in headers", async () => {
    const fake = vi.fn(async () => new Response("{}"));
    await postMessage("test-token", channelId, { content: "hi", allowed_mentions: { parse: [] } }, fake);
    expect(fake).toHaveBeenCalledWith(`https://discord.com/api/v10/channels/${channelId}/messages`, expect.objectContaining({ method: "POST", headers: { Authorization: "Bot test-token", "Content-Type": "application/json" }, body: JSON.stringify({ content: "hi", allowed_mentions: { parse: [] } }) }));
  });
  it("rejects invalid ids and missing allowed_mentions before fetching", async () => {
    const fake = vi.fn(async () => new Response("{}"));
    await expect(postMessage("test-token", "invalid", { allowed_mentions: { parse: [] } }, fake)).rejects.toThrow("channelId");
    await expect(postMessage("test-token", channelId, {} as Parameters<typeof postMessage>[2], fake)).rejects.toThrow("allowed_mentions");
    expect(fake).not.toHaveBeenCalled();
  });
  it("surfaces 429 without swallowing or looping", async () => {
    const fake = vi.fn(async () => new Response('{"retry_after":1.5}', { status: 429 }));
    await expect(postMessage("test-token", channelId, { allowed_mentions: { parse: [] } }, fake)).rejects.toThrow(/^discord 429/);
    expect(fake).toHaveBeenCalledTimes(1);
  });
  it("edits in place and opens named threads", async () => {
    const fake = vi.fn(async () => new Response("{}"));
    await editMessage("test-token", channelId, interactionId, { allowed_mentions: { parse: [] } }, fake);
    expect(fake).toHaveBeenLastCalledWith(expect.stringContaining(`/messages/${interactionId}`), expect.objectContaining({ method: "PATCH" }));
    await createThread("test-token", channelId, interactionId, "Check-in", fake);
    expect(fake).toHaveBeenLastCalledWith(expect.stringContaining("/threads"), expect.objectContaining({ body: '{"name":"Check-in"}' }));
    await expect(createThread("test-token", channelId, interactionId, "x".repeat(101), fake)).rejects.toThrow();
  });
});

describe("FocusTimer", () => {
  it("validates stored timer state and bounds", () => {
    expect(parseTimerState(timer, now).ok).toBe(true);
    for (const patch of [{ minutes: 30 }, { channelId: "invalid" }, { endsAt: now + 86401 }, { endsAt: now - 301 }, { goal: "x".repeat(201) }]) {
      expect(parseTimerState({ ...timer, ...patch }, now).ok).toBe(false);
    }
    expect(parseTimerState({ ...timer, endsAt: now - 60 }, now).ok).toBe(true);
    expect(timeUpMessage({ ...timer, goal: "@everyone" }).allowed_mentions).toEqual({ parse: [], users: [userId] });
  });
  it("stores a timer and schedules its alarm", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const { object, storage } = stored(undefined);
    const response = await object.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify(timer) }));
    expect(response.status).toBe(204);
    expect(storage.put).toHaveBeenCalledWith("timer", timer);
    expect(storage.setAlarm).toHaveBeenCalledWith(timer.endsAt * 1000);
  });
  it("posts once and clears personal timer data on success", async () => {
    const fake = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fake);
    const { object, storage } = stored();
    await object.alarm();
    await object.alarm();
    expect(fake).toHaveBeenCalledTimes(1);
    expect(storage.deleteAll).toHaveBeenCalledTimes(1);
  });
  it.each([429, 500, 503])("preserves state for retry on Discord %i", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
    const { object, storage } = stored();
    await expect(object.alarm()).rejects.toThrow();
    expect(storage.deleteAll).not.toHaveBeenCalled();
  });
  it("drops permanent 403 failures and clears data", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    const { object, storage } = stored();
    await object.alarm();
    expect(storage.deleteAll).toHaveBeenCalled();
  });
});

describe("Worker", () => {
  it("exports its configured Durable Object class", () => expect(FocusTimer).toBeTypeOf("function"));
  it("responds to signed PING and rejects unsigned requests", async () => {
    const input = await signed('{"type":1}');
    const { env, ctx } = environment(input.key);
    expect(await (await worker.fetch(input.request, env, ctx)).json()).toEqual({ type: 1 });
    expect((await worker.fetch(new Request("https://worker.test/interactions", { method: "POST" }), env, ctx)).status).toBe(401);
    expect((await worker.fetch(new Request("https://worker.test/"), env, ctx)).status).toBe(404);
  });
  it("starts focus via the Durable Object without a real Discord call", async () => {
    const input = await signed(JSON.stringify({ type: 2, id: interactionId, channel_id: channelId, member: { user: { id: userId } }, data: { name: "focus", options: [{ name: "minutes", value: 25 }] } }));
    const { env, ctx, pending, start } = environment(input.key);
    const response = await worker.fetch(input.request, env, ctx);
    expect((await response.json() as { type: number }).type).toBe(4);
    await Promise.all(pending);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("posts a mention-free prompt then opens its thread", async () => {
    const fake = vi.fn(async () => new Response(JSON.stringify({ id: interactionId })));
    vi.stubGlobal("fetch", fake);
    const { env, ctx } = environment();
    await worker.scheduled({} as ScheduledController, env, ctx);
    expect(fake).toHaveBeenCalledTimes(2);
    const first = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(first[1].body)).allowed_mentions).toEqual({ parse: [] });
  });
  it("skips check-in when the channel is unconfigured", async () => {
    const fake = vi.fn();
    vi.stubGlobal("fetch", fake);
    const { env, ctx } = environment();
    env.GOALS_CHANNEL_ID = "PASTE_GOALS_CHANNEL_ID";
    await worker.scheduled({} as ScheduledController, env, ctx);
    expect(fake).not.toHaveBeenCalled();
  });
});
