import { describe, expect, it } from "vitest";
import {
  emptyMemory,
  forgetAll,
  forgetFact,
  memoryForPrompt,
  rememberFact,
  summarizeMemory,
  MAX_ENTRIES,
  MAX_TEXT_LENGTH,
  type MemoryRecord,
} from "../src/memory.js";

const user = "123456789012345678";
const now = 1_800_000_000;

function base(): MemoryRecord {
  return emptyMemory(user, now);
}

describe("remember", () => {
  it("adds a fact", () => {
    const result = rememberFact(base(), { kind: "goal", text: "finish my thesis" }, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.replaced).toBe(false);
    expect(result.record.entries).toEqual([{ kind: "goal", text: "finish my thesis", createdAt: now }]);
  });
  it("collapses whitespace and trims", () => {
    const result = rememberFact(base(), { kind: "goal", text: "  finish   my  thesis  " }, now);
    if (!result.ok) throw new Error("expected ok");
    expect(result.record.entries[0]?.text).toBe("finish my thesis");
  });
  it("treats a repeat as unchanged rather than duplicating", () => {
    const first = rememberFact(base(), { kind: "goal", text: "finish my thesis" }, now);
    if (!first.ok) throw new Error("setup");
    const again = rememberFact(first.record, { kind: "goal", text: "FINISH MY THESIS" }, now + 10);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.replaced).toBe(true);
    expect(again.record.entries).toHaveLength(1);
  });
  it("allows the same text under a different kind", () => {
    const first = rememberFact(base(), { kind: "goal", text: "hindi" }, now);
    if (!first.ok) throw new Error("setup");
    const second = rememberFact(first.record, { kind: "language", text: "hindi" }, now);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.record.entries).toHaveLength(2);
  });
  it("rejects empty and over-long text", () => {
    expect(rememberFact(base(), { kind: "note", text: "   " }, now).ok).toBe(false);
    expect(rememberFact(base(), { kind: "note", text: "x".repeat(MAX_TEXT_LENGTH + 1) }, now).ok).toBe(false);
    expect(rememberFact(base(), { kind: "note", text: "x".repeat(MAX_TEXT_LENGTH) }, now).ok).toBe(true);
  });
  it("keeps the list bounded by dropping the oldest", () => {
    let record = base();
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
      const result = rememberFact(record, { kind: "note", text: `note ${i}` }, now + i);
      if (!result.ok) throw new Error("unexpected rejection");
      record = result.record;
    }
    expect(record.entries.length).toBe(MAX_ENTRIES);
    expect(record.entries.some((entry) => entry.text === "note 0")).toBe(false);
    expect(record.entries.some((entry) => entry.text === `note ${MAX_ENTRIES + 4}`)).toBe(true);
  });
});

describe("forget", () => {
  function withFacts(): MemoryRecord {
    let record = base();
    for (const [kind, text] of [
      ["goal", "finish my thesis"],
      ["preference", "50 minute sessions"],
      ["language", "hindi"],
    ] as const) {
      const result = rememberFact(record, { kind, text }, now);
      if (!result.ok) throw new Error("setup");
      record = result.record;
    }
    return record;
  }

  it("removes a phrase anywhere in an entry", () => {
    const result = forgetFact(withFacts(), { text: "thesis" }, now);
    expect(result.removed).toBe(1);
    expect(result.record.entries.map((entry) => entry.text)).toEqual(["50 minute sessions", "hindi"]);
  });
  it("removes every entry of one kind", () => {
    const result = forgetFact(withFacts(), { kind: "language" }, now);
    expect(result.removed).toBe(1);
    expect(result.record.entries.some((entry) => entry.kind === "language")).toBe(false);
  });
  it("reports zero when nothing matched", () => {
    expect(forgetFact(withFacts(), { text: "quantum" }, now).removed).toBe(0);
  });
  it("forgets everything", () => {
    expect(forgetAll(withFacts(), now).entries).toEqual([]);
  });
});

describe("showing memory back", () => {
  it("says plainly when nothing is stored", () => {
    expect(summarizeMemory(base())).toMatch(/not remembering anything/i);
  });
  it("lists entries grouped by kind with the wipe hint", () => {
    let record = base();
    for (const [kind, text] of [
      ["goal", "finish my thesis"],
      ["language", "hindi"],
    ] as const) {
      const result = rememberFact(record, { kind, text }, now);
      if (!result.ok) throw new Error("setup");
      record = result.record;
    }
    const summary = summarizeMemory(record);
    expect(summary).toContain("Goal: finish my thesis");
    expect(summary).toContain("Language: hindi");
    expect(summary).toContain("/hatch forget");
  });
  it("gives the model an empty string when there is nothing", () => {
    expect(memoryForPrompt(base())).toBe("");
  });
  it("gives the model a short list when there is something", () => {
    const result = rememberFact(base(), { kind: "goal", text: "finish my thesis" }, now);
    if (!result.ok) throw new Error("setup");
    const prompt = memoryForPrompt(result.record);
    expect(prompt).toContain("goal: finish my thesis");
    expect(prompt).toMatch(/never repeat them back/i);
  });
});
