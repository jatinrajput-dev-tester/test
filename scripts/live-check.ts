// Local end-to-end harness: walks each feature through the real Worker code with Discord
// and the model faked, prints what the bot would send, and (with the real key) can also
// make one true call to the assistant. It never talks to Discord, so nothing posts anywhere.
//
// Run: npx tsx scripts/live-check.ts

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { readFileSync } from "node:fs";

const OWNER = "123456789012345678";
const BUDDY = "223456789012345678";
const CHANNEL = "423456789012345678";
const VOICE = "433456789012345678";
const CATEGORY = "111111111111111111";
const MESSAGE = "523456789012345678";
const GUILD = "923456789012345678";

type Step = { label: string; run: () => Promise<void> };

function loadDevVars(): void {
  try {
    const text = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined && match[2] !== undefined && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2];
      }
    }
  } catch {
    // No .dev.vars: the AI step will say so; everything else still runs.
  }
}

// ---------------------------------------------------------------- fakes

const discordCalls: Array<{ method: string; url: string; body: string }> = [];

function fakeDiscord(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  discordCalls.push({ method, url, body: String(init?.body ?? "") });
  if (url.endsWith("/channels")) {
    const isCategory = String(init?.body ?? "").includes('"type":4');
    return json({ id: isCategory ? CATEGORY : url.includes("voice") ? VOICE : CHANNEL });
  }
  if (url.includes("/threads")) return json({ id: "thread-1" });
  return json({ id: MESSAGE });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeAi(): Response {
  return json({ choices: [{ message: { content: "Pods are small groups built around one goal." } }], usage: { prompt_tokens: 10, completion_tokens: 8 } });
}

// Every Durable Object call is served from this in-memory map, so state survives the run.
const doState = new Map<string, Record<string, unknown>>();
const doCalls: string[] = [];
let usageCount = 0;
let memText = "";

function fakeNamespace() {
  return {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: async (url: string, init?: RequestInit): Promise<Response> => {
        const path = new URL(url).pathname;
        doCalls.push(`${name}${path}`);
        const key = name;
        // The creator and the space are separate stores that share a suffix; keep them apart.
        if (path === "/get" && name.startsWith("space:")) {
          const created = doState.get(name);
          return json({ space: created ?? null });
        }
        const current = doState.get(key);
        const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);

        if (path === "/get" && key.startsWith("mem:")) {
          return json({
            summary:
              memText.length > 0
                ? `What I remember about you:\n- Goal: ${memText}`
                : "I'm not remembering anything about you.",
          });
        }
        if (path === "/get") return json({ space: current ?? null });
        if (path === "/create") {
          if (current !== undefined) return json({ created: false, space: current });
          const space = {
            ownerId: body["ownerId"], spaceName: body["spaceName"], categoryId: null,
            textChannelId: null, voiceChannelId: null, statusMessageId: null,
            buddies: [], focus: null, busy: false, breakUntil: null, updatedAt: 0,
          };
          doState.set(`space:${name.slice("space:".length)}`, space);
          doState.set(name, space);
          return json({ created: true, space });
        }
        // Memory lives in a different store; route it before touching a space.
        if (path === "/remember") { memText = String(body["text"] ?? ""); return json({ ok: true, replaced: false }); }
        if (path === "/forget") return json({ ok: true, removed: 1 });
        if (path === "/forgetAll") return json({ ok: true });
        if (path === "/prompt") return json({ text: "" });
        if (key.startsWith("mem:")) {
          return json({ summary: "What I remember about you:\n- Goal: finish my thesis" });
        }
        if (path === "/record") {
          usageCount += 1;
          return json({ ok: true });
        }
        if (path === "/check") {
          const allowed = usageCount < 20;
          return json({ allowed, reason: allowed ? null : "hour", retryAfterSeconds: 600, remainingHour: 20 - usageCount, remainingDay: 80 - usageCount });
        }
        if (path === "/peek") return json({ remainingHour: 20 - usageCount, remainingDay: 80 - usageCount });
        if (current === undefined) return json({ error: "No space yet." }, 404);
        const space = current ?? {};
        if (path === "/channels") {
          Object.assign(space, { categoryId: body["categoryId"], textChannelId: body["textChannelId"], voiceChannelId: body["voiceChannelId"] });
        }
        if (path === "/statusMessage") space["statusMessageId"] = body["statusMessageId"];
        if (path === "/addBuddy") {
          const buddies = (space["buddies"] as unknown[]) ?? [];
          space["buddies"] = [...buddies, body["member"]];
        }
        if (path === "/removeBuddy") space["buddies"] = [];
        if (path === "/focus") {
          const now = Math.floor(Date.now() / 1000);
          space["focus"] = {
            starterId: body["starterId"], starterName: body["starterName"],
            minutes: body["minutes"], startedAt: now, endsAt: now + Number(body["minutes"]) * 60,
            ...(typeof body["goal"] === "string" ? { goal: body["goal"] } : {}),
          };
        }
        if (path === "/cancelFocus") space["focus"] = null;
        if (path === "/extendFocus") {
          const focus = space["focus"] as { endsAt: number; minutes: number };
          space["focus"] = { ...focus, endsAt: focus.endsAt + Number(body["minutes"]) * 60, minutes: focus.minutes + Number(body["minutes"]) };
        }
        if (path === "/break") {
          space["busy"] = true;
          space["breakUntil"] = Math.floor(Date.now() / 1000) + 300;
        }
        if (path === "/remember") {
          const entries = (space["entries"] as unknown[]) ?? [];
          space["entries"] = [...entries, { kind: body["kind"], text: body["text"], createdAt: 0 }];
          return json({ ok: true, replaced: false });
        }
        if (path === "/forget") return json({ ok: true, removed: 1 });
        if (path === "/forgetAll") return json({ ok: true });
        if (path === "/prompt") return json({ text: "" });
        if (path === "/get" || path === "/summary") return json({ summary: "What I remember about you:\n- Goal: finish my thesis" });
        doState.set(key, space);
        return json({ ok: true, space });
      },
    }),
  };
}

