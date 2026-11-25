import { describe, expect, it } from "vitest";
import {
  addBuddy,
  botOverwrites,
  buildOverwrites,
  CONNECT,
  SEND_MESSAGES,
  VIEW_CHANNEL,
  cancelFocus,
  channelSlug,
  extendFocus,
  isIdle,
  isMember,
  planSpace,
  removeBuddy,
  spaceName,
  startBreak,
  startFocus,
  statusContent,
  statusMentions,
  MAX_BUDDIES,
  type SpaceState,
} from "../src/space.js";
import {
  parseComponentId,
  buddyButtonId,
  previewSpaceReply,
  focusControlComponents,
  findOption,
  isSnowflakeLike,
} from "../src/interactions.js";

const owner = "123456789012345678";
const buddy = "223456789012345678";
const stranger = "323456789012345678";
const now = 1_800_000_000;
const EVERYONE = "1567841119524626442"; // @everyone is a role whose id is the guild id
const BOT = "1574405329834221609";

function fresh(): SpaceState {
  return {
    ownerId: owner,
    spaceName: "Fishy's friends",
    categoryId: null,
    textChannelId: "423456789012345678",
    voiceChannelId: "523456789012345678",
    statusMessageId: "623456789012345678",
    buddies: [],
    focus: null,
    busy: false,
    breakUntil: null,
    updatedAt: now,
  };
}

describe("naming", () => {
  it("builds a friendly default name from the display name", () => {
    expect(spaceName("Fishy")).toBe("Fishy's friends");
  });
  it("strips characters Discord dislikes", () => {
    expect(spaceName("a/b\\c#d@e!")).toBe("abcde's friends");
  });
  it("falls back to a safe name when nothing usable is left", () => {
    expect(spaceName("///")).toBe("Your's friends");
  });
  it("caps the length", () => {
    expect(spaceName("x".repeat(200)).length).toBeLessThanOrEqual(60);
  });
  it("makes lowercase dashed channel names", () => {
    expect(channelSlug("Fishy's friends", "chat")).toBe("fishys-friends-chat");
    expect(channelSlug("Fishy's friends", "focus")).toBe("fishys-friends-focus");
    expect(channelSlug("", "chat")).toBe("hatch-space-chat");
  });
  it("plans a category, a text channel and a voice room", () => {
    const plan = planSpace("Fishy");
    expect(plan).toEqual({
      catalogName: "Fishy's friends",
      textName: "fishys-friends-chat",
      voiceName: "fishys-friends-focus",
    });
  });
});

