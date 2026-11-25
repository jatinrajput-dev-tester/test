// The /hatch command: what each subcommand asks the caller to do.
// This module is pure — it says what to show and which DO call to make. src/index.ts
// performs the calls. Every reply is ephemeral: memory, usage and previews are personal.

import {
  previewSpaceReply,
  memoryForgetComponent,
  type DiscordOption,
  stringOption,
  findOption,
  buddyButtonId,
} from "./interactions.js";
import { SUPPORT_LINKS } from "./knowledge.js";
import { MAX_TEXT_LENGTH } from "./memory.js";
import type { InteractionReply } from "./commands.js";

export type HatchPlan =
  | { sub: "ask"; question: string }
  | { sub: "ask_empty" }
  | { sub: "space"; name: string | null }
  | { sub: "add"; targetId: string; targetName: string }
  | { sub: "remove"; targetId: string; targetName: string }
  | { sub: "no_target" }
  | { sub: "remember"; fact: string; kind: string }
  | { sub: "memory" }
  | { sub: "forget"; text: string | null }
  | { sub: "usage" }
  | { sub: "unknown"; name: string };

// The subcommand name is the first option with a nested `options` array.
export function subcommand(options: readonly DiscordOption[] | undefined): string | null {
  if (options === undefined) return null;
  for (const option of options) {
    if (option.name !== "question" && option.options !== undefined) return option.name;
  }
  return null;
}

export function planHatch(options: readonly DiscordOption[] | undefined): HatchPlan {
  const name = subcommand(options);
  if (name === null) return { sub: "unknown", name: "" };

  switch (name) {
    case "ask": {
      const question = stringOption(options, "question");
      if (question === null || question.trim().length === 0) return { sub: "ask_empty" };
      return { sub: "ask", question: question.trim().slice(0, 500) };
    }
    case "space": {
      const given = stringOption(options, "name");
      return { sub: "space", name: given !== null && given.trim().length > 0 ? given.trim() : null };
    }
    case "add":
    case "remove": {
      const targetId = findOption(options, "buddy");
      if (typeof targetId !== "string") return { sub: "no_target" };
      return { sub: name === "add" ? "add" : "remove", targetId, targetName: "" };
    }
    case "remember": {
      const fact = stringOption(options, "fact");
      if (fact === null || fact.trim().length === 0) return { sub: "ask_empty" };
      const kind = stringOption(options, "kind") ?? "note";
      // The model never picks what gets remembered; the person does, and it is capped.
      return { sub: "remember", fact: fact.trim().slice(0, MAX_TEXT_LENGTH), kind };
    }
    case "memory":
      return { sub: "memory" };
    case "forget": {
      const text = stringOption(options, "fact");
      return { sub: "forget", text: text !== null && text.trim().length > 0 ? text.trim() : null };
    }
    case "usage":
      return { sub: "usage" };
    default:
      return { sub: "unknown", name };
  }
}

export const ASK_PLACEHOLDER = "One moment — reading what Hatch knows.";

export function emptyQuestionReply(): InteractionReply {
  return {
    content: "Ask me something about Hatch, like `/hatch ask question: how do pods work?`",
    allowedMentions: { parse: [] },
    ephemeral: true,
  };
}

export function noTargetReply(action: "add" | "remove"): InteractionReply {
  return {
    content:
      action === "add"
        ? "Pick who to add: `/hatch add buddy:@name`."
        : "Pick who to remove: `/hatch remove buddy:@name`.",
    allowedMentions: { parse: [] },
    ephemeral: true,
  };
}

export function spaceConfirmReply(spaceName: string) {
  return previewSpaceReply(spaceName);
}

// Shown when a space already exists — one space per person keeps the model simple and safe.
export function spaceExistsReply(): InteractionReply {
  return {
    content:
      "You already have a space. I can add or remove buddies in it, but there is one space per person for now.",
    allowedMentions: { parse: [] },
    ephemeral: true,
  };
}

export function memoryReply(summary: string): {
  content: string;
  allowedMentions: { parse: [] };
  ephemeral: true;
  components: ReturnType<typeof memoryForgetComponent> | undefined;
} {
  const hasAnything = !summary.startsWith("I'm not remembering anything");
  return {
    content: summary,
    allowedMentions: { parse: [] },
    ephemeral: true,
    components: hasAnything ? memoryForgetComponent() : undefined,
  };
}

export function buildSpaceButton(
  ownerId: string,
  userId: string,
  kind: "add" | "remove",
  targetName: string,
): unknown[] {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: kind === "add" ? 3 : 4,
          label: kind === "add" ? `Add ${targetName}` : `Remove ${targetName}`,
          custom_id: buddyButtonId(kind, ownerId, userId),
        },
      ],
    },
  ];
}

export function usageReply(remainingHour: number, remainingDay: number): InteractionReply {
  return {
    content: `Ask Hatch: ${remainingHour} questions left this hour, ${remainingDay} left today.`,
    allowedMentions: { parse: [] },
    ephemeral: true,
  };
}

export function askFailedReply(reason: string): InteractionReply {
  const tail =
    reason === "timeout"
      ? "That took too long. Try again in a moment."
      : reason === "unauthorized"
        ? "I can't reach my assistant right now."
        : "Something went wrong on my side. Try again in a moment.";
  return {
    content: `${tail} You can also read the help docs: ${SUPPORT_LINKS.docs}`,
    allowedMentions: { parse: [] },
    ephemeral: true,
  };
}

export function unknownSubReply(name: string): InteractionReply {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return {
    content: safe.length > 0 ? `I don't know \`${safe}\` yet.` : "I don't know that one yet.",
    allowedMentions: { parse: [] },
    ephemeral: true,
  };
}

// Answer posted publicly in the channel, so a whole pod can read it. The question is the
// person's own text, so mentions stay off and the answer is never attributed to @everyone.
// The answer is public in the channel: whoever asked, a whole pod can read it and not
// ask twice. Only the asker is mentioned, and their question text stays inert.
export function answerContent(askerId: string, question: string, answer: string): {
  content: string;
  allowedMentions: { parse: []; users: string[] };
  ephemeral: false;
} {
  const clipped = question.length > 200 ? `${question.slice(0, 200).trimEnd()}…` : question;
  return {
    content: `<@${askerId}> asked: ${clipped}\n\n${answer}`,
    allowedMentions: { parse: [], users: [askerId] },
    ephemeral: false,
  };
}
