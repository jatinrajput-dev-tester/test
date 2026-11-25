// Buddy spaces: the owner's private room, its buddies, focus timers, and the one live
// status message. Pure model + rules here; Discord calls and the Durable Object live
// in src/space-store.ts and src/index.ts.
//
// Every rule is scoped to one owner: a person can only change their own space, only the
// owner can invite or remove buddies, and a timer is controlled by whoever started it.

import { FOCUS_MINUTES } from "./definitions.js";
import { istTimeText, relativeText } from "./time.js";

export type SpaceMember = {
  userId: string;
  displayName: string;
  addedAt: number; // unix seconds
};

export type FocusSession = {
  starterId: string;
  starterName: string;
  minutes: number;
  goal?: string;
  startedAt: number;
  endsAt: number; // unix seconds
};

export type SpaceState = {
  ownerId: string;
  spaceName: string; // e.g. "Fishy's friends"
  categoryId: string | null;
  textChannelId: string | null;
  voiceChannelId: string | null;
  statusMessageId: string | null;
  buddies: SpaceMember[];
  focus: FocusSession | null;
  busy: boolean; // a break or a group timer is running
  breakUntil: number | null;
  updatedAt: number;
};

export const MAX_BUDDIES = 6;
export const MAX_NAME_LENGTH = 60;

export type Plan = {
  catalogName: string;
  textName: string;
  voiceName: string;
};

