// Interaction payloads and component ids: the parts that are pure and worth testing.
// src/index.ts turns these into HTTP responses.

export const INTERACTION = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

export const RESPONSE = {
  PONG: 1,
  MESSAGE: 4,
  DEFERRED_MESSAGE: 5,
} as const;

export const EPHEMERAL_FLAG = 64;

export type DiscordOption = {
  name: string;
  value?: unknown;
  options?: DiscordOption[];
};

// Subcommand parameters arrive under the subcommand ("ask"), not the top level.
export function findOption(options: readonly DiscordOption[] | undefined, name: string): unknown {
  if (options === undefined) return undefined;
  for (const option of options) {
    if (option.name === name) return option.value;
    if (option.options !== undefined) {
      const nested = findOption(option.options, name);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

export function stringOption(options: readonly DiscordOption[] | undefined, name: string): string | null {
  const value = findOption(options, name);
  return typeof value === "string" ? value : null;
}

export function numberOption(options: readonly DiscordOption[] | undefined, name: string): number | null {
  const value = findOption(options, name);
  return typeof value === "number" ? value : null;
}

// Component ids are a small closed vocabulary. Everything the bot will act on must be one
// of these, built from snowflakes only, so a forged id cannot reach the server.
export type ComponentKind =
  | "space:create" | "space:cancel"
  | "buddy:add" | "buddy:remove"
  | "mem:forgetAll"
  | "focus:cancel" | "focus:extend5" | "focus:extend10"
  | "focus:break";

const SIMPLE_IDS: Record<string, ComponentKind> = {
  "space:create": "space:create",
  "space:cancel": "space:cancel",
  "mem:forgetAll": "mem:forgetAll",
  "focus:cancel": "focus:cancel",
  "focus:extend5": "focus:extend5",
  "focus:extend10": "focus:extend10",
  "focus:break": "focus:break",
};

export type ParsedComponent = {
  kind: ComponentKind;
  targetId: string | null;
  requesterId: string | null;
};

export function parseComponentId(id: string): ParsedComponent | null {
  const simple = SIMPLE_IDS[id];
  if (simple !== undefined) return { kind: simple, targetId: null, requesterId: null };

  const [head, owner, second] = id.split(":");
  if (head === "buddy" && (owner === "add" || owner === "remove") && typeof second === "string") {
    const [requesterId, targetId] = second.split(".");
    if (isSnowflakeLike(requesterId) && isSnowflakeLike(targetId)) {
      return { kind: owner === "add" ? "buddy:add" : "buddy:remove", requesterId, targetId };
    }
  }
  return null;
}

export function buddyButtonId(action: "add" | "remove", requesterId: string, targetId: string): string {
  return `buddy:${action}:${requesterId}.${targetId}`;
}

export function isSnowflakeLike(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9]{17,20}$/.test(value);
}

// Confirmation card for anything that changes the server. Nothing happens until the
// person presses Create; Cancel is a plain "no".
export function previewSpaceReply(spaceName: string): {
  content: string;
  allowedMentions: { parse: [] };
  ephemeral: true;
  components: Array<{ type: 1; components: Array<{ type: 2; style: number; label: string; custom_id: string }> }>;
} {
  return {
    content: [
      "Here's what I'll build:",
      "",
      `**${spaceName}** — a private category with`,
      "• a text channel for chat and timers",
      "• a voice room called Focus",
      "",
      "Only you and the buddies you add can see it. Nothing is created until you press Create.",
    ].join("\n"),
    allowedMentions: { parse: [] },
    ephemeral: true,
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: "Create", custom_id: "space:create" },
          { type: 2, style: 4, label: "Cancel", custom_id: "space:cancel" },
        ],
      },
    ],
  };
}

export function focusControlComponents(): Array<{
  type: 1;
  components: Array<{ type: 2; style: number; label: string; custom_id: string }>;
}> {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "Cancel", custom_id: "focus:cancel" },
        { type: 2, style: 2, label: "+5 min", custom_id: "focus:extend5" },
        { type: 2, style: 2, label: "+10 min", custom_id: "focus:extend10" },
        { type: 2, style: 2, label: "Break", custom_id: "focus:break" },
      ],
    },
  ];
}

export function memoryForgetComponent(): Array<{
  type: 1;
  components: Array<{ type: 2; style: number; label: string; custom_id: string }>;
}> {
  return [
    {
      type: 1,
      components: [{ type: 2, style: 4, label: "Forget everything", custom_id: "mem:forgetAll" }],
    },
  ];
}
