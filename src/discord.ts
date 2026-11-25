// Small Discord REST helper (src/discord.ts). No SDK, no dependencies.

const API_BASE = "https://discord.com/api/v10";

export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{17,20}$/.test(value);
}

export type AllowedMentions = {
  parse?: ("roles" | "users" | "everyone")[];
  roles?: string[];
  users?: string[];
  replied_user?: boolean;
};

export type DiscordMessage = {
  content?: string;
  allowed_mentions: AllowedMentions;
  embeds?: unknown[];
  components?: unknown[];
  tts?: false;
};

// For channel/category creation there is no message, so no allowed_mentions applies.
export type ChannelCreateBody = {
  name: string;
  type: number; // 0 = text, 2 = voice, 4 = category
  parent_id?: string | null;
  topic?: string;
  permission_overwrites?: Array<{ id: string; type: 0 | 1; allow: string; deny: string }>;
};

export const NO_MENTIONS: AllowedMentions = { parse: [] };

function assertSnowflake(value: string, label: string): void {
  if (!isSnowflake(value)) throw new Error(`invalid ${label}`);
}

// 429 must be surfaced to the caller (a Durable Object alarm retries it), never retried here.
async function throwIfRateLimited(response: Response): Promise<void> {
  if (response.status !== 429) return;
  let retryAfter: unknown;
  try {
    const data: unknown = await response.json();
    if (data !== null && typeof data === "object" && "retry_after" in data) {
      retryAfter = (data as { retry_after?: unknown }).retry_after;
    }
  } catch {
    // Unparseable body: still a 429.
  }
  const seconds = typeof retryAfter === "number" ? ` retry_after=${retryAfter}` : "";
  throw new Error(`discord 429 rate limited${seconds}`);
}

function request(
  botToken: string,
  method: "POST" | "PATCH",
  path: string,
  message: DiscordMessage,
  fetchImpl: typeof fetch,
): Promise<Response> {
  // allowed_mentions is required by project rules: without it Discord pings every <@…> in user text.
  if (!message || message.allowed_mentions === undefined || message.allowed_mentions === null) {
    throw new Error("message.allowed_mentions is required");
  }
  return fetchImpl(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(message),
  });
}

export async function postMessage(
  botToken: string,
  channelId: string,
  message: DiscordMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  assertSnowflake(channelId, "channelId");
  const response = await request(
    botToken,
    "POST",
    `/channels/${channelId}/messages`,
    message,
    fetchImpl,
  );
  await throwIfRateLimited(response);
  return response;
}

export async function editMessage(
  botToken: string,
  channelId: string,
  messageId: string,
  message: DiscordMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  assertSnowflake(channelId, "channelId");
  assertSnowflake(messageId, "messageId");
  const response = await request(
    botToken,
    "PATCH",
    `/channels/${channelId}/messages/${messageId}`,
    message,
    fetchImpl,
  );
  await throwIfRateLimited(response);
  return response;
}

async function guildRequest(
  botToken: string,
  method: "POST" | "PATCH" | "DELETE" | "PUT",
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const response = await fetchImpl(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  await throwIfRateLimited(response);
  return response;
}

export async function createChannel(
  botToken: string,
  guildId: string,
  channel: ChannelCreateBody,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  assertSnowflake(guildId, "guildId");
  if (channel.name.trim().length === 0 || channel.name.length > 100) {
    throw new Error("channel name must be 1-100 characters");
  }
  return guildRequest(botToken, "POST", `/guilds/${guildId}/channels`, channel, fetchImpl);
}

export async function editChannelPermissions(
  botToken: string,
  channelId: string,
  overwrite: { id: string; type: 0 | 1; allow: string; deny: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  assertSnowflake(channelId, "channelId");
  if (!isSnowflake(overwrite.id)) {
    // The @everyone overwrite must use the guild id, never the literal "@everyone".
    throw new Error("invalid permission overwrite target");
  }
  return guildRequest(botToken, "PUT", `/channels/${channelId}/permissions/${overwrite.id}`, overwrite, fetchImpl);
}

export async function deleteChannel(
  botToken: string,
  channelId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  assertSnowflake(channelId, "channelId");
  return guildRequest(botToken, "DELETE", `/channels/${channelId}`, undefined, fetchImpl);
}

export async function deleteMessage(
  botToken: string,
  channelId: string,
  messageId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  assertSnowflake(channelId, "channelId");
  assertSnowflake(messageId, "messageId");
  return guildRequest(botToken, "DELETE", `/channels/${channelId}/messages/${messageId}`, undefined, fetchImpl);
}

export async function createThread(
  botToken: string,
  channelId: string,
  messageId: string,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  assertSnowflake(channelId, "channelId");
  assertSnowflake(messageId, "messageId");
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new Error("thread name must be 1-100 characters");
  }
  // A thread name is not message content, so there is no allowed_mentions to set here.
  const response = await fetchImpl(
    `${API_BASE}/channels/${channelId}/messages/${messageId}/threads`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: trimmed }),
    },
  );
  await throwIfRateLimited(response);
  return response;
}
