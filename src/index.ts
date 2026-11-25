// Worker entry point: Discord interactions, /focus timers, and the daily check-in.
// This is the side-effect layer. The clock and every network call live here; the rules
// live in the pure modules (commands, checkin, hatch, memory, ratelimit, space).

import { verifyDiscordRequest } from "./verify.js";
import { dispatch } from "./commands.js";
import type { InteractionReply, FocusResult } from "./commands.js";
import { promptForDate, threadNameForDate, isCheckinConfigured } from "./checkin.js";
import {
  postMessage,
  editMessage,
  createThread,
  createChannel,
  editChannelPermissions,
} from "./discord.js";
import type { Env } from "./env.js";
import {
  planHatch,
  emptyQuestionReply,
  noTargetReply,
  spaceConfirmReply,
  spaceExistsReply,
  memoryReply,
  usageReply,
  askFailedReply,
  unknownSubReply,
  answerContent,
  buildSpaceButton,
  ASK_PLACEHOLDER,
  type HatchPlan,
} from "./hatch.js";
import { askHatch } from "./ai.js";
import { limitMessage } from "./ratelimit.js";
import { summarizeMemory, MAX_TEXT_LENGTH } from "./memory.js";
import {
  planSpace,
  buildOverwrites,
  botOverwrites,
  statusContent,
  statusMentions,
  isBuilt,
  type SpaceState,
} from "./space.js";
import { istDateKey } from "./time.js";
import type { SpaceView, SpaceResult } from "./space-store.js";
import {
  INTERACTION,
  RESPONSE,
  EPHEMERAL_FLAG,
  findOption,
  parseComponentId,
  isSnowflakeLike,
} from "./interactions.js";
import { spaceName as spaceNameFor } from "./space.js";

export { FocusTimer } from "./timer.js";
export { MemoryStore } from "./memory-store.js";
export { UsageStore } from "./usage-store.js";
export { SpaceStore } from "./space-store.js";

interface DiscordInteraction {
  id: string;
  type: number;
  // The follow-up webhook is addressed by this token, not by the interaction id.
  token?: string;
  channel_id?: string;
  guild_id?: string;
  data?: {
    name?: string;
    options?: Array<{
      name: string;
      value?: unknown;
      options?: Array<{ name: string; value?: unknown }>;
    }>;
    custom_id?: string;
  };
  member?: { user?: DiscordUser };
  user?: DiscordUser;
}

type DiscordUser = { id?: string; username?: string; global_name?: string | null };

type Person = { id: string; name: string };

type Reply = InteractionReply & { components?: unknown[] };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/interactions") {
      return new Response("", { status: 404 });
    }

    const verified = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
    if (!verified.ok) return new Response("", { status: verified.status });

    let parsed: unknown;
    try {
      parsed = JSON.parse(verified.body);
    } catch {
      return new Response("", { status: 400 });
    }
    if (typeof parsed !== "object" || parsed === null) return new Response("", { status: 400 });
    const interaction = parsed as DiscordInteraction;

    if (interaction.type === INTERACTION.PING) return json({ type: RESPONSE.PONG });

    const person = readPerson(interaction);
    if (person === null) return new Response("", { status: 400 });
    const now = Math.floor(Date.now() / 1000);

    if (interaction.type === INTERACTION.APPLICATION_COMMAND) {
      return handleCommand(interaction, person, env, ctx, now);
    }
    if (interaction.type === INTERACTION.MESSAGE_COMPONENT) {
      return handleComponent(interaction, person, env, ctx, now);
    }
    return new Response("", { status: 400 });
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!isCheckinConfigured(env.GOALS_CHANNEL_ID)) return;

    const dateKey = istDateKey(Date.now());
    const response = await postMessage(env.DISCORD_BOT_TOKEN, env.GOALS_CHANNEL_ID, {
      content: promptForDate(dateKey),
      allowed_mentions: { parse: [] },
    });

    if (response.status >= 500) throw new Error(`check-in post failed with ${response.status}`);
    if (!response.ok) {
      console.error(`check-in post rejected with ${response.status}`);
      return;
    }

    const messageId = await messageIdFrom(response);
    if (messageId === null) {
      console.error("check-in prompt posted without a message id; skipping thread");
      return;
    }

    try {
      const thread = await createThread(
        env.DISCORD_BOT_TOKEN,
        env.GOALS_CHANNEL_ID,
        messageId,
        threadNameForDate(dateKey),
      );
      if (!thread.ok) console.error(`check-in thread rejected with ${thread.status}`);
    } catch (err) {
      // The prompt is already posted; a second run would double-post it.
      console.error("check-in thread failed", errorMessage(err));
    }
  },
};

