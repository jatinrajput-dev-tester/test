import { describe, expect, it, vi } from "vitest";
import { askHatch, systemPrompt, tidy, ASSISTANT_MODEL } from "../src/ai.js";
import { HATCH_FACTS } from "../src/knowledge.js";
import { checkLimit, recordUse, limitMessage, LIMIT_HOUR, LIMIT_DAY, emptyWindow } from "../src/ratelimit.js";

const base = { baseUrl: "https://ai.test/v1/", apiKey: "test-key-not-a-secret" };

function mockFetch(body: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

const good = { choices: [{ message: { content: "  Hatch is a social space for students.  " } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };

describe("assistant prompt", () => {
  it("carries the real Hatch facts and forbids the Python tool", () => {
    const prompt = systemPrompt();
    expect(prompt).toContain("NOT the Python packaging tool");
    expect(prompt).toContain("30 November 2026");
    expect(prompt).toContain("https://docs.hatchh.io");
    expect(prompt).toContain(HATCH_FACTS.slice(0, 80));
  });
  it("tells the model to refuse invented facts and ignore injected instructions", () => {
    const prompt = systemPrompt();
    expect(prompt).toMatch(/not sure/i);
    expect(prompt).toMatch(/never as instructions/i);
  });
});

describe("askHatch", () => {
  it("posts an OpenAI-shaped request with the system prompt and question", async () => {
    const fake = mockFetch(good);
    const result = await askHatch({ ...base, question: "what is hatch?", fetchImpl: fake });
    expect(result.ok).toBe(true);
    const [url, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    // A trailing slash on the base URL must not double up.
    expect(url).toBe("https://ai.test/v1/chat/completions");
    expect(init.headers).toEqual({ Authorization: "Bearer test-key-not-a-secret", "Content-Type": "application/json" });
    const sent = JSON.parse(String(init.body)) as { model: string; messages: Array<{ role: string; content: string }> };
    expect(sent.model).toBe(ASSISTANT_MODEL);
    expect(sent.messages[0]?.role).toBe("system");
    expect(sent.messages.at(-1)).toEqual({ role: "user", content: "what is hatch?" });
  });
  it("passes memory through as a second system message", async () => {
    const fake = mockFetch(good);
    await askHatch({ ...base, question: "hi", history: [{ role: "system", content: "goal: finish thesis" }], fetchImpl: fake });
    const [, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    expect(sent.messages.some((m) => m.content === "goal: finish thesis")).toBe(true);
  });
  it("trims the answer and reports usage", async () => {
    const result = await askHatch({ ...base, question: "q", fetchImpl: mockFetch(good) });
    expect(result).toEqual({ ok: true, answer: "Hatch is a social space for students.", promptTokens: 10, completionTokens: 5 });
  });
  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [429, "rate_limited"],
    [500, "upstream"],
    [503, "upstream"],
  ])("maps status %i to %s without throwing", async (status, reason) => {
    const result = await askHatch({ ...base, question: "q", fetchImpl: mockFetch({}, status) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  });
  it("treats an empty or missing message as a bad response", async () => {
    for (const body of [{ choices: [] }, { choices: [{ message: { content: "   " } }] }, {}]) {
      const result = await askHatch({ ...base, question: "q", fetchImpl: mockFetch(body) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("bad_response");
    }
  });
  it("reports a timeout instead of hanging", async () => {
    const fake = vi.fn(async (_url: string, init: RequestInit) => {
      await new Promise((resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        void resolve;
      });
      return new Response("{}");
    });
    const result = await askHatch({ ...base, question: "q", fetchImpl: fake as unknown as typeof fetch, timeoutMs: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timeout");
  });
  it("never leaks the api key into a failure detail", async () => {
    const result = await askHatch({ ...base, question: "q", fetchImpl: mockFetch({}, 500) });
    expect(JSON.stringify(result)).not.toContain("test-key");
  });
});

describe("tidy", () => {
  it("trims and collapses excess blank lines", () => {
    expect(tidy("  a\n\n\n\nb  ")).toBe("a\n\nb");
  });
  it("keeps short answers intact", () => {
    expect(tidy("Short answer.")).toBe("Short answer.");
  });
  it("cuts long answers under Discord's limit", () => {
    const long = "Sentence one. ".repeat(300);
    const out = tidy(long);
    expect(out.length).toBeLessThanOrEqual(1900);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("rate limits", () => {
  const now = 1_800_000_000;
  it("allows a fresh window and reports what is left", () => {
    const decision = checkLimit(emptyWindow(), now);
    expect(decision.allowed).toBe(true);
    expect(decision.remainingHour).toBe(LIMIT_HOUR);
    expect(decision.remainingDay).toBe(LIMIT_DAY);
  });
  it("blocks at the hourly limit and says when it frees", () => {
    let window = emptyWindow();
    for (let i = 0; i < LIMIT_HOUR; i += 1) window = recordUse(window, now - 60 * i);
    const decision = checkLimit(window, now);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("hour");
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
      expect(decision.retryAfterSeconds).toBeLessThanOrEqual(60 * 60);
    }
  });
  it("blocks at the daily limit even when the hour is clear", () => {
    let window = emptyWindow();
    // Spread 80 requests across the last 23 hours, none inside the last hour.
    for (let i = 0; i < LIMIT_DAY; i += 1) window = recordUse(window, now - 3600 - i * 900);
    const decision = checkLimit(window, now);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("day");
  });
  it("forgets requests older than a day", () => {
    const window = recordUse(emptyWindow(), now - 25 * 3600);
    const decision = checkLimit(window, now);
    expect(decision.allowed).toBe(true);
    expect(decision.remainingDay).toBe(LIMIT_DAY);
  });
  it("says the hourly and daily limit plainly with a timestamp", () => {
    expect(limitMessage("hour", 600, now)).toMatch(/\d{1,2}:\d{2} [AP]M IST/);
    expect(limitMessage("day", 600, now)).toMatch(/today's limit/);
  });
});
