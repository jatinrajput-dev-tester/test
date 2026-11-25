// SpaceStore: one Durable Object per owner-space. It holds the space record, its buddies,
// the running timer and the id of the one live status message, and its alarm is what posts
// "time's up".
//
// It is the ONLY holder of a space record. Creation used to live in a second Durable Object
// (SpaceCreator) so "make me a space" would be atomic, but each object has its own storage
// and its own key, so the creator wrote a record the store could never see: the build then
// failed to save the channels it had just made. One object, one record. Atomicity is kept
// because a Durable Object handles one request at a time, so /create cannot race itself.

import {
  addBuddy,
  cancelFocus,
  extendFocus,
  removeBuddy,
  startBreak,
  startFocus,
  type SpaceMember,
  type SpaceState,
} from "./space.js";
import { isSnowflake, editMessage, postMessage } from "./discord.js";
import { statusContent, statusMentions } from "./space.js";
import type { Env } from "./env.js";

const KEY = "space";

// What the Worker needs back from a space call. Sending the whole state (including every
// buddy) on each call keeps the Worker from making a second round trip.
export type SpaceView = {
  ownerId: string;
  spaceName: string;
  categoryId: string | null;
  textChannelId: string | null;
  voiceChannelId: string | null;
  statusMessageId: string | null;
  focus: SpaceState["focus"];
  buddies: SpaceMember[];
  busy: boolean;
  breakUntil: number | null;
};

export type SpaceResult = {
  space?: SpaceView;
  error?: string;
  created?: boolean;
  removed?: string | null;
};