// ---------------------------------------------------------------- commands

async function handleCommand(
  interaction: DiscordInteraction,
  person: Person,
  env: Env,
  ctx: ExecutionContext,
  now: number,
): Promise<Response> {
  const name = interaction.data?.name ?? "";
  const options = interaction.data?.options;

  if (name === "hatch") {
    const plan = planHatch(options);
    if (plan.sub === "ask") {
      // The only slow path. Discord gives 3 seconds; a defer buys 15 minutes.
      ctx.waitUntil(answerQuestion(interaction, person, env, plan.question, now));
      return json({ type: RESPONSE.DEFERRED_MESSAGE, data: { flags: EPHEMERAL_FLAG } });
    }
    return plain(await handleHatchImmediate(interaction, person, env, plan, now));
  }

  const minutesRaw = findOption(options, "minutes");
  const goalRaw = findOption(options, "goal");
  const minutes = typeof minutesRaw === "number" ? minutesRaw : null;
  const goal = typeof goalRaw === "string" ? goalRaw : null;

  const result = dispatch({
    commandName: name,
    userId: person.id,
    now,
    roleId: env.SESSION_PINGS_ROLE_ID,
    minutes,
    goal,
  });

  if (result.kind === "reply") return plain(result.reply);
  return focusResponse(result.result, {
    interactionId: interaction.id,
    channelId: interaction.channel_id,
    userId: person.id,
    minutes,
    goal,
    env,
    ctx,
  });
}