function env(): Env {
  const ns = fakeNamespace();
  return {
    DISCORD_PUBLIC_KEY: "k", DISCORD_BOT_TOKEN: "test-token", DISCORD_APP_ID: GUILD,
    GUILD_ID: GUILD, SESSION_PINGS_ROLE_ID: "723456789012345678", GOALS_CHANNEL_ID: "823456789012345678",
    AI_BASE_URL: "https://ai.test/v1", AI_API_KEY: "test",
    FOCUS_TIMERS: ns, MEMORIES: ns, USAGE: ns, SPACES: ns,
  } as unknown as Env;
}

// ---------------------------------------------------------------- the run

let tscPublicKey = "";

async function sign(body: unknown): Promise<Request> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("no keypair");
  const pub = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(pub instanceof ArrayBuffer)) throw new Error("no raw key");
  const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  tscPublicKey = hex(pub);
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = hex(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(timestamp + raw)));
  return new Request("https://worker.test/interactions", {
    method: "POST",
    headers: { "X-Signature-Ed25519": sig, "X-Signature-Timestamp": timestamp },
    body: raw,
  });
}

async function ask(body: unknown): Promise<{ type: number; data?: { content: string; flags?: number; components?: unknown[] } }> {
  const request = await sign(body);
  const envObj = env();
  envObj.DISCORD_PUBLIC_KEY = tscPublicKey;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;
  const response = await worker.fetch(request, envObj, ctx);
  const payload = (await response.json()) as { type: number; data?: { content: string; flags?: number; components?: unknown[] } };
  // Slow paths (build space, ask) finish in waitUntil; wait for them before printing.
  await Promise.all(pending);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return payload;
}

function command(name: string, options: unknown[] = []) {
  return {
    type: 2, id: String(Date.now()), channel_id: CHANNEL, guild_id: GUILD,
    member: { user: { id: OWNER, username: "fishy", global_name: "Fishy" } },
    data: { name, options },
  };
}

function component(customId: string, userId = OWNER) {
  return {
    type: 3, id: String(Date.now()), channel_id: CHANNEL, guild_id: GUILD,
    member: { user: { id: userId, username: "fishy", global_name: "Fishy" } },
    data: { custom_id: customId },
  };
}