describe("permissions", () => {
  it("denies @everyone and grants only the named people", () => {
    const overwrites = buildOverwrites([owner, buddy], EVERYONE, BOT);
    expect(overwrites.text[0]).toEqual({ id: EVERYONE, type: 0, allow: "0", deny: expect.any(String) });
    expect(overwrites.text.some((row) => row.id === owner && row.type === 1)).toBe(true);
    expect(overwrites.text.some((row) => row.id === buddy && row.type === 1)).toBe(true);
    expect(overwrites.voice.some((row) => row.id === buddy)).toBe(true);
  });
  it("grants the bot its own access so it can work inside the room it made", () => {
    // Without this the bot inherits the category's @everyone deny and every post inside
    // its own space fails with "Missing Permissions".
    const overwrites = buildOverwrites([owner], EVERYONE, BOT);
    for (const rows of [overwrites.text, overwrites.voice]) {
      const row = rows.find((entry) => entry.id === BOT);
      expect(row?.type).toBe(1);
      expect(BigInt(row?.allow ?? "0") & VIEW_CHANNEL).not.toBe(BigInt(0));
    }
    const textBot = overwrites.text.find((entry) => entry.id === BOT);
    expect(BigInt(textBot?.allow ?? "0") & SEND_MESSAGES).not.toBe(BigInt(0));
  });
  it("gives the bot view of the category before any rooms exist", () => {
    const rows = botOverwrites(BOT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(BOT);
    expect(BigInt(rows[0]?.allow ?? "0") & VIEW_CHANNEL).not.toBe(BigInt(0));
  });
  it("grants view of text but not send in the voice room", () => {
    const overwrites = buildOverwrites([buddy], EVERYONE, BOT);
    const last = (rows: typeof overwrites.text) => rows[rows.length - 1];
    const textAllow = BigInt(last(overwrites.text)?.allow ?? "0");
    const voiceAllow = BigInt(last(overwrites.voice)?.allow ?? "0");
    expect((textAllow & SEND_MESSAGES) !== BigInt(0)).toBe(true);
    expect((voiceAllow & SEND_MESSAGES)).toBe(BigInt(0));
    expect((voiceAllow & CONNECT) !== BigInt(0)).toBe(true);
  });
});

describe("buddies", () => {
  it("adds a buddy once and refuses duplicates", () => {
    const first = addBuddy(fresh(), { userId: buddy, displayName: "Ria", addedAt: now });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(isMember(first.state, buddy)).toBe(true);
    const again = addBuddy(first.state, { userId: buddy, displayName: "Ria", addedAt: now });
    expect(again.ok).toBe(false);
  });
  it("refuses to add the owner to their own space", () => {
    expect(addBuddy(fresh(), { userId: owner, displayName: "Me", addedAt: now }).ok).toBe(false);
  });
  it("caps the number of buddies", () => {
    let state = fresh();
    for (let i = 0; i < MAX_BUDDIES; i += 1) {
      const result = addBuddy(state, { userId: `9${String(i).padStart(17, "0")}`, displayName: `B${i}`, addedAt: now });
      if (result.ok) state = result.state;
    }
    expect(state.buddies.length).toBe(MAX_BUDDIES);
    expect(addBuddy(state, { userId: stranger, displayName: "Late", addedAt: now }).ok).toBe(false);
  });
  it("removes a buddy and reports who was removed", () => {
    const added = addBuddy(fresh(), { userId: buddy, displayName: "Ria", addedAt: now });
    if (!added.ok) throw new Error("setup");
    const removed = removeBuddy(added.state, buddy);
    expect(removed.removed?.userId).toBe(buddy);
    expect(isMember(removed.state, buddy)).toBe(false);
  });
});

describe("space timers", () => {
  it("starts a timer for a member with a goal", () => {
    const result = startFocus(fresh(), { starterId: owner, starterName: "Fishy", minutes: 25, goal: "Thesis", now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.endsAt).toBe(now + 25 * 60);
    expect(result.state.focus?.goal).toBe("Thesis");
  });
  it("rejects a duration Discord does not offer", () => {
    expect(startFocus(fresh(), { starterId: owner, starterName: "F", minutes: 30, now }).ok).toBe(false);
  });
  it("refuses a timer from someone outside the space", () => {
    expect(startFocus(fresh(), { starterId: stranger, starterName: "S", minutes: 25, now }).ok).toBe(false);
  });
  it("refuses a second timer while one is running", () => {
    const first = startFocus(fresh(), { starterId: owner, starterName: "F", minutes: 25, now });
    if (!first.ok) throw new Error("setup");
    expect(startFocus(first.state, { starterId: owner, starterName: "F", minutes: 25, now: now + 60 }).ok).toBe(false);
  });
  it("only lets the starter or the owner cancel", () => {
    const withBuddy = addBuddy(fresh(), { userId: buddy, displayName: "Ria", addedAt: now });
    if (!withBuddy.ok) throw new Error("setup");
    const current = startFocus(withBuddy.state, { starterId: buddy, starterName: "B", minutes: 25, now });
    if (!current.ok) throw new Error("setup");
    expect(cancelFocus(current.state, stranger, now).ok).toBe(false);
    expect(cancelFocus(current.state, buddy, now).ok).toBe(true);
    expect(cancelFocus(current.state, owner, now).ok).toBe(true);
  });
  it("extends by 5 or 10 minutes only, and only for the starter", () => {
    const current = startFocus(fresh(), { starterId: owner, starterName: "F", minutes: 25, now });
    if (!current.ok) throw new Error("setup");
    const extended = extendFocus(current.state, owner, 5, now);
    expect(extended.ok).toBe(true);
    if (extended.ok) expect(extended.session.endsAt).toBe(now + 30 * 60);
    expect(extendFocus(current.state, owner, 7, now).ok).toBe(false);
    expect(extendFocus(current.state, buddy, 5, now).ok).toBe(false);
  });
  it("starts a break for a member and marks the space busy", () => {
    const result = startBreak(fresh(), owner, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.busy).toBe(true);
    expect(isIdle(result.state, now + 10)).toBe(false);
    expect(isIdle(result.state, result.breakUntil + 1)).toBe(true);
  });
});

describe("live status message", () => {
  it("shows who is focusing with a real timestamp and only their mention", () => {
    const current = startFocus(fresh(), { starterId: owner, starterName: "F", minutes: 25, goal: "Thesis", now });
    if (!current.ok) throw new Error("setup");
    const content = statusContent(current.state, now + 60);
    expect(content).toContain(`<@${owner}>`);
    expect(content).toMatch(/ends \d{1,2}:\d{2} [AP]M IST/);
    expect(content).toContain("Thesis");
    expect(statusMentions(current.state, now + 60)).toEqual({ parse: [], users: [owner] });
  });
  it("says everyone is free when nothing is running", () => {
    const content = statusContent(fresh(), now);
    expect(content).toMatch(/free/i);
    expect(statusMentions(fresh(), now)).toEqual({ parse: [], users: [] });
  });
  it("counts the people in the space", () => {
    const added = addBuddy(fresh(), { userId: buddy, displayName: "Ria", addedAt: now });
    if (!added.ok) throw new Error("setup");
    expect(statusContent(added.state, now)).toContain("2 people");
  });
  it("shows an active break", () => {
    const broken = startBreak(fresh(), owner, now);
    if (!broken.ok) throw new Error("setup");
    expect(statusContent(broken.state, now + 60)).toMatch(/break/i);
  });
});

describe("component ids", () => {
  it("round-trips a buddy button and recovers who asked and who is affected", () => {
    const id = buddyButtonId("add", owner, buddy);
    expect(parseComponentId(id)).toEqual({ kind: "buddy:add", targetId: buddy, requesterId: owner });
  });
  it("parses the fixed ids", () => {
    expect(parseComponentId("space:create")).toEqual({ kind: "space:create", targetId: null, requesterId: null });
    expect(parseComponentId("focus:extend10")?.kind).toBe("focus:extend10");
    expect(parseComponentId("mem:forgetAll")?.kind).toBe("mem:forgetAll");
  });
  it("refuses invented or forged ids", () => {
    expect(parseComponentId("space:delete-everything")).toBeNull();
    expect(parseComponentId("buddy:add:notasnowflake")).toBeNull();
    expect(parseComponentId("")).toBeNull();
  });
  it("validates snowflakes for ids", () => {
    expect(isSnowflakeLike("123456789012345678")).toBe(true);
    expect(isSnowflakeLike("12345")).toBe(false);
    expect(isSnowflakeLike(undefined)).toBe(false);
  });
});

describe("preview card", () => {
  it("shows what will be built with Create and Cancel, and no pings", () => {
    const reply = previewSpaceReply("Fishy's friends");
    expect(reply.ephemeral).toBe(true);
    expect(reply.allowedMentions).toEqual({ parse: [] });
    expect(reply.content).toContain("Fishy's friends");
    expect(reply.content).toContain("Nothing is created until you press Create");
    const ids = reply.components[0]?.components.map((button) => button.custom_id);
    expect(ids).toEqual(["space:create", "space:cancel"]);
  });
  it("offers cancel, extend and break on a running timer", () => {
    const ids = focusControlComponents()[0]?.components.map((button) => button.custom_id);
    expect(ids).toEqual(["focus:cancel", "focus:extend5", "focus:extend10", "focus:break"]);
  });
});

describe("option reading", () => {
  it("finds options nested under a subcommand", () => {
    const options = [
      { name: "ask", options: [{ name: "question", value: "how do pods work?" }] },
    ];
    expect(findOption(options, "question")).toBe("how do pods work?");
  });
  it("returns undefined for a missing option", () => {
    expect(findOption(undefined, "question")).toBeUndefined();
    expect(findOption([], "question")).toBeUndefined();
  });
});

describe("half-built spaces", () => {
  it("counts as built only when both rooms exist", async () => {
    const { isBuilt } = await import("../src/space.js");
    expect(isBuilt({ textChannelId: null, voiceChannelId: null })).toBe(false);
    expect(isBuilt({ textChannelId: "423456789012345678", voiceChannelId: null })).toBe(false);
    expect(isBuilt({ textChannelId: "423456789012345678", voiceChannelId: "433456789012345678" })).toBe(true);
  });
});
