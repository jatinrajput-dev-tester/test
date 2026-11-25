// Personal memory: one record per Discord user, holding only what they chose to share.
// Opt-in and visible: the person can see everything with /hatch memory and wipe it with
// /hatch forget. Stored in a Durable Object (MemoryStore), keyed by the Discord user ID.
//
// Pure helpers live here; the DO in src/memory-store.ts does the storage.

export type MemoryKind = "goal" | "preference" | "buddy" | "language" | "note";

export const MEMORY_KINDS: readonly MemoryKind[] = ["goal", "preference", "buddy", "language", "note"];

export type MemoryEntry = {
  kind: MemoryKind;
  text: string;
  createdAt: number; // unix seconds
};

export type MemoryRecord = {
  userId: string;
  entries: MemoryEntry[];
  updatedAt: number;
};

export const MAX_ENTRIES = 25;
export const MAX_TEXT_LENGTH = 160;

export function emptyMemory(userId: string, now: number): MemoryRecord {
  return { userId, entries: [], updatedAt: now };
}

// Adds or replaces an entry of the same kind with the same text (case-insensitive),
// so "my goal is X" said twice does not grow the list. Returns a new record.
export function rememberFact(
  record: MemoryRecord,
  fact: { kind: MemoryKind; text: string },
  now: number,
): { ok: true; record: MemoryRecord; replaced: boolean } | { ok: false; reason: string } {
  const text = fact.text.trim().replace(/\s+/g, " ");
  if (text.length === 0) return { ok: false, reason: "Nothing to remember." };
  if (text.length > MAX_TEXT_LENGTH) {
    return { ok: false, reason: `Keep it under ${MAX_TEXT_LENGTH} characters.` };
  }

  const lowered = text.toLowerCase();
  const existing = record.entries.findIndex(
    (entry) => entry.kind === fact.kind && entry.text.toLowerCase() === lowered,
  );

  const entries = [...record.entries];
  if (existing >= 0) return { ok: true, record: { ...record, entries, updatedAt: now }, replaced: true };

  if (entries.length >= MAX_ENTRIES) {
    // Drop the oldest before adding, so the cap never silently blocks a new fact.
    entries.sort((a, b) => b.createdAt - a.createdAt);
    entries.length = MAX_ENTRIES - 1;
  }

  entries.push({ kind: fact.kind, text, createdAt: now });
  return { ok: true, record: { ...record, entries, updatedAt: now }, replaced: false };
}

export function forgetFact(
  record: MemoryRecord,
  fact: { text: string } | { kind: MemoryKind },
  now: number,
): { ok: true; record: MemoryRecord; removed: number } {
  const before = record.entries.length;
  const entries = record.entries.filter((entry) => {
    if ("text" in fact) {
      const needle = fact.text.toLowerCase();
      // Unlink a phrase, not just an exact string: "my goal" clears "my goal is finish X".
      return !entry.text.toLowerCase().includes(needle);
    }
    return entry.kind !== fact.kind;
  });
  return { ok: true, record: { ...record, entries, updatedAt: now }, removed: before - entries.length };
}

export function forgetAll(record: MemoryRecord, now: number): MemoryRecord {
  return { ...record, entries: [], updatedAt: now };
}

// Groups entries by kind in a fixed order, so /hatch memory reads the same way every time.
export function summarizeMemory(record: MemoryRecord): string {
  if (record.entries.length === 0) {
    return "I'm not remembering anything about you. Add something with /hatch remember.";
  }

  const labels: Record<MemoryKind, string> = {
    goal: "Goal",
    preference: "Preference",
    buddy: "Buddy",
    language: "Language",
    note: "Note",
  };

  const lines: string[] = ["What I remember about you:"];
  for (const kind of MEMORY_KINDS) {
    const items = record.entries
      .filter((entry) => entry.kind === kind)
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const item of items) lines.push(`- ${labels[kind]}: ${item.text}`);
  }
  lines.push("");
  lines.push("Wipe it all with /hatch forget.");
  return lines.join("\n");
}

// Compact form handed to the model so suggestions can be personal without dumping everything.
export function memoryForPrompt(record: MemoryRecord): string {
  if (record.entries.length === 0) return "";
  const lines = record.entries
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((entry) => `- ${entry.kind}: ${entry.text}`);
  return `Things this person chose to share with Hatch (use only to personalise an answer; never repeat them back unless asked):\n${lines.join("\n")}`;
}