async function handleHatchImmediate(
  interaction: DiscordInteraction,
  person: Person,
  env: Env,
  plan: HatchPlan,
  now: number,
): Promise<Reply> {
  switch (plan.sub) {
    case "ask_empty":
      return emptyQuestionReply();

    case "unknown":
      return unknownSubReply(plan.name);

    case "no_target":
      return noTargetReply("add");

    case "space": {
      const existing = await spaceCall(env, person.id, "/get", { ownerId: person.id });
      if (existing?.space != null && isBuilt(existing.space)) return spaceExistsReply();
      return spaceConfirmReply(plan.name ?? planSpace(person.name).catalogName);
    }

    case "add":
    case "remove": {
      const space = await spaceCall(env, person.id, "/get", { ownerId: person.id });
      if (space?.space == null) return noSpaceReply();
      if (space.space.ownerId !== person.id) {
        return { content: "Only the owner can change buddies.", allowedMentions: { parse: [] }, ephemeral: true };
      }
      const targetName = plan.targetId.slice(-4);
      return {
        content:
          plan.sub === "add"
            ? `Add <@${plan.targetId}> to your space? Press the button to confirm.`
            : `Remove <@${plan.targetId}> from your space? Press the button to confirm.`,
        allowedMentions: { parse: [], users: [plan.targetId] },
        ephemeral: true,
        components: buildSpaceButton(person.id, plan.targetId, plan.sub, targetName),
      };
    }

    case "remember": {
      const result = await memoryCall(env, person.id, "/remember", {
        userId: person.id,
        kind: plan.kind,
        text: plan.fact.slice(0, MAX_TEXT_LENGTH),
      });
      if (result?.error !== undefined) {
        return { content: result.error, allowedMentions: { parse: [] }, ephemeral: true };
      }
      return {
        content: result?.replaced === true
          ? "I already knew that; it's unchanged."
          : "Saved. See it any time with `/hatch memory`.",
        allowedMentions: { parse: [] },
        ephemeral: true,
      };
    }

    case "memory": {
      const result = await memoryCall(env, person.id, "/get", { userId: person.id });
      const summary = result?.summary ?? summarizeMemory({ userId: person.id, entries: [], updatedAt: now });
      return memoryReply(summary);
    }

    case "forget": {
      if (plan.text === null) {
        return {
          content: "This forgets everything I remember about you. Press the button to confirm.",
          allowedMentions: { parse: [] },
          ephemeral: true,
          components: [
            {
              type: 1,
              components: [{ type: 2, style: 4, label: "Forget everything", custom_id: "mem:forgetAll" }],
            },
          ],
        };
      }
      const result = await memoryCall(env, person.id, "/forget", { userId: person.id, text: plan.text });
      const removed = result?.removed ?? 0;
      return {
        content: removed > 0 ? `Forgot it. ${removed} entry removed.` : "I wasn't remembering anything like that.",
        allowedMentions: { parse: [] },
        ephemeral: true,
      };
    }

    case "usage": {
      const peek = await post<{ remainingHour?: number; remainingDay?: number }>(
        stub(env, env.USAGE, `usage:${person.id}`),
        "/peek",
        { userId: person.id },
      );
      return usageReply(peek?.remainingHour ?? 20, peek?.remainingDay ?? 80);
    }

    default:
      return unknownSubReply("");
  }
}

// ---------------------------------------------------------------- /hatch ask

async function answerQuestion(
  interaction: DiscordInteraction,
  person: Person,
  env: Env,
  question: string,
  now: number,
): Promise<void> {
  const send = (reply: Reply) => followUp(env, interaction, reply);

  try {
    const check = await post<{
      allowed?: boolean;
      reason?: "hour" | "day";
      retryAfterSeconds?: number;
    }>(stub(env, env.USAGE, `usage:${person.id}`), "/check", { userId: person.id });

    if (check !== null && check.allowed === false && check.reason !== undefined) {
      await send({ content: limitMessage(check.reason, check.retryAfterSeconds ?? 60, now), allowedMentions: { parse: [] }, ephemeral: true });
      return;
    }

    const memoryText = await memoryPrompt(env, person.id);
    const answer = await askHatch({
      baseUrl: env.AI_BASE_URL,
      apiKey: env.AI_API_KEY,
      question,
      history: memoryText === null ? [] : [{ role: "system", content: memoryText }],
    });

    if (!answer.ok) {
      await send(askFailedReply(answer.reason));
      return;
    }

    // Quota is spent only when an answer actually came back.
    await post(stub(env, env.USAGE, `usage:${person.id}`), "/record", { userId: person.id });
    await send(answerContent(person.id, question, answer.answer));
  } catch (err) {
    console.error("ask failed", errorMessage(err));
    await send(askFailedReply("upstream"));
  }
}

// ---------------------------------------------------------------- buttons

