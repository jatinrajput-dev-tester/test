import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";

const owner = "123456789012345678";
const buddy = "223456789012345678";
const stranger = "323456789012345678";
const channelId = "423456789012345678";
const messageId = "523456789012345678";
const now = 1_800_000_000;

async function keys() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("expected keypair");
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(raw instanceof ArrayBuffer)) throw new Error("expected raw");
  const hex = (buf: ArrayBuffer) =>
    Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  return { privateKey: pair.privateKey, publicKeyHex: hex(raw), hex };
}

async function signedRequest(body: unknown) {
  const { privateKey, publicKeyHex, hex } = await keys();
  const raw = JSON.stringify(body);
  const timestamp = String(now);
  const signature = hex(
    await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(timestamp + raw)),
  );
  const request = new Request("https://worker.test/interactions", {
    method: "POST",
    headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp },
    body: raw,
  });
  return { request, publicKeyHex };
}

type DoCall = { name: string; path: string; body: Record<string, unknown> };

// A stand-in for the Durable Object namespace. Each named space keeps its own route table.
function fakeEnv(
  routes: Record<string, (call: DoCall) => unknown> = {},
): { env: Env; calls: DoCall[]; pending: Promise<unknown>[] } {
  const calls: DoCall[] = [];
  const pending: Promise<unknown>[] = [];
  // idFromName returns the full key (e.g. "usage:<id>"). Routes may key on the full name
  // plus path, on the path alone, or on a namespace prefix plus path.
  const pick = (name: string, path: string) => {
    const candidates = [`${name}:${path}`, path];
    const prefix = name.includes(":") ? name.slice(0, name.indexOf(":")) : null;
    if (prefix !== null) candidates.push(`${prefix}*:${path}`);
    for (const key of candidates) if (routes[key] !== undefined) return routes[key];
    return undefined;
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        const body = init?.body !== undefined ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        const call = { name, path, body };
        calls.push(call);
        const handler = pick(name, path);
        const result = handler === undefined ? { ok: true } : handler(call);
        if (result === undefined) return new Response(null, { status: 404 });
        return new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json" },
        });
      },
    }),
  };
  const env = {
    DISCORD_PUBLIC_KEY: "",
    DISCORD_BOT_TOKEN: "test-token-not-a-secret",
    DISCORD_APP_ID: "623456789012345678",
    GUILD_ID: "923456789012345678",
    SESSION_PINGS_ROLE_ID: "723456789012345678",
    GOALS_CHANNEL_ID: "823456789012345678",
    AI_BASE_URL: "https://ai.test/v1",
    AI_API_KEY: "test-key-not-a-secret",
    FOCUS_TIMERS: namespace,
    MEMORIES: namespace,
    USAGE: namespace,
    SPACES: namespace,
  } as unknown as Env;
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
  Object.defineProperty(env, "_ctx", { value: ctx });
  return { env, calls, pending };
}

function command(name: string, options: unknown[] = [], user = owner) {
  return {
    type: 2,
    id: clientId(),
    // Discord addresses a follow-up webhook by token, never by the interaction id.
    token: "interaction-token",
    channel_id: channelId,
    guild_id: "923456789012345678",
    member: { user: { id: user, username: "fishy", global_name: "Fishy" } },
    data: { name, options },
  };
}

function component(customId: string, user = owner) {
  return {
    type: 3,
    id: clientId(),
    token: "interaction-token",
    channel_id: channelId,
    guild_id: "923456789012345678",
    member: { user: { id: user, username: "fishy", global_name: "Fishy" } },
    data: { custom_id: customId },
  };
}

let counter = 0;
function clientId(): string {
  counter += 1;
  return String(900000000000000000n + BigInt(counter));
}

// vi.fn() infers an empty argument tuple in some positions; this keeps call inspection typed.
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type MockFetcher = ReturnType<typeof vi.fn<Fetcher>>;

function lastDiscordBody(discord: MockFetcher): string {
  const call = discord.mock.calls.at(-1);
  if (call === undefined) return "";
  return String(call[1]?.body ?? "");
}

