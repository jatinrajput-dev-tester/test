// Pure command handlers: no clock, no network, no side effects.
// Every time value is passed in, and src/index.ts does the acting. The tests
// depend on this split (AGENTS.md §3, "Pure handlers").

import {
  FOCUS_MINUTES,
  GOAL_MAX_LENGTH,
  LAUNCH_TIME,
  LINKS,
  isKnownCommand,
  type FocusMinutes,
} from "./definitions.js";
import { istDateTimeText, istTimeText, relativeText } from "./time.js";

export type AllowedMentions =
  | { parse: [] }
  | { parse: []; roles: string[] }
  | { parse: []; users: string[] };

// A flat reply: content plus the mentions it is allowed to make. The caller
// (src/index.ts) wraps this into a Discord type-4 interaction response and maps
// `ephemeral` to flags: 64. Handlers always decide allowedMentions explicitly.
export type InteractionReply = {
  content: string;
  allowedMentions: AllowedMentions;
  ephemeral?: boolean;
};

export type FocusResult =
  | { ok: true; reply: InteractionReply; endsAt: number }
  | { ok: false; reply: InteractionReply };

export type DispatchResult =
  | { kind: "focus"; result: FocusResult }
  | { kind: "reply"; reply: InteractionReply };

function reply(
  content: string,
  allowedMentions: AllowedMentions,
  ephemeral = false,
): InteractionReply {
  const base: InteractionReply = { content, allowedMentions };
  return ephemeral ? { ...base, ephemeral: true } : base;
}

// A var left as PASTE_... (or empty) means the feature is unconfigured; it must
// degrade safely instead of pinging a role that does not exist.
function isConfiguredId(id: string): boolean {
  const value = id.trim();
  return value.length > 0 && !value.startsWith("PASTE_");
}

function isFocusMinutes(value: number): value is FocusMinutes {
  return (FOCUS_MINUTES as readonly number[]).includes(value);
}

function focusChoices(): string {
  const values = FOCUS_MINUTES.map((minutes) => String(minutes));
  const last = values.pop();
  const head = values.join(", ");
  if (last === undefined) return head;
  return head.length === 0 ? last : `${head} or ${last}`;
}

export function handleFocus(args: {
  userId: string;
  minutes: number;
  goal?: string;
  now: number; // unix seconds, injected
  roleId: string;
}): FocusResult {
  if (!isFocusMinutes(args.minutes)) {
    return {
      ok: false,
      reply: reply(
        `Focus sessions are ${focusChoices()} minutes. Pick one of those.`,
        { parse: [] },
        true,
      ),
    };
  }

  const goal = args.goal?.trim();
  if (goal !== undefined && goal.length > GOAL_MAX_LENGTH) {
    return {
      ok: false,
      reply: reply(
        `That goal is too long. Keep it under ${GOAL_MAX_LENGTH} characters.`,
        { parse: [] },
        true,
      ),
    };
  }

  const endsAt = args.now + args.minutes * 60;
  const mention = `<@${args.userId}>`;
  const roleConfigured = isConfiguredId(args.roleId);
  const roleId = args.roleId.trim();

  const lines: string[] = [
    roleConfigured
      ? `<@&${roleId}> ${mention} started a ${args.minutes}-minute focus session.`
      : `${mention} started a ${args.minutes}-minute focus session.`,
  ];
  if (goal !== undefined && goal.length > 0) {
    // User text stays data: allowedMentions below keeps any typed mention inert.
    lines.push(`Goal: ${goal}`);
  }
  lines.push(`Ends ${istTimeText(endsAt)} · ${relativeText(endsAt, args.now)}`);

  return {
    ok: true,
    endsAt,
    reply: reply(
      lines.join("\n"),
      roleConfigured ? { parse: [], roles: [roleId] } : { parse: [] },
    ),
  };
}

export function handleLaunch(args: { now: number }): InteractionReply {
  if (args.now < LAUNCH_TIME) {
    return reply(
      `The Hatch beta opens ${istDateTimeText(LAUNCH_TIME)}.\nJoin the waitlist: ${LINKS.waitlist}`,
      { parse: [] },
    );
  }
  return reply(
    `The Hatch beta is open. Head to ${LINKS.waitlist} to get started.`,
    { parse: [] },
  );
}

export function handleWaitlist(): InteractionReply {
  return reply(
    `Hatch: ${LINKS.waitlist}\nHelp docs: ${LINKS.docs}`,
    { parse: [] },
    true,
  );
}

export function handleUnknown(commandName: string): InteractionReply {
  // Strip everything a mention or markdown needs before echoing the name back.
  const safe = commandName.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const content =
    safe.length > 0
      ? `I don't know the \`${safe}\` command yet.`
      : "I don't know that command yet.";
  return reply(content, { parse: [] }, true);
}

export function dispatch(input: {
  commandName: string;
  userId: string;
  now: number;
  roleId: string;
  // Null is accepted because src/index.ts passes null when an option is absent.
  minutes?: number | null;
  goal?: string | null;
}): DispatchResult {
  if (!isKnownCommand(input.commandName)) {
    return { kind: "reply", reply: handleUnknown(input.commandName) };
  }

  switch (input.commandName) {
    case "focus":
      return {
        kind: "focus",
        result: handleFocus({
          userId: input.userId,
          // A missing minutes option falls through to the validation error.
          minutes: input.minutes ?? Number.NaN,
          ...(input.goal !== undefined && input.goal !== null
            ? { goal: input.goal }
            : {}),
          now: input.now,
          roleId: input.roleId,
        }),
      };
    case "launch":
      return { kind: "reply", reply: handleLaunch({ now: input.now }) };
    case "waitlist":
      return { kind: "reply", reply: handleWaitlist() };
    default:
      return { kind: "reply", reply: handleUnknown(input.commandName) };
  }
}
