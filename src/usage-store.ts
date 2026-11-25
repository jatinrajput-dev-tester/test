// UsageStore: one Durable Object per Discord user, holding their AI request timestamps.
// Nothing else is kept here — questions and answers are never stored.

import { checkLimit, recordUse, type UsageWindow } from "./ratelimit.js";
import { isSnowflake } from "./discord.js";

const KEY = "usage";
const DAY_SECONDS = 24 * 60 * 60;

export class UsageStore implements DurableObject {
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
    const userId = (body as { userId?: unknown }).userId;
    if (!isSnowflake(userId)) return json({ error: "userId must be a snowflake." }, 400);

    const now = Math.floor(Date.now() / 1000);
    const window = await this.read();

    switch (path) {
      case "/check": {
        const decision = checkLimit(window, now);
        return json({
          allowed: decision.allowed,
          reason: decision.allowed ? null : decision.reason,
          retryAfterSeconds: decision.allowed ? 0 : decision.retryAfterSeconds,
          remainingHour: decision.remainingHour,
          remainingDay: decision.remainingDay,
        });
      }
      case "/record": {
        const next = recordUse(window, now);
        await this.state.storage.put(KEY, next);
        return json({ ok: true });
      }
      case "/peek": {
        const decision = checkLimit(window, now);
        return json({ remainingHour: decision.remainingHour, remainingDay: decision.remainingDay });
      }
      case "/clear":
        await this.state.storage.deleteAll();
        return json({ ok: true });
      default:
        return new Response("", { status: 404 });
    }
  }

  private async read(): Promise<UsageWindow> {
    const stored = await this.state.storage.get<UsageWindow>(KEY);
    if (stored === undefined || !Array.isArray(stored.timestamps)) return { timestamps: [] };
    // Drop anything older than a day so the list cannot grow without bound.
    const now = Math.floor(Date.now() / 1000);
    return { timestamps: stored.timestamps.filter((ts) => ts > now - DAY_SECONDS) };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
