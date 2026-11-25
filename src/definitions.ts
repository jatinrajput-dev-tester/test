// Command definitions, launch time and links.
// Shared by the Worker (src/index.ts) and scripts/register-commands.ts.
// No network access, no clock. Keep it importable from plain Node.

export const LINKS = {
  waitlist: "https://hatchh.io",
  docs: "https://docs.hatchh.io",
  app: "https://app.hatchh.io",
} as const;

import { fromIst } from "./time.js";

// Beta opens 30 November 2026, 6:00 PM IST. Built from the IST wall clock, not by doing
// the offset arithmetic by hand.
export const LAUNCH_TIME = fromIst(2026, 11, 30, 18, 0);

export const FOCUS_MINUTES = [25, 50, 90] as const;
export type FocusMinutes = (typeof FOCUS_MINUTES)[number];

export const GOAL_MAX_LENGTH = 200;

export const COMMAND_NAMES = ["focus", "launch", "waitlist", "hatch"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

// Discord application command option types.
export const OPTION_TYPE = {
  STRING: 3,
  INTEGER: 4,
  SUB_COMMAND: 1,
} as const;

export const MEMORY_KIND_CHOICES = [
  { name: "goal", value: "goal" },
  { name: "preference", value: "preference" },
  { name: "buddy", value: "buddy" },
  { name: "language", value: "language" },
  { name: "note", value: "note" },
] as const;

export const definitions = [
  {
    name: "focus",
    description: "Start a focus timer in this channel.",
    options: [
      {
        type: OPTION_TYPE.INTEGER,
        name: "minutes",
        description: "How long to focus.",
        required: true,
        choices: FOCUS_MINUTES.map((value) => ({ name: `${value} minutes`, value })),
      },
      {
        type: OPTION_TYPE.STRING,
        name: "goal",
        description: "What you're working on. Optional.",
        required: false,
        max_length: GOAL_MAX_LENGTH,
      },
    ],
  },
  {
    name: "launch",
    description: "Countdown to the Hatch beta.",
    options: [],
  },
  {
    name: "waitlist",
    description: "Links to Hatch and the help docs.",
    options: [],
  },
  {
    name: "hatch",
    description: "Ask Hatch, or manage your space and memory.",
    options: [
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "ask",
        description: "Ask anything about Hatch.",
        options: [
          {
            type: OPTION_TYPE.STRING,
            name: "question",
            description: "What do you want to know?",
            required: true,
            max_length: 500,
          },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "space",
        description: "Create your private buddy space.",
        options: [
          {
            type: OPTION_TYPE.STRING,
            name: "name",
            description: "What to call it. Defaults to <your name>'s friends.",
            required: false,
            max_length: 60,
          },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "add",
        description: "Add a buddy to your space.",
        options: [
          {
            type: 6, // USER
            name: "buddy",
            description: "Who to add.",
            required: true,
          },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "remove",
        description: "Remove a buddy from your space.",
        options: [
          {
            type: 6,
            name: "buddy",
            description: "Who to remove.",
            required: true,
          },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "remember",
        description: "Ask Hatch to remember something about you.",
        options: [
          {
            type: OPTION_TYPE.STRING,
            name: "fact",
            description: "What to remember.",
            required: true,
            max_length: 160,
          },
          {
            type: OPTION_TYPE.STRING,
            name: "kind",
            description: "What kind of thing this is.",
            required: false,
            choices: MEMORY_KIND_CHOICES,
          },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "memory",
        description: "See what Hatch remembers about you.",
        options: [],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "forget",
        description: "Forget something, or everything.",
        options: [
          {
            type: OPTION_TYPE.STRING,
            name: "fact",
            description: "Leave empty to forget everything.",
            required: false,
            max_length: 160,
          },
        ],
      },
      {
        type: OPTION_TYPE.SUB_COMMAND,
        name: "usage",
        description: "How many Ask Hatch questions you have left.",
        options: [],
      },
    ],
  },
] as const;

export function isKnownCommand(name: string): name is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(name);
}