async function invoke(env: Env, body: unknown) {
  const { request, publicKeyHex } = await signedRequest(body);
  env.DISCORD_PUBLIC_KEY = publicKeyHex;
  const ctx = (env as unknown as { _ctx: ExecutionContext })._ctx;
  return worker.fetch(request, env, ctx);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("routing", () => {
  it("answers a PING with a PONG", async () => {
    const { env } = fakeEnv();
    const response = await invoke(env, { type: 1 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });

  it("rejects unsigned requests and unknown paths", async () => {
    const { env } = fakeEnv();
    const ctx = (env as unknown as { _ctx: ExecutionContext })._ctx;
    const unsigned = new Request("https://worker.test/interactions", { method: "POST" });
    expect((await worker.fetch(unsigned, env, ctx)).status).toBe(401);
    const wrongPath = new Request("https://worker.test/", { method: "POST" });
    expect((await worker.fetch(wrongPath, env, ctx)).status).toBe(404);
  });

  it("answers a known command with an ephemeral-safe message", async () => {
    const { env } = fakeEnv();
    const response = await invoke(env, command("waitlist"));
    const payload = (await response.json()) as { type: number; data: { flags?: number; allowed_mentions: unknown } };
    expect(payload.type).toBe(4);
    expect(payload.data.flags).toBe(64);
    expect(payload.data.allowed_mentions).toEqual({ parse: [] });
  });

  it("answers an unknown command privately without echoing a mention", async () => {
    const { env } = fakeEnv();
    const response = await invoke(env, command("@everyone"));
    const payload = (await response.json()) as { data: { content: string; flags: number } };
    expect(payload.data.flags).toBe(64);
    expect(payload.data.content).not.toContain("@everyone");
  });
});

describe("/hatch space", () => {
  it("shows a preview card and creates nothing yet", async () => {
    const { env, calls } = fakeEnv({ "space:123456789012345678:/get": () => ({ space: null }) });
    const response = await invoke(env, command("hatch", [{ name: "space", options: [] }]));
    const payload = (await response.json()) as { data: { content: string; components: Array<{ components: Array<{ custom_id: string }> }> } };
    expect(payload.data.content).toContain("Fishy's friends");
    expect(payload.data.components[0]?.components.map((b) => b.custom_id)).toEqual(["space:create", "space:cancel"]);
    // Nothing was created by merely previewing.
    expect(calls.every((call) => call.path !== "/create")).toBe(true);
  });

  it("does not offer a second space when one already exists", async () => {
    const { env } = fakeEnv({
      "space:123456789012345678:/get": () => ({ space: { ownerId: owner, textChannelId: channelId } }),
    });
    const response = await invoke(env, command("hatch", [{ name: "space", options: [] }]));
    const payload = (await response.json()) as { data: { content: string } };
    expect(payload.data.content).toMatch(/already have a space/i);
  });

  it("builds the category, both rooms and the live status message on Create", async () => {
    let created = 0;
    const discord = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/channels")) {
        created += 1;
        const isCategory = String(init?.body ?? "").includes('"type":4');
        const id = isCategory ? "111111111111111111" : String(310000000000000000n + BigInt(created));
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: messageId }), { status: 200 });
    });
    vi.stubGlobal("fetch", discord);

    const { env, calls, pending } = fakeEnv({
      "space:123456789012345678:/create": () => ({ created: true, space: { ownerId: owner, textChannelId: null, voiceChannelId: null, statusMessageId: null, buddies: [], focus: null, busy: false, breakUntil: null, categoryId: null } }),
      "space:123456789012345678:/channels": () => ({ space: { ownerId: owner, categoryId: "111111111111111111", textChannelId: channelId, voiceChannelId: "433456789012345678", statusMessageId: null, buddies: [], focus: null, busy: false, breakUntil: null } }),
      "space:123456789012345678:/statusMessage": () => ({ ok: true }),
    });

    const response = await invoke(env, component("space:create"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });

    await Promise.all(pending);
    // Category + two rooms created, then the status message posted.
    expect(discord.mock.calls.filter(([url]) => String(url).endsWith("/channels")).length).toBe(3);
    const statusMessage = calls.find((call) => call.path === "/statusMessage");
    expect(statusMessage?.body.statusMessageId).toBe(messageId);
  });

  it("reports plainly when Discord refuses to create the category", async () => {
    const discord = vi.fn<Fetcher>(async () => new Response(JSON.stringify({ message: "Missing Permissions" }), { status: 403 }));
    vi.stubGlobal("fetch", discord);
    const { env, pending } = fakeEnv({
      "space:123456789012345678:/create": () => ({ created: true, space: { ownerId: owner } }),
    });
    await invoke(env, component("space:create"));
    await Promise.all(pending);
    const followUp = discord.mock.calls.find(([url]) => String(url).includes("/webhooks/"));
    expect(String(followUp?.[1]?.body ?? "")).toContain("Manage Channels");
  });
});

