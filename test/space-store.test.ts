// These run the real Durable Object code against a fake storage, so the routes the Worker
// calls are proven to exist and behave. The interaction tests fake the whole namespace,
// which is exactly how a missing route went unnoticed.
import { describe, expect, it, vi } from "vitest";
import { SpaceStore } from "../src/space-store.js";
import type { Env } from "../src/env.js";

const owner = "123456789012345678";
const buddy = "223456789012345678";
const stranger = "923456789012345678";
const textChannel = "423456789012345678";
const voiceChannel = "433456789012345678";
const category = "111111111111111111";
const statusMessage = "523456789012345678";

class FakeStorage {
  private map = new Map<string, unknown>();
  private seeded: Promise<void> = Promise.resolve();
  public alarmAt: number | null = null;

  seed(key: string, value: unknown): void {
    this.seeded = this.put(key, value);
  }

  async get<T>(key: string): Promise<T | undefined> {
    await this.seeded;
    return structuredClone(this.map.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async deleteAll(): Promise<void> {
    this.map.clear();
  }
  async setAlarm(when: number): Promise<void> {
    this.alarmAt = when;
  }
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

function makeEnv(fetchImpl: typeof fetch = fetch): Env {
  return {
    DISCORD_BOT_TOKEN: "test-token-not-a-secret",
    AI_BASE_URL: "https://ai.test/v1",
    AI_API_KEY: "k",
    DISCORD_PUBLIC_KEY: "",
    DISCORD_APP_ID: "",
    GUILD_ID: "",
    SESSION_PINGS_ROLE_ID: "",
    GOALS_CHANNEL_ID: "",
    FOCUS_TIMERS: {} as DurableObjectNamespace,
    MEMORIES: {} as DurableObjectNamespace,
    USAGE: {} as DurableObjectNamespace,
    SPACES: {} as DurableObjectNamespace,
    _fetch: fetchImpl,
  } as unknown as Env;
}

function freshSpace(overrides: Record<string, unknown> = {}) {
  return {
    ownerId: owner,
    spaceName: "Fishy's friends",
    categoryId: category,
    textChannelId: textChannel,
    voiceChannelId: voiceChannel,
    statusMessageId: statusMessage,
    buddies: [],
    focus: null,
    busy: false,
    breakUntil: null,
    updatedAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

type Caller = (path: string, body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;

function callerFor(object: SpaceStore): Caller {
  return async (path, body) => {
    const response = await object.fetch(new Request(`https://do${path}`, { method: "POST", body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
}

function store(seed?: Record<string, unknown>, env = makeEnv()) {
  const storage = new FakeStorage();
  if (seed !== undefined) storage.seed("space", freshSpace(seed));
  const object = new SpaceStore({ storage } as unknown as DurableObjectState, env);
  return { object, storage, call: callerFor(object) };
}

// Creation lives on the same object as everything else, so a fresh creator is just an
// empty store: no record yet.
function creator() {
  return store();
}

describe("space creation", () => {
  it("creates once and returns the same space on a second press", async () => {
    const { call } = creator();
    const first = await call("/create", { ownerId: owner, spaceName: "Fishy's friends" });
    expect(first.body.created).toBe(true);

    const second = await call("/create", { ownerId: owner, spaceName: "Something else" });
    expect(second.body.created).toBe(false);
    // The second press must not rename or rebuild the first space.
    expect((second.body.space as { spaceName: string }).spaceName).toBe("Fishy's friends");
  });

  it("reports no space before one is made", async () => {
    const result = await creator().call("/get", { ownerId: owner });
    expect(result.body.space).toBeNull();
  });

  it("rejects a missing owner", async () => {
    expect((await creator().call("/create", { spaceName: "x" })).status).toBe(400);
  });

  it("hours the channels it just created on the same record as /create made", async () => {
    // The regression: creation and the rest of the space lived in two Durable Objects, so
    // /channels wrote to a storage /get never read and the build failed to save.
    const { call } = creator();
    const made = await call("/create", { ownerId: owner, spaceName: "Fishy's friends" });
    expect(made.body.created).toBe(true);

    const saved = await call("/channels", {
      ownerId: owner,
      categoryId: category,
      textChannelId: textChannel,
      voiceChannelId: voiceChannel,
    });
    expect(saved.status).toBe(200);

    const fetched = await call("/get", { ownerId: owner });
    const space = fetched.body.space as { textChannelId: string; voiceChannelId: string; categoryId: string };
    expect(space.textChannelId).toBe(textChannel);
    expect(space.voiceChannelId).toBe(voiceChannel);
    expect(space.categoryId).toBe(category);
  });
});

describe("space store routes", () => {
  it("answers /get with null when no space exists, and routes every path the Worker calls", async () => {
    // /get must succeed with null, not 404: that null is how the Worker knows to offer Create.
    const missing = await store().call("/get", { ownerId: owner });
    expect(missing.status).toBe(200);
    expect(missing.body.space).toBeNull();

    // Paths that need a record still refuse when there is none.
    expect((await store().call("/channels", { ownerId: owner })).status).toBe(404);

    const { call } = store({});
        for (const path of [
      "/get",
      "/channels",
      "/statusMessage",
      "/addBuddy",
      "/removeBuddy",
      "/focus",
      "/cancelFocus",
      "/extendFocus",
      "/break",
      "/clear",
    ]) {
      const result = await call(path, { ownerId: owner });
      expect(result.status, `${path} should be routed`).not.toBe(404);
    }
  });

  it("saves the channels and the status message id", async () => {
    const { call } = store({});
        const saved = await call("/channels", { ownerId: owner, categoryId: category, textChannelId: textChannel, voiceChannelId: voiceChannel });
    expect(saved.body.ok).toBe(true);
    const withStatus = await call("/statusMessage", { ownerId: owner, statusMessageId: statusMessage });
    const space = withStatus.body.space as { textChannelId: string; statusMessageId: string };
    expect(space.textChannelId).toBe(textChannel);
    expect(space.statusMessageId).toBe(statusMessage);
  });

  it("refuses channel ids that are not snowflakes", async () => {
    const { call } = store({});
        const result = await call("/channels", { ownerId: owner, categoryId: "abc", textChannelId: textChannel, voiceChannelId: voiceChannel });
    expect(result.status).toBe(400);
  });

  it("adds a buddy and reports the updated people", async () => {
    const { call } = store({});
        const added = await call("/addBuddy", { ownerId: owner, member: { userId: buddy, displayName: "Ria" } });
    expect(added.body.ok).toBe(true);
    expect((added.body.space as { buddies: Array<{ userId: string }> }).buddies.map((b) => b.userId)).toEqual([buddy]);
  });

  it("refuses the owner as their own buddy", async () => {
    const { call } = store({});
        expect((await call("/addBuddy", { ownerId: owner, member: { userId: owner, displayName: "Me" } })).status).toBe(400);
  });

  it("starts a timer, arms the alarm, and clears it on cancel", async () => {
    const { call, storage } = store({});
        const started = await call("/focus", { ownerId: owner, starterId: owner, starterName: "Fishy", minutes: 25 });
    expect(started.body.ok).toBe(true);
    const endsAt = (started.body.session as { endsAt: number }).endsAt;
    expect(storage.alarmAt).toBe(endsAt * 1000);

    expect((await call("/cancelFocus", { ownerId: owner, userId: owner })).body.ok).toBe(true);
    expect(storage.alarmAt).toBeNull();
  });

  it("refuses to cancel someone else's timer", async () => {
    const { call } = store({});
        await call("/addBuddy", { ownerId: owner, member: { userId: buddy, displayName: "Ria" } });
    await call("/focus", { ownerId: owner, starterId: buddy, starterName: "Ria", minutes: 25 });
    const result = await call("/cancelFocus", { ownerId: owner, userId: stranger });
    expect(result.status).toBe(400);
    expect(result.body.error as string).toMatch(/only the person who started/i);
  });

  it("extends a timer and moves the alarm with it", async () => {
    const { call, storage } = store({});
        const started = await call("/focus", { ownerId: owner, starterId: owner, starterName: "F", minutes: 25 });
    const first = (started.body.session as { endsAt: number }).endsAt;
    const extended = await call("/extendFocus", { ownerId: owner, userId: owner, minutes: 10 });
    expect((extended.body.session as { endsAt: number }).endsAt).toBe(first + 600);
    expect(storage.alarmAt).toBe((first + 600) * 1000);
  });

  it("refuses an extend amount Discord does not offer", async () => {
    const { call } = store({});
        await call("/focus", { ownerId: owner, starterId: owner, starterName: "F", minutes: 25 });
    expect((await call("/extendFocus", { ownerId: owner, userId: owner, minutes: 7 })).status).toBe(400);
  });

  it("starts a break and arms the alarm for the end of it", async () => {
    const { call, storage } = store({});
        const result = await call("/break", { ownerId: owner, userId: owner });
    expect(result.body.ok).toBe(true);
    expect(storage.alarmAt).toBe((result.body.breakUntil as number) * 1000);
  });
});

describe("the alarm", () => {
  const ended = () => ({ endsAt: Math.floor(Date.now() / 1000) - 1, starterId: owner, starterName: "Fishy", minutes: 25, startedAt: 0 });

  it("posts the time's-up line, then edits the one live status message", async () => {
    const discord = vi.fn(async () => new Response(JSON.stringify({ id: statusMessage }), { status: 200 }));
    vi.stubGlobal("fetch", discord);
    const { object, storage } = store({ focus: ended() });
    
    await object.alarm();

    // One POST for the time's-up message, one PATCH for the status edit. Never two posts.
    expect(discord.mock.calls.length).toBe(2);
    const methods = discord.mock.calls.map((call: unknown[]) => (call[1] as RequestInit).method);
    expect(methods).toEqual(["POST", "PATCH"]);

    const state = (await storage.get<{ focus: unknown }>("space")) as { focus: unknown };
    expect(state.focus).toBeNull();
  });

  it("throws on a Discord 5xx so Cloudflare retries", async () => {
    const discord = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", discord);
    const { object } = store({ focus: ended() });
        await expect(object.alarm()).rejects.toThrow();
  });

  it("does nothing when the space is gone", async () => {
    await expect(store().object.alarm()).resolves.toBeUndefined();
  });
});