async function handleComponent(
  interaction: DiscordInteraction,
  person: Person,
  env: Env,
  ctx: ExecutionContext,
  now: number,
): Promise<Response> {
  const parsed = parseComponentId(interaction.data?.custom_id ?? "");
  if (parsed === null) return plain(staleButton());

  switch (parsed.kind) {
    case "space:create":
      ctx.waitUntil(buildSpace(interaction, person, env, now));
      return json({ type: RESPONSE.DEFERRED_MESSAGE, data: { flags: EPHEMERAL_FLAG } });

    case "space:cancel":
      return plain({ content: "Nothing was created.", allowedMentions: { parse: [] }, ephemeral: true });

    case "buddy:add":
    case "buddy:remove": {
      // The requester is baked into the id, so a forwarded or forged button cannot be used
      // by someone else, and only the owner can change their own space.
      if (parsed.requesterId !== person.id) {
        return plain({ content: "Only the person who asked can press this.", allowedMentions: { parse: [] }, ephemeral: true });
      }
      const current = await spaceCall(env, person.id, "/get", { ownerId: person.id });
      if (current?.space == null) return plain(noSpaceReply());
      if (current.space.ownerId !== person.id) {
        return plain({ content: "Only the owner can change buddies.", allowedMentions: { parse: [] }, ephemeral: true });
      }

      const targetId = parsed.targetId;
      if (targetId === null) return plain(staleButton());

      if (parsed.kind === "buddy:add") {
        const added = await spaceCall(env, person.id, "/addBuddy", {
          ownerId: person.id,
          member: { userId: targetId, displayName: targetId.slice(-4) },
        });
        if (added?.error !== undefined) {
          return plain({ content: added.error, allowedMentions: { parse: [] }, ephemeral: true });
        }
        if (added?.space !== undefined) await grantAccess(env, added.space, targetId, interaction.guild_id ?? env.GUILD_ID);
        return plain({
          content: `Added <@${targetId}> to your space.`,
          allowedMentions: { parse: [], users: [targetId] },
          ephemeral: true,
        });
      }

      const removed = await spaceCall(env, person.id, "/removeBuddy", {
        ownerId: person.id,
        userId: targetId,
      });
      if (removed?.error !== undefined) {
        return plain({ content: removed.error, allowedMentions: { parse: [] }, ephemeral: true });
      }
      if (removed?.space !== undefined) await revokeAccess(env, removed.space, targetId);
      return plain({
        content: `Removed <@${targetId}> from your space.`,
        allowedMentions: { parse: [], users: [targetId] },
        ephemeral: true,
      });
    }

    case "mem:forgetAll":
      await memoryCall(env, person.id, "/forgetAll", { userId: person.id });
      return plain({ content: "I'm not remembering anything about you now.", allowedMentions: { parse: [] }, ephemeral: true });

    case "focus:cancel":
    case "focus:extend5":
    case "focus:extend10":
    case "focus:break": {
      const channelId = interaction.channel_id;

      if (parsed.kind === "focus:break") {
        const result = await spaceCall(env, person.id, "/break", { ownerId: person.id, userId: person.id });
        if (result?.error !== undefined) return plain({ content: result.error, allowedMentions: { parse: [] }, ephemeral: true });
        if (result?.space !== undefined) await refreshStatus(env, result.space);
        return plain({ content: "Break started, 5 minutes.", allowedMentions: { parse: [] }, ephemeral: true });
      }

      const path = parsed.kind === "focus:cancel" ? "/cancelFocus" : "/extendFocus";
      const minutes = parsed.kind === "focus:extend10" ? 10 : 5;
      const result = await spaceCall(env, person.id, path, { ownerId: person.id, userId: person.id, minutes });
      if (result?.error !== undefined) return plain({ content: result.error, allowedMentions: { parse: [] }, ephemeral: true });
      if (result?.space !== undefined) await refreshStatus(env, result.space);
      return plain({
        content: parsed.kind === "focus:cancel" ? "Timer cancelled." : `Extended by ${minutes} minutes.`,
        allowedMentions: { parse: [] },
        ephemeral: true,
      });
    }

    default:
      return plain(staleButton());
  }
}

// ---------------------------------------------------------------- building the space

