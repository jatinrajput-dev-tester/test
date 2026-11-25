// FocusTimer: one Durable Object per `/focus`, named by the Discord interaction ID.
// It stores what the alarm needs, schedules the alarm for the end time, and posts
// "time's up" in the same channel (or thread) when it fires.
//
// Storage holds one key, "timer", and nothing else. It is deleted as soon as the
// timer fires or is cancelled, so a person's data lives only for the life of a
// timer (AGENTS.md section 2).

import { FOCUS_MINUTES, GOAL_MAX_LENGTH } from "./definitions.js";
import { isSnowflake, postMessage, type DiscordMessage } from "./discord.js";
import type { Env } from "./env.js";

export type TimerState = {
  channelId: string;
  interactionId: string;
  starterId: string;
  minutes: number;
  goal?: string;
  endsAt: number; // unix seconds
  threadId?: string;
};

export type TimerStateCheck =
  | { ok: true; state: TimerState }
  | { ok: false; reason: string };

const STORAGE_KEY = "timer";
const DAY_SECONDS = 24 * 60 * 60;
// A start request may land a little after the caller computed endsAt, so a few
// minutes in the past is fine. Anything further back means the value is wrong.
const PAST_TOLERANCE_SECONDS = 5 * 60;

// Pure validation, kept free of the clock so tests can pass `nowSeconds` directly.
export function parseTimerState(input: unknown, nowSeconds: number): TimerStateCheck {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "Body must be a JSON object." };
  }
  const record = input as Record<string, unknown>;

  const channelId = record["channelId"];
  if (!isSnowflake(channelId)) {
    return { ok: false, reason: "channelId must be a Discord snowflake." };
  }

  const interactionId = record["interactionId"];
  if (!isSnowflake(interactionId)) {
    return { ok: false, reason: "interactionId must be a Discord snowflake." };
  }

  const starterId = record["starterId"];
  if (!isSnowflake(starterId)) {
    return { ok: false, reason: "starterId must be a Discord snowflake." };
  }

  const minutes = record["minutes"];
  if (typeof minutes !== "number" || !(FOCUS_MINUTES as readonly number[]).includes(minutes)) {
    return { ok: false, reason: `minutes must be one of ${FOCUS_MINUTES.join(", ")}.` };
  }

  const endsAt = record["endsAt"];
  if (typeof endsAt !== "number" || !Number.isSafeInteger(endsAt)) {
    return { ok: false, reason: "endsAt must be a whole number of unix seconds." };
  }
  if (endsAt > nowSeconds + DAY_SECONDS) {
    return { ok: false, reason: "endsAt is more than a day away." };
  }
  if (endsAt < nowSeconds - PAST_TOLERANCE_SECONDS) {
    return { ok: false, reason: "endsAt is in the past." };
  }

  let goal: string | undefined;
  const rawGoal = record["goal"];
  if (rawGoal !== undefined) {
    if (typeof rawGoal !== "string") {
      return { ok: false, reason: "goal must be a string." };
    }
    const trimmed = rawGoal.trim();
    if (trimmed.length > GOAL_MAX_LENGTH) {
      return { ok: false, reason: `goal must be at most ${GOAL_MAX_LENGTH} characters.` };
    }
    if (trimmed.length > 0) goal = trimmed;
  }

  let threadId: string | undefined;
  const rawThreadId = record["threadId"];
  if (rawThreadId !== undefined) {
    if (!isSnowflake(rawThreadId)) {
      return { ok: false, reason: "threadId must be a Discord snowflake." };
    }
    threadId = rawThreadId;
  }

  const state: TimerState = { channelId, interactionId, starterId, minutes, endsAt };
  if (goal !== undefined) state.goal = goal;
  if (threadId !== undefined) state.threadId = threadId;

  return { ok: true, state };
}

