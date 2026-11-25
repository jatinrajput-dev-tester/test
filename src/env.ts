// The Worker's bindings, in one place. Kept separate so src/index.ts, the Durable Objects
// and the tests all agree on the shape.

export interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APP_ID: string;
  GUILD_ID: string;
  SESSION_PINGS_ROLE_ID: string;
  GOALS_CHANNEL_ID: string;
  AI_BASE_URL: string;
  AI_API_KEY: string;
  FOCUS_TIMERS: DurableObjectNamespace;
  MEMORIES: DurableObjectNamespace;
  USAGE: DurableObjectNamespace;
  SPACES: DurableObjectNamespace;
}