async function buildSpace(
  interaction: DiscordInteraction,
  person: Person,
  env: Env,
  now: number,
): Promise<void> {
  const guildId = interaction.guild_id ?? env.GUILD_ID;
  const plan = planSpace(person.name);
  const send = (reply: Reply) => followUp(env, interaction, reply);

  const created = await spaceCall(env, person.id, "/create", {
    ownerId: person.id,
    spaceName: plan.catalogName,
  });
  if (created?.space == null) {
    await send({ content: "I couldn't start your space. Try again in a moment.", allowedMentions: { parse: [] }, ephemeral: true });
    return;
  }
  if (created.created === false && created.space != null && isBuilt(created.space)) {
    await send(spaceExistsReply());
    return;
  }
  // A record with no channels means an earlier build failed part-way. Carry on and finish it,
  // reusing a category left behind by the failed attempt rather than making a second one.
  const botId = env.DISCORD_APP_ID;
  let categoryId = created.space.categoryId;
  if (categoryId === null || !(await categoryStillExists(env, categoryId))) {
    // The category is invisible to @everyone; the owner is the only person who can see it
    // until buddies are added. Channel permission overwrites are the real access control.
    // The bot is granted too: it inherits the @everyone deny otherwise, and cannot then
    // create the rooms that go under this category.
    const category = await createChannel(env.DISCORD_BOT_TOKEN, guildId, {
      name: plan.catalogName,
      type: 4,
      permission_overwrites: [
        // @everyone is a role whose id is the guild id.
        { id: guildId, type: 0, allow: "0", deny: (BigInt(1) << BigInt(10)).toString() },
        { id: person.id, type: 1, allow: (BigInt(1) << BigInt(10)).toString(), deny: "0" },
        ...botOverwrites(botId),
      ],
    });
    if (!category.ok) {
      await send({
        content: "Discord wouldn't let me create the category. I need Manage Channels in this server.",
        allowedMentions: { parse: [] },
        ephemeral: true,
      });
      return;
    }
    categoryId = channelIdFrom(await category.json());
    if (categoryId === null) {
      await send({
        content: "Discord made the category but sent back something I couldn't read. Try again.",
        allowedMentions: { parse: [] },
        ephemeral: true,
      });
      return;
    }
  }

  const overwrites = buildOverwrites([person.id], guildId, botId);
  const text = await createChannel(env.DISCORD_BOT_TOKEN, guildId, {
    name: plan.textName,
    type: 0,
    parent_id: categoryId,
    topic: "Your private space. Start a timer with /focus.",
    permission_overwrites: overwrites.text,
  });
  const voice = await createChannel(env.DISCORD_BOT_TOKEN, guildId, {
    name: plan.voiceName,
    type: 2,
    parent_id: categoryId,
    permission_overwrites: overwrites.voice,
  });

  const textId = text.ok ? channelIdFrom(await text.json()) : null;
  const voiceId = voice.ok ? channelIdFrom(await voice.json()) : null;
  if (textId === null || voiceId === null) {
    await send({
      content: "I made the category but one of the rooms failed. Check Manage Channels and try again.",
      allowedMentions: { parse: [] },
      ephemeral: true,
    });
    return;
  }

  const saved = await spaceCall(env, person.id, "/channels", {
    ownerId: person.id,
    categoryId,
    textChannelId: textId,
    voiceChannelId: voiceId,
  });
  if (saved?.space === undefined) {
    await send({
      content: `I made <#${textId}> and <#${voiceId}>, but couldn't save them. Try \`/hatch space\` again to finish.`,
      allowedMentions: { parse: [] },
      ephemeral: true,
    });
    return;
  }
  const space = saved.space;

  // One live status message, edited in place from now on. Never re-posted.
  const status = await postMessage(env.DISCORD_BOT_TOKEN, textId, {
    content: "Setting up your space…",
    allowed_mentions: { parse: [] },
  });
  if (status.ok) {
    const statusId = await messageIdFrom(status);
    if (statusId !== null) {
      await spaceCall(env, person.id, "/statusMessage", { ownerId: person.id, statusMessageId: statusId });
      await editMessage(env.DISCORD_BOT_TOKEN, textId, statusId, {
        content: statusContent(toState(space, now), now),
        allowed_mentions: statusMentions(toState(space, now), now),
      });
    }
  }

  await send({
    content: `Built **${plan.catalogName}**: <#${textId}> and <#${voiceId}>. Add buddies with \`/hatch add\`.`,
    allowedMentions: { parse: [] },
    ephemeral: true,
  });
}