function show(payload: { type: number; data?: { content: string; flags?: number; components?: unknown[] } }): void {
  const deferred = payload.type === 5;
  console.log(`   bot: ${deferred ? "(deferred, then a follow-up)" : payload.data?.content?.replace(/\n/g, "\n        ")}`);
  if (payload.data?.flags === 64) console.log("   (only the person sees this)");
  if (payload.data?.components !== undefined) console.log("   (with buttons)");
}

const steps: Step[] = [
  { label: "/launch before the beta", run: async () => show(await ask(command("launch"))) },
  { label: "/waitlist", run: async () => show(await ask(command("waitlist"))) },
  { label: "/focus with a goal", run: async () => show(await ask(command("focus", [{ name: "minutes", value: 25 }, { name: "goal", value: "Finish chapter 3" }]))) },
  { label: "/focus with a bad duration (30)", run: async () => show(await ask(command("focus", [{ name: "minutes", value: 30 }]))) },
  { label: "/hatch space (preview)", run: async () => show(await ask(command("hatch", [{ name: "space", options: [] }]))) },
  { label: "press Create", run: async () => show(await ask(component("space:create"))) },
  { label: "/hatch add a buddy", run: async () => show(await ask(command("hatch", [{ name: "add", options: [{ name: "buddy", value: BUDDY }] }]))) },
  { label: "confirm the buddy", run: async () => show(await ask(component(`buddy:add:${OWNER}.${BUDDY}`))) },
  { label: "someone else presses that button", run: async () => show(await ask(component(`buddy:add:${OWNER}.${BUDDY}`, BUDDY))) },
  { label: "/hatch remember", run: async () => show(await ask(command("hatch", [{ name: "remember", options: [{ name: "fact", value: "finish my thesis" }, { name: "kind", value: "goal" }] }]))) },
  { label: "/hatch memory", run: async () => show(await ask(command("hatch", [{ name: "memory", options: [] }]))) },
  { label: "/hatch usage", run: async () => show(await ask(command("hatch", [{ name: "usage", options: [] }]))) },
  { label: "focus Cancel button", run: async () => show(await ask(component("focus:cancel"))) },
  { label: "focus Break button", run: async () => show(await ask(component("focus:break"))) },
  { label: "/hatch ask (model faked)", run: async () => show(await ask(command("hatch", [{ name: "ask", options: [{ name: "question", value: "how do pods work?" }] }]))) },
];

loadDevVars();

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("ai.test") || (process.env["AI_BASE_URL"] !== undefined && url.startsWith(process.env["AI_BASE_URL"]))) {
    return fakeAi();
  }
  return fakeDiscord(url, init);
}) as typeof fetch;

console.log(`Walking each feature through the real Worker. Discord is faked; nothing is posted.\n`);
for (const step of steps) {
  discordCalls.length = 0;
  doCalls.length = 0;
  console.log(`\n▸ ${step.label}`);
  await step.run();
  const posts = discordCalls.filter((call) => call.method === "POST" && call.url.endsWith("/messages"));
  for (const post of posts) {
    const content = (JSON.parse(post.body) as { content?: string }).content ?? "";
    const mentions = (JSON.parse(post.body) as { allowed_mentions?: unknown }).allowed_mentions;
    console.log(`   → posted to Discord: "${content.split("\n")[0]}" mentions=${JSON.stringify(mentions)}`);
  }
  const dos = [...new Set(doCalls)];
  if (dos.length > 0) console.log(`   → storage: ${dos.join(", ")}`);
}

// One true model call, only when a real key is present, so you see the real answer once.
const baseUrl = process.env["AI_BASE_URL"];
const apiKey = process.env["AI_API_KEY"];
if (baseUrl !== undefined && apiKey !== undefined && !baseUrl.startsWith("https://ai.test")) {
  console.log("\n▸ real assistant call (one, costs a fraction of a cent)");
  globalThis.fetch = realFetch;
  const { askHatch } = await import("../src/ai.js");
  const result = await askHatch({ baseUrl, apiKey, question: "how do pods work?" });
  console.log(result.ok ? `   real answer: ${result.answer}` : `   failed: ${result.reason}`);
}

globalThis.fetch = realFetch;
console.log("\nDone. Everything above came from the real Worker code.");