// "Fishy's friends" from the person's display name. Discord forbids some characters in
// channel names, so anything outside letters, digits, spaces, dashes and apostrophes goes.
export function spaceName(displayName: string): string {
  const base = displayName.replace(/[^\p{L}\p{N} '\-]/gu, "").replace(/\s+/g, " ").trim();
  const safe = base.length === 0 ? "Your" : base;
  return clamp(`${safe}'s friends`, MAX_NAME_LENGTH);
}

// "fishys-friends" — lowercase, dashes, no run of separators. Discord lowercases channel names.
export function channelSlug(name: string, suffix: "chat" | "focus"): string {
  const slug = name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const base = slug.length > 0 ? slug : "hatch-space";
  return clamp(`${base}-${suffix}`, 100);
}

export function planSpace(displayName: string): Plan {
  const name = spaceName(displayName);
  return {
    catalogName: name,
    textName: channelSlug(name, "chat"),
    voiceName: channelSlug(name, "focus"),
  };
}

// Per-channel permission overwrites. The caller fills in the guild's ids and roles.
// Default: @everyone sees nothing. The bot, the owner and each buddy get the access they need.
//
// The bot itself must be granted these. Without an overwrite of its own it inherits the
// category's @everyone deny, and then it cannot post, edit or clean up inside the room it
// just made — Discord answers "Missing Permissions" even though it holds Manage Channels.
export interface Overwrite {
  id: string;
  type: 0 | 1; // 0 = role, 1 = member
  allow: string;
  deny: string;
}

export const VIEW_CHANNEL = 1n << 10n;
export const SEND_MESSAGES = 1n << 11n;
export const READ_MESSAGE_HISTORY = 1n << 16n;
export const CONNECT = 1n << 20n;
export const SPEAK = 1n << 21n;
export const USE_APPLICATION_COMMANDS = 1n << 31n;

export const TEXT_ALLOW = VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY | USE_APPLICATION_COMMANDS;
export const VOICE_ALLOW = VIEW_CHANNEL | CONNECT | SPEAK;
// A category needs only to be seen; the rooms are what carry the permissions.
export const BOT_CATEGORY_ALLOW = VIEW_CHANNEL;

function perms(value: bigint): string {
  return value.toString();
}

// `everyoneRoleId` is the guild's own id: Discord treats @everyone as a role whose id is the
// guild id. Sending the literal "@everyone" is rejected with NUMBER_TYPE_COERCE.
// `botId` gets the same grant as a member so the bot keeps working inside the room.
export function buildOverwrites(
  grantedUserIds: readonly string[],
  everyoneRoleId: string,
  botId: string,
): {
  text: Overwrite[];
  voice: Overwrite[];
} {
  const text: Overwrite[] = [{ id: everyoneRoleId, type: 0, allow: "0", deny: perms(TEXT_ALLOW) }];
  const voice: Overwrite[] = [{ id: everyoneRoleId, type: 0, allow: "0", deny: perms(VOICE_ALLOW) }];
  for (const userId of [botId, ...grantedUserIds]) {
    text.push({ id: userId, type: 1, allow: perms(TEXT_ALLOW), deny: "0" });
    voice.push({ id: userId, type: 1, allow: perms(VOICE_ALLOW), deny: "0" });
  }
  return { text, voice };
}

// The bot's own overwrite on a category. It is the category's only granted member until the
// owner is added, so the bot can create the rooms that go under it.
export function botOverwrites(botId: string): Overwrite[] {
  return [{ id: botId, type: 1, allow: perms(BOT_CATEGORY_ALLOW), deny: "0" }];
}

// A space only counts as built once both rooms exist. A record created before the channels
// were made (a failed build) is repaired rather than reported as an existing space.
export function isBuilt(space: { textChannelId: string | null; voiceChannelId: string | null }): boolean {
  return space.textChannelId !== null && space.voiceChannelId !== null;
}

export function isOwner(state: SpaceState, userId: string): boolean {
  return state.ownerId === userId;
}

export function isMember(state: SpaceState, userId: string): boolean {
  return state.ownerId === userId || state.buddies.some((buddy) => buddy.userId === userId);
}

export function addBuddy(
  state: SpaceState,
  member: SpaceMember,
): { ok: true; state: SpaceState } | { ok: false; reason: string } {
  if (member.userId === state.ownerId) return { ok: false, reason: "That's you." };
  if (state.buddies.some((buddy) => buddy.userId === member.userId)) {
    return { ok: false, reason: `${member.displayName} is already in your space.` };
  }
  if (state.buddies.length >= MAX_BUDDIES) {
    return { ok: false, reason: `A space holds up to ${MAX_BUDDIES} buddies.` };
  }
  return { ok: true, state: { ...state, buddies: [...state.buddies, member] } };
}

export function removeBuddy(
  state: SpaceState,
  userId: string,
): { ok: true; state: SpaceState; removed: SpaceMember | null } {
  const removed = state.buddies.find((buddy) => buddy.userId === userId) ?? null;
  return {
    ok: true,
    removed,
    state: { ...state, buddies: state.buddies.filter((buddy) => buddy.userId !== userId) },
  };
}

export function startFocus(
  state: SpaceState,
  args: { starterId: string; starterName: string; minutes: number; goal?: string; now: number },
): { ok: true; state: SpaceState; session: FocusSession } | { ok: false; reason: string } {
  if (!(FOCUS_MINUTES as readonly number[]).includes(args.minutes)) {
    return { ok: false, reason: `Focus sessions are ${FOCUS_MINUTES.join(", ")} minutes.` };
  }
  if (!isMember(state, args.starterId)) {
    return { ok: false, reason: "Only people in this space can start a timer here." };
  }
  if (state.focus !== null && state.focus.endsAt > args.now) {
    return { ok: false, reason: "A timer is already running here." };
  }

  const session: FocusSession = {
    starterId: args.starterId,
    starterName: args.starterName,
    minutes: args.minutes,
    startedAt: args.now,
    endsAt: args.now + args.minutes * 60,
  };
  if (args.goal !== undefined && args.goal.trim().length > 0) session.goal = args.goal.trim();

  return { ok: true, session, state: { ...state, focus: session, updatedAt: args.now } };
}

export function canControlFocus(state: SpaceState, userId: string): boolean {
  // The starter controls their own timer; the owner can always clear a stuck one.
  return state.focus !== null && (state.focus.starterId === userId || isOwner(state, userId));
}

export function cancelFocus(
  state: SpaceState,
  userId: string,
  now: number,
): { ok: true; state: SpaceState } | { ok: false; reason: string } {
  if (state.focus === null) return { ok: false, reason: "No timer is running." };
  if (!canControlFocus(state, userId)) {
    return { ok: false, reason: "Only the person who started this timer can cancel it." };
  }
  return { ok: true, state: { ...state, focus: null, updatedAt: now } };
}

export function extendFocus(
  state: SpaceState,
  userId: string,
  minutes: number,
  now: number,
): { ok: true; state: SpaceState; session: FocusSession } | { ok: false; reason: string } {
  if (state.focus === null) return { ok: false, reason: "No timer is running." };
  if (!canControlFocus(state, userId)) {
    return { ok: false, reason: "Only the person who started this timer can extend it." };
  }
  const add = minutes === 5 || minutes === 10 ? minutes : null;
  if (add === null) return { ok: false, reason: "Extend by 5 or 10 minutes." };

  const session: FocusSession = {
    ...state.focus,
    minutes: state.focus.minutes + add,
    endsAt: state.focus.endsAt + add * 60,
  };
  return { ok: true, session, state: { ...state, focus: session, updatedAt: now } };
}

export function startBreak(
  state: SpaceState,
  userId: string,
  now: number,
  breakMinutes = 5,
): { ok: true; state: SpaceState; breakUntil: number } | { ok: false; reason: string } {
  if (!isMember(state, userId)) return { ok: false, reason: "Only people in this space can take a break here." };
  if (state.busy) return { ok: false, reason: "A break is already running." };
  const breakUntil = now + breakMinutes * 60;
  return {
    ok: true,
    breakUntil,
    state: { ...state, focus: null, busy: true, breakUntil, updatedAt: now },
  };
}

export function isIdle(state: SpaceState, now: number): boolean {
  const focusDone = state.focus === null || state.focus.endsAt <= now;
  const breakDone = !state.busy || state.breakUntil === null || state.breakUntil <= now;
  return focusDone && breakDone;
}

// The single live status message. Edited in place, never re-posted, so the space does not
// turn into a feed. Times are Discord timestamps so each viewer sees their own zone.
export function statusContent(state: SpaceState, now: number): string {
  if (state.focus !== null && state.focus.endsAt > now) {
    const who = `<@${state.focus.starterId}>`;
    const goal = state.focus.goal !== undefined ? ` on "${oneLine(state.focus.goal)}"` : "";
    return [
      `**Focusing now**: ${who}${goal}`,
      `Started ${state.focus.minutes} minutes, ends ${istTimeText(state.focus.endsAt)} (${relativeText(state.focus.endsAt, now)}).`,
    ].join("\n");
  }

  if (state.busy && state.breakUntil !== null && state.breakUntil > now) {
    return `**On a break** until ${istTimeText(state.breakUntil)} (${relativeText(state.breakUntil, now)}).`;
  }

  const buddies = state.buddies.length;
  const people = buddies === 0 ? "Just you here" : `${buddies + 1} people in this space`;
  return `**Everyone's free.** ${people}. Start a timer with /focus when you're ready.`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd();
}

// Every message the space posts mentions only the people it must, never @everyone.
export function statusMentions(state: SpaceState, now: number): { parse: []; users: string[] } {
  if (state.focus !== null && state.focus.endsAt > now) {
    return { parse: [], users: [state.focus.starterId] };
  }
  return { parse: [], users: [] };
}