// ---------------------------------------------------------------- permission helpers

// A failed build can leave a category behind. Reusing it keeps a retried /hatch space from
// piling up orphans. An unreadable answer counts as gone, so the build makes a fresh one.
async function categoryStillExists(env: Env, categoryId: string): Promise<boolean> {
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${categoryId}`, {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    });
    return res.ok;
  } catch (err) {
    console.error("category lookup failed", errorMessage(err));
    return false;
  }
}

async function grantAccess(
  env: Env,
  space: { textChannelId: string | null; voiceChannelId: string | null },
  userId: string,
  guildId: string,
): Promise<void> {
  const overwrites = buildOverwrites([userId], guildId, env.DISCORD_APP_ID);
  // Only the new buddy is written here: the bot and owner rows already exist on the channel.
  const buddyRows = (rows: typeof overwrites.text) => rows.filter((row) => row.type === 1 && row.id === userId);
  if (space.textChannelId !== null) {
    for (const row of buddyRows(overwrites.text)) {
      await editChannelPermissions(env.DISCORD_BOT_TOKEN, space.textChannelId, row);
    }
  }
  if (space.voiceChannelId !== null) {
    for (const row of buddyRows(overwrites.voice)) {
      await editChannelPermissions(env.DISCORD_BOT_TOKEN, space.voiceChannelId, row);
    }
  }
}

async function revokeAccess(env: Env, space: { textChannelId: string | null; voiceChannelId: string | null }, userId: string): Promise<void> {
  const deny = { id: userId, type: 1 as const, allow: "0", deny: "0" };
  if (space.textChannelId !== null) await editChannelPermissions(env.DISCORD_BOT_TOKEN, space.textChannelId, deny);
  if (space.voiceChannelId !== null) await editChannelPermissions(env.DISCORD_BOT_TOKEN, space.voiceChannelId, deny);
}

async function refreshStatus(env: Env, space: SpaceView): Promise<void> {
  if (space.textChannelId === null || space.statusMessageId === null) return;
  const now = Math.floor(Date.now() / 1000);
  const state = toState(space, now);
  await editMessage(env.DISCORD_BOT_TOKEN, space.textChannelId, space.statusMessageId, {
    content: statusContent(state, now),
    allowed_mentions: statusMentions(state, now),
  });
}

// The DO returns a SpaceView; the space rules take a SpaceState. Only the status fields
// matter for rendering, so the rest are filled with inert values.
function toState(space: SpaceView, now: number): SpaceState {
  return {
    ownerId: space.ownerId,
    spaceName: space.spaceName,
    categoryId: space.categoryId,
    textChannelId: space.textChannelId,
    voiceChannelId: space.voiceChannelId,
    statusMessageId: space.statusMessageId,
    buddies: space.buddies,
    focus: space.focus,
    busy: space.busy,
    breakUntil: space.breakUntil,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------- Durable Object calls

function stub(env: Env, namespace: DurableObjectNamespace, name: string): DurableObjectStub {
  return namespace.get(namespace.idFromName(name));
}

async function post<T>(target: DurableObjectStub, path: string, body: unknown): Promise<T | null> {
  try {
    const response = await target.fetch(`https://do${path}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (response.status === 404) return null;
    return (await response.json()) as T;
  } catch (err) {
    console.error("durable object call failed", errorMessage(err));
    return null;
  }
}

// A space record has exactly one home. Creation and everything after it go to the same
// Durable Object, addressed by the same name, so the record written by /create is the one
// every later call reads.
function spaceCall(env: Env, ownerId: string, path: string, body: unknown) {
  return post<SpaceResult>(stub(env, env.SPACES, `space:${ownerId}`), path, body);
}