// Collapse user-typed goals to one clean line so they cannot break up the message.
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// The one message the timer ever sends. Mentions only the starter; allowed_mentions
// without a `parse` list means @everyone/@here/role text in a goal stays inert.
export function timeUpMessage(state: TimerState): DiscordMessage {
  const content =
    state.goal !== undefined
      ? `<@${state.starterId}> Time's up on "${oneLine(state.goal)}". ${state.minutes} minutes done. Nice work.`
      : `<@${state.starterId}> Time's up. ${state.minutes} minutes of focus done. Nice work.`;

  return {
    content,
    allowed_mentions: { parse: [], users: [state.starterId] },
  };
}

function badRequest(reason: string): Response {
  return new Response(reason, {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

// Best-effort read of Discord's error body. Only the message and code are logged;
// the body is never echoed wholesale.
async function discordErrorDetail(res: Response): Promise<string> {
  try {
    const data: unknown = await res.json();
    if (typeof data === "object" && data !== null) {
      const record = data as Record<string, unknown>;
      const message = typeof record["message"] === "string" ? record["message"] : undefined;
      const code = typeof record["code"] === "number" ? record["code"] : undefined;
      if (message !== undefined) {
        return code !== undefined ? `${message} (code ${code})` : message;
      }
    }
  } catch {
    // Body was not JSON; nothing useful to log.
  }
  return "";
}

// Best-effort read of retry_after for the thrown 429 message. We do not sleep here:
// Cloudflare schedules the retry from the thrown error.
async function rateLimitDetail(res: Response): Promise<string> {
  try {
    const data: unknown = await res.json();
    if (typeof data === "object" && data !== null) {
      const retryAfter = (data as Record<string, unknown>)["retry_after"];
      if (typeof retryAfter === "number") {
        return `${retryAfter}s`;
      }
    }
  } catch {
    // No JSON body; the status code alone is still enough to act on.
  }
  return "unknown";
}

export class FocusTimer implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "POST" },
      });
    }

    const path = new URL(request.url).pathname;
    if (path === "/start") return this.start(request);
    if (path === "/cancel") return this.cancel();
    return new Response("Not found", { status: 404 });
  }

  private async start(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return badRequest("Body must be JSON.");
    }

    const check = parseTimerState(body, Math.floor(Date.now() / 1000));
    if (!check.ok) return badRequest(check.reason);

    await this.state.storage.put(STORAGE_KEY, check.state);
    // One instance per interaction, so a repeated /start only reschedules: setAlarm
    // replaces any pending alarm rather than adding a second one, and put()
    // overwrites the stored state.
    await this.state.storage.setAlarm(check.state.endsAt * 1000);

    return noContent();
  }

  private async cancel(): Promise<Response> {
    await this.state.storage.delete(STORAGE_KEY);
    await this.state.storage.deleteAlarm();
    return noContent();
  }

  async alarm(): Promise<void> {
    const state = await this.state.storage.get<TimerState>(STORAGE_KEY);
    if (state === undefined) {
      // Cancelled, or the alarm already fired. Nothing to do.
      return;
    }

    const targetId = state.threadId ?? state.channelId;

    // A thrown fetch (network failure) propagates on purpose: Cloudflare retries it.
    const res = await postMessage(this.env.DISCORD_BOT_TOKEN, targetId, timeUpMessage(state));

    if (res.status >= 500) {
      // Discord had a problem, not us. Throw so the alarm is retried.
      throw new Error(`Discord returned ${res.status} for the focus timer; retrying.`);
    }

    if (res.ok) {
      await this.clearStorage();
      return;
    }

    // Any other 4xx (bad channel, missing permissions, deleted thread). Retrying
    // will not help, so log a short line and drop the timer.
    const detail = await discordErrorDetail(res);
    console.error(
      `focus timer: Discord rejected the time's-up message (${res.status}${detail ? `: ${detail}` : ""}); dropping.`,
    );
    await this.clearStorage();
  }

  private async clearStorage(): Promise<void> {
    try {
      await this.state.storage.deleteAll();
    } catch (err) {
      // The message was already posted. A cleanup failure must not turn into a
      // retried alarm that posts a second time, so log it and move on.
      console.error(
        "focus timer: failed to clear storage after posting.",
        err instanceof Error ? err.message : "unknown error",
      );
    }
  }
}