describe("follow-up webhook", () => {
  it("addresses the follow-up by interaction token, not by interaction id", async () => {
    const discord = vi.fn<Fetcher>(async () => new Response(JSON.stringify({ id: messageId }), { status: 200 }));
    vi.stubGlobal("fetch", discord);
    const { env, pending } = fakeEnv({
      "space:123456789012345678:/create": () => ({
        created: true,
        space: { ownerId: owner, categoryId: null, textChannelId: null, voiceChannelId: null, statusMessageId: null, buddies: [], focus: null, busy: false, breakUntil: null },
      }),
    });

    const interaction = component("space:create");
    await invoke(env, interaction);
    await Promise.all(pending);

    const followUp = discord.mock.calls.find(([url]) => String(url).includes("/webhooks/"));
    expect(followUp).toBeDefined();
    expect(String(followUp?.[0])).toBe(`https://discord.com/api/v10/webhooks/623456789012345678/interaction-token`);
    // The id is not a webhook credential and must never stand in for the token.
    expect(String(followUp?.[0])).not.toContain(interaction.id);
  });

  it("says something rather than hanging when the interaction carries no token", async () => {
    const discord = vi.fn<Fetcher>(async () => new Response(JSON.stringify({ id: messageId }), { status: 200 }));
    vi.stubGlobal("fetch", discord);
    const { env, pending } = fakeEnv({
      "space:123456789012345678:/create": () => ({
        created: true,
        space: { ownerId: owner, categoryId: null, textChannelId: null, voiceChannelId: null, statusMessageId: null, buddies: [], focus: null, busy: false, breakUntil: null },
      }),
    });

    const tokenless = { ...component("space:create"), token: undefined };
    await invoke(env, tokenless);
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(discord.mock.calls.some(([url]) => String(url).includes("/webhooks/"))).toBe(false);
  });
});

describe("buddy buttons", () => {
  const existing = { ownerId: owner, textChannelId: channelId, voiceChannelId: "433456789012345678", statusMessageId: messageId, buddies: [], focus: null, busy: false, breakUntil: null, categoryId: "111111111111111111" };

  it("refuses when someone else presses the button", async () => {
    const { env, calls } = fakeEnv({ "space:123456789012345678:/get": () => ({ space: existing }) });
    const response = await invoke(env, component(`buddy:add:${owner}.${buddy}`, stranger));
    const payload = (await response.json()) as { data: { content: string } };
    expect(payload.data.content).toMatch(/only the person who asked/i);
    expect(calls.some((call) => call.path === "/addBuddy")).toBe(false);
  });

  it("adds the buddy and grants them access to both rooms", async () => {
    const discord = vi.fn<Fetcher>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", discord);
    const { env, calls } = fakeEnv({
      "space:123456789012345678:/get": () => ({ space: existing }),
      "space:123456789012345678:/addBuddy": () => ({ space: { ...existing, buddies: [{ userId: buddy, displayName: "Ria" }] } }),
    });
    const response = await invoke(env, component(`buddy:add:${owner}.${buddy}`));
    const payload = (await response.json()) as { data: { content: string; allowed_mentions: { users: string[] } } };
    expect(payload.data.content).toContain(`<@${buddy}>`);
    expect(payload.data.allowed_mentions.users).toEqual([buddy]);
    expect(calls.some((call) => call.path === "/addBuddy")).toBe(true);
    // Both channels get a permission overwrite for the new buddy.
    expect(discord.mock.calls.filter(([url]) => String(url).includes("/permissions/")).length).toBe(2);
  });

  it("refuses an owner-only change when the space is not theirs", async () => {
    const otherOwned = { ...existing, ownerId: stranger };
    const { env, calls } = fakeEnv({ "space:123456789012345678:/get": () => ({ space: otherOwned }) });
    const response = await invoke(env, component(`buddy:add:${owner}.${buddy}`));
    const payload = (await response.json()) as { data: { content: string } };
    expect(payload.data.content).toMatch(/only the owner/i);
    expect(calls.some((call) => call.path === "/addBuddy")).toBe(false);
  });
});