function memoryCall(
  env: Env,
  userId: string,
  path: string,
  body: unknown,
): Promise<{ summary?: string; removed?: number; replaced?: boolean; error?: string; text?: string } | null> {
  return post(stub(env, env.MEMORIES, `mem:${userId}`), path, body);
}

async function memoryPrompt(env: Env, userId: string): Promise<string | null> {
  const result = await memoryCall(env, userId, "/prompt", { userId });
  return typeof result?.text === "string" && result.text.length > 0 ? result.text : null;
}

// ---------------------------------------------------------------- responses

function plain(reply: Reply): Response {
  const data: Record<string, unknown> = {
    content: reply.content,
    allowed_mentions: reply.allowedMentions,
  };
  if (reply.ephemeral) data.flags = EPHEMERAL_FLAG;
  if (reply.components !== undefined) data.components = reply.components;
  return json({ type: RESPONSE.MESSAGE, data });
}

function staleButton(): Reply {
  return { content: "That button is out of date.", allowedMentions: { parse: [] }, ephemeral: true };
}

function noSpaceReply(): Reply {
  return {
    content: "You don't have a space yet. Make one with `/hatch space`.",
    allowedMentions: { parse: [] },
    ephemeral: true,
  };
}

interface FocusContext {
  interactionId: string;
  channelId: string | undefined;
  userId: string;
  minutes: number | null;
  goal: string | null;
  env: Env;
  ctx: ExecutionContext;
}

function focusResponse(result: FocusResult, context: FocusContext): Response {
  if (result.ok) scheduleFocusTimer(result.endsAt, context);
  return plain(result.reply);
}

function scheduleFocusTimer(endsAt: number, context: FocusContext): void {
  const { channelId, minutes, goal, userId, interactionId, env, ctx } = context;
  if (minutes === null || channelId === undefined) {
    console.error("focus timer skipped: missing minutes or channel id");
    return;
  }

  const start: Record<string, unknown> = { channelId, interactionId, starterId: userId, minutes, endsAt };
  if (goal !== null && goal.trim().length > 0) start.goal = goal;

  ctx.waitUntil(
    (async () => {
      try {
        const res = await stub(env, env.FOCUS_TIMERS, interactionId).fetch("https://do/start", {
          method: "POST",
          body: JSON.stringify(start),
        });
        if (!res.ok) console.error(`focus timer start failed with ${res.status}`);
      } catch (err) {
        console.error("focus timer start error", errorMessage(err));
      }
    })(),
  );
}

async function followUp(env: Env, interaction: DiscordInteraction, reply: Reply): Promise<void> {
  const token = interaction.token;
  if (token === undefined || token.length === 0) {
    console.error("follow-up skipped: interaction had no token");
    return;
  }
  const data: Record<string, unknown> = {
    content: reply.content,
    allowed_mentions: reply.allowedMentions,
  };
  if (reply.ephemeral) data.flags = EPHEMERAL_FLAG;
  if (reply.components !== undefined) data.components = reply.components;
  const res = await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APP_ID}/${token}`, {
    method: "POST",
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok && res.status !== 429) console.error(`follow-up rejected with ${res.status}`);
}

function readPerson(interaction: DiscordInteraction): Person | null {
  const user = interaction.member?.user ?? interaction.user;
  const id = user?.id;
  if (id === undefined || !isSnowflakeLike(id)) return null;
  const name = user?.global_name ?? user?.username ?? "you";
  return { id, name };
}

function channelIdFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}


async function messageIdFrom(response: Response): Promise<string | null> {
  try {
    const data: unknown = await response.json();
    if (typeof data === "object" && data !== null && "id" in data) {
      const id = (data as { id: unknown }).id;
      if (typeof id === "string") return id;
    }
  } catch {
    // Unparseable body: treat as no id.
  }
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

void spaceNameFor;