function view(state: SpaceState): SpaceView {
  return {
    ownerId: state.ownerId,
    spaceName: state.spaceName,
    categoryId: state.categoryId,
    textChannelId: state.textChannelId,
    voiceChannelId: state.voiceChannelId,
    statusMessageId: state.statusMessageId,
    focus: state.focus,
    buddies: state.buddies,
    busy: state.busy,
    breakUntil: state.breakUntil,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function saved(state: SpaceState): Response {
  return json({ ok: true, space: view(state) });
}

export class SpaceStore implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("", { status: 405 });
    const path = new URL(request.url).pathname;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Body must be JSON." }, 400);
    }
    const input = body as Record<string, unknown>;
    const ownerId = input["ownerId"];
    if (!isSnowflake(ownerId)) return json({ error: "ownerId must be a snowflake." }, 400);

    const now = Math.floor(Date.now() / 1000);

    // /create and /get must answer even when there is no record yet; everything else needs one.
    if (path === "/create") {
      const stored = await this.read();
      // A second press returns the existing space instead of building a second one.
      if (stored !== null) return json({ created: false, space: view(stored) });

      const spaceName = String(input["spaceName"] ?? "").trim();
      if (spaceName.length === 0) return json({ error: "spaceName is required." }, 400);

      const space: SpaceState = {
        ownerId,
        spaceName: spaceName.slice(0, 60),
        categoryId: null,
        textChannelId: null,
        voiceChannelId: null,
        statusMessageId: null,
        buddies: [],
        focus: null,
        busy: false,
        breakUntil: null,
        updatedAt: now,
      };
      await this.write(space);
      return json({ created: true, space: view(space) });
    }

    const stored = await this.read();

    if (path === "/get") {
      return json({ space: stored === null ? null : view(stored) });
    }

    if (stored === null) return json({ error: "No space yet." }, 404);

    switch (path) {
      case "/channels": {
        const categoryId = input["categoryId"];
        const textChannelId = input["textChannelId"];
        const voiceChannelId = input["voiceChannelId"];
        if (!isSnowflake(categoryId) || !isSnowflake(textChannelId) || !isSnowflake(voiceChannelId)) {
          return json({ error: "Channel ids must be snowflakes." }, 400);
        }
        return this.save({ ...stored, categoryId, textChannelId, voiceChannelId, updatedAt: now });
      }

      case "/statusMessage": {
        const statusMessageId = input["statusMessageId"];
        if (!isSnowflake(statusMessageId)) return json({ error: "statusMessageId must be a snowflake." }, 400);
        return this.save({ ...stored, statusMessageId, updatedAt: now });
      }

      case "/addBuddy": {
        const member = readMember(input["member"]);
        if (member === null) return json({ error: "A valid member is required." }, 400);
        const result = addBuddy(stored, { ...member, addedAt: now });
        if (!result.ok) return json({ error: result.reason }, 400);
        return this.save(result.state);
      }

      case "/removeBuddy": {
        const userId = input["userId"];
        if (!isSnowflake(userId)) return json({ error: "userId must be a snowflake." }, 400);
        const result = removeBuddy(stored, userId);
        await this.write(result.state);
        return json({ ok: true, removed: result.removed?.userId ?? null, space: view(result.state) });
      }

      case "/focus": {
        const result = startFocus(stored, {
          starterId: String(input["starterId"] ?? ""),
          starterName: String(input["starterName"] ?? ""),
          minutes: Number(input["minutes"]),
          ...(typeof input["goal"] === "string" ? { goal: input["goal"] } : {}),
          now,
        });
        if (!result.ok) return json({ error: result.reason }, 400);
        await this.write(result.state);
        await this.state.storage.setAlarm(result.session.endsAt * 1000);
        return json({ ok: true, session: result.session, space: view(result.state) });
      }

      case "/cancelFocus": {
        const result = cancelFocus(stored, String(input["userId"] ?? ""), now);
        if (!result.ok) return json({ error: result.reason }, 400);
        await this.state.storage.deleteAlarm();
        await this.write(result.state);
        return saved(result.state);
      }

      case "/extendFocus": {
        const result = extendFocus(stored, String(input["userId"] ?? ""), Number(input["minutes"]), now);
        if (!result.ok) return json({ error: result.reason }, 400);
        await this.write(result.state);
        await this.state.storage.setAlarm(result.session.endsAt * 1000);
        return json({ ok: true, session: result.session, space: view(result.state) });
      }

      case "/break": {
        const result = startBreak(stored, String(input["userId"] ?? ""), now, Number(input["breakMinutes"] ?? 5));
        if (!result.ok) return json({ error: result.reason }, 400);
        await this.write(result.state);
        await this.state.storage.setAlarm(result.breakUntil * 1000);
        return json({ ok: true, breakUntil: result.breakUntil, space: view(result.state) });
      }

      case "/clear":
        await this.state.storage.deleteAll();
        await this.state.storage.deleteAlarm();
        return json({ ok: true });

      default:
        return new Response("", { status: 404 });
    }
  }

  // A space timer or break ended: post the one "time's up" line, then refresh the single
  // live status message in place. A Discord 5xx throws so Cloudflare retries the alarm.
  async alarm(): Promise<void> {
    const stored = await this.read();
    if (stored === null) return;

    const now = Math.floor(Date.now() / 1000);
    let next = stored;
    let finished: { starterId: string; minutes: number; goal?: string } | null = null;

    if (next.focus !== null && next.focus.endsAt <= now) {
      finished = {
        starterId: next.focus.starterId,
        minutes: next.focus.minutes,
        ...(next.focus.goal !== undefined ? { goal: next.focus.goal } : {}),
      };
      next = { ...next, focus: null, updatedAt: now };
    }
    if (next.busy && next.breakUntil !== null && next.breakUntil <= now) {
      next = { ...next, busy: false, breakUntil: null, updatedAt: now };
    }
    await this.write(next);

    if (finished !== null && next.textChannelId !== null) {
      const goal = finished.goal !== undefined ? ` on "${oneLine(finished.goal)}"` : "";
      const response = await postMessage(this.env.DISCORD_BOT_TOKEN, next.textChannelId, {
        content: `<@${finished.starterId}> Time's up${goal}. ${finished.minutes} minutes done. Nice work.`,
        allowed_mentions: { parse: [], users: [finished.starterId] },
      });
      if (response.status >= 500) throw new Error(`space time's-up failed with ${response.status}`);
    }

    if (next.statusMessageId !== null && next.textChannelId !== null) {
      await editMessage(this.env.DISCORD_BOT_TOKEN, next.textChannelId, next.statusMessageId, {
        content: statusContent(next, now),
        allowed_mentions: statusMentions(next, now),
      });
    }
  }

  private async read(): Promise<SpaceState | null> {
    const stored = await this.state.storage.get<SpaceState>(KEY);
    return stored === undefined ? null : stored;
  }

  private async write(next: SpaceState): Promise<void> {
    await this.state.storage.put(KEY, next);
  }

  private async save(next: SpaceState): Promise<Response> {
    await this.write(next);
    return saved(next);
  }
}

function readMember(value: unknown): Omit<SpaceMember, "addedAt"> | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const userId = record["userId"];
  const displayName = record["displayName"];
  if (!isSnowflake(userId) || typeof displayName !== "string" || displayName.trim().length === 0) return null;
  return { userId, displayName: displayName.trim().slice(0, 80) };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
