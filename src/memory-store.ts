// MemoryStore: one Durable Object per Discord user, holding that person's memory record.
// The person owns it: they can read it all (/hatch memory) and wipe it (/hatch forget).

import {
  emptyMemory,
  forgetAll,
  forgetFact,
  rememberFact,
  summarizeMemory,
  memoryForPrompt,
  type MemoryKind,
  type MemoryRecord,
  MEMORY_KINDS,
} from "./memory.js";
import { isSnowflake } from "./discord.js";

const KEY = "memory";

export class MemoryStore implements DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: unknown) {
    void env;
    this.state = state;
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
    const record = body as Record<string, unknown>;
    const userId = record["userId"];
    if (!isSnowflake(userId)) return json({ error: "userId must be a snowflake." }, 400);

    const now = Math.floor(Date.now() / 1000);

    if (path === "/get") return this.get(userId, now);
    if (path === "/remember") return this.remember(userId, record, now);
    if (path === "/forget") return this.forget(userId, record, now);
    if (path === "/forgetAll") return this.forgetAll(userId, now);
    if (path === "/prompt") return this.prompt(userId, now);
    return new Response("", { status: 404 });
  }

  private async read(userId: string, now: number): Promise<MemoryRecord> {
    const stored = await this.state.storage.get<MemoryRecord>(KEY);
    if (stored === undefined || !Array.isArray(stored.entries)) return emptyMemory(userId, now);
    return stored;
  }

  private async write(record: MemoryRecord): Promise<void> {
    if (record.entries.length === 0) {
      await this.state.storage.delete(KEY);
      return;
    }
    await this.state.storage.put(KEY, record);
  }

  private async get(userId: string, now: number): Promise<Response> {
    const record = await this.read(userId, now);
    return json({ entries: record.entries, summary: summarizeMemory(record) });
  }

  private async prompt(userId: string, now: number): Promise<Response> {
    const record = await this.read(userId, now);
    return json({ text: memoryForPrompt(record) });
  }

  private async remember(userId: string, body: Record<string, unknown>, now: number): Promise<Response> {
    const kind = body["kind"];
    const text = body["text"];
    if (typeof kind !== "string" || !(MEMORY_KINDS as readonly string[]).includes(kind)) {
      return json({ error: "kind must be one of goal, preference, buddy, language, note." }, 400);
    }
    if (typeof text !== "string") return json({ error: "text must be a string." }, 400);

    const record = await this.read(userId, now);
    const result = rememberFact(record, { kind: kind as MemoryKind, text }, now);
    if (!result.ok) return json({ error: result.reason }, 400);

    await this.write(result.record);
    return json({ ok: true, replaced: result.replaced, entries: result.record.entries });
  }

  private async forget(userId: string, body: Record<string, unknown>, now: number): Promise<Response> {
    const record = await this.read(userId, now);

    const text = body["text"];
    const kind = body["kind"];
    if (typeof text === "string" && text.trim().length > 0) {
      const result = forgetFact(record, { text: text.trim() }, now);
      await this.write(result.record);
      return json({ ok: true, removed: result.removed, entries: result.record.entries });
    }
    if (typeof kind === "string" && (MEMORY_KINDS as readonly string[]).includes(kind)) {
      const result = forgetFact(record, { kind: kind as MemoryKind }, now);
      await this.write(result.record);
      return json({ ok: true, removed: result.removed, entries: result.record.entries });
    }
    return json({ error: "Give something to forget (text or kind)." }, 400);
  }

  private async forgetAll(userId: string, now: number): Promise<Response> {
    const record = await this.read(userId, now);
    const cleared = forgetAll(record, now);
    await this.write(cleared);
    return json({ ok: true, summary: summarizeMemory(cleared) });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