describe("/hatch ask", () => {
  it("defers, then posts the answer publicly, mentioning only the asker", async () => {
    const discord = vi.fn<Fetcher>(async () => new Response(JSON.stringify({ id: messageId }), { status: 200 }));
    const ai = vi.fn<Fetcher>(async () => new Response(JSON.stringify({ choices: [{ message: { content: "Pods are small groups around one goal." } }], usage: {} }), { status: 200 }));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("ai.test")) return ai(String(url), init);
      return discord(String(url), init);
    }));

    const { env, pending } = fakeEnv({
      "usage:123456789012345678:/check": () => ({ allowed: true, remainingHour: 19, remainingDay: 79 }),
      "mem:123456789012345678:/prompt": () => ({ text: "" }),
      "usage:123456789012345678:/record": () => ({ ok: true }),
    });

    const response = await invoke(env, command("hatch", [{ name: "ask", options: [{ name: "question", value: "how do pods work?" }] }]));
    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });

    await Promise.all(pending);
    expect(ai).toHaveBeenCalledTimes(1);
    const followUp = discord.mock.calls.find(([url]) => String(url).includes("/webhooks/"));
    const body = JSON.parse(String((followUp?.[1] as RequestInit).body)) as {
      content: string;
      allowed_mentions: { parse: string[]; users: string[] };
      flags: number;
    };
    expect(body.content).toContain("Pods are small groups");
    expect(body.allowed_mentions).toEqual({ parse: [], users: [owner] });
    // The answer is public so a pod can read it; only the original defer was ephemeral.
    expect(body.flags).toBeUndefined();
  });

  it("refuses past the limit without calling the model", async () => {
    const discord = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const ai = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (String(url).includes("ai.test") ? ai() : discord(String(url), init))));

    const { env, pending } = fakeEnv({
      "usage:123456789012345678:/check": () => ({ allowed: false, reason: "hour", retryAfterSeconds: 900 }),
    });

    await invoke(env, command("hatch", [{ name: "ask", options: [{ name: "question", value: "hi" }] }]));
    await Promise.all(pending);
    expect(ai).not.toHaveBeenCalled();
    const followUp = discord.mock.calls.at(-1);
    expect(String((followUp?.[1] as RequestInit).body)).toContain("hourly limit");
  });

  it("does not spend quota when the model fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("ai.test")) return new Response("{}", { status: 500 });
      return new Response("{}", { status: 200 });
    }));
    const { env, calls, pending } = fakeEnv({
      "usage:123456789012345678:/check": () => ({ allowed: true }),
      "mem:123456789012345678:/prompt": () => ({ text: "" }),
    });
    await invoke(env, command("hatch", [{ name: "ask", options: [{ name: "question", value: "hi" }] }]));
    await Promise.all(pending);
    expect(calls.some((call) => call.path === "/record")).toBe(false);
  });
});

describe("/hatch memory", () => {
  it("shows what is stored", async () => {
    const { env } = fakeEnv({
      "mem:123456789012345678:/get": () => ({ summary: "What I remember about you:\n- Goal: finish my thesis" }),
    });
    const response = await invoke(env, command("hatch", [{ name: "memory", options: [] }]));
    const payload = (await response.json()) as { data: { content: string; flags: number } };
    expect(payload.data.content).toContain("finish my thesis");
    expect(payload.data.flags).toBe(64);
  });

  it("remembers only what the person typed", async () => {
    const { env, calls } = fakeEnv({
      "mem:123456789012345678:/remember": () => ({ ok: true, replaced: false }),
    });
    await invoke(env, command("hatch", [
      { name: "remember", options: [{ name: "fact", value: "finish my thesis" }, { name: "kind", value: "goal" }] },
    ]));
    const saved = calls.find((call) => call.path === "/remember");
    expect(saved?.body).toMatchObject({ kind: "goal", text: "finish my thesis", userId: owner });
  });

  it("asks before wiping everything", async () => {
    const { env, calls } = fakeEnv();
    const response = await invoke(env, command("hatch", [{ name: "forget", options: [] }]));
    const payload = (await response.json()) as { data: { content: string; components: Array<{ components: Array<{ custom_id: string }> }> } };
    expect(payload.data.content).toMatch(/press the button/i);
    expect(payload.data.components[0]?.components[0]?.custom_id).toBe("mem:forgetAll");
    expect(calls.some((call) => call.path === "/forgetAll")).toBe(false);
  });

  it("wipes on the confirmation button", async () => {
    const { env, calls } = fakeEnv({ "mem:123456789012345678:/forgetAll": () => ({ ok: true }) });
    await invoke(env, component("mem:forgetAll"));
    expect(calls.some((call) => call.path === "/forgetAll")).toBe(true);
  });
});

describe("timer buttons", () => {
  it("cancels a timer for its starter and refreshes the live message", async () => {
    const discord = vi.fn<Fetcher>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", discord);
    const space = { ownerId: owner, textChannelId: channelId, voiceChannelId: "433456789012345678", statusMessageId: messageId, buddies: [], focus: null, busy: false, breakUntil: null, categoryId: "111111111111111111" };
    const { env, calls } = fakeEnv({ "space:123456789012345678:/cancelFocus": () => ({ space }) });
    const response = await invoke(env, component("focus:cancel"));
    const payload = (await response.json()) as { data: { content: string } };
    expect(payload.data.content).toMatch(/cancelled/i);
    expect(calls.some((call) => call.path === "/cancelFocus")).toBe(true);
    expect(
      discord.mock.calls.some(([url, init]) => String(url).includes(`/messages/${messageId}`) && init?.method === "PATCH"),
    ).toBe(true);
  });

  it("explains when only the starter may change a running timer", async () => {
    const { env } = fakeEnv({ "space:123456789012345678:/extendFocus": () => ({ error: "Only the person who started this timer can extend it." }) });
    const response = await invoke(env, component("focus:extend10"));
    const payload = (await response.json()) as { data: { content: string } };
    expect(payload.data.content).toMatch(/only the person who started/i);
  });
});
