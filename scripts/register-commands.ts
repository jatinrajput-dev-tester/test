// Registers the Hatch slash commands to one guild.
// Run with `npm run register` (or `npm run register -- --dry-run`).

import { definitions } from "../src/definitions.js";
import { isSnowflake } from "../src/discord.js";

const API_BASE = "https://discord.com/api/v10";

type RegisteredCommand = { id?: unknown; name?: unknown };

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const token = process.env.DISCORD_BOT_TOKEN;
  const appId = process.env.DISCORD_APP_ID;
  const guildId = process.env.GUILD_ID;

  if (dryRun) {
    // Preview only: no env vars needed and no network call made.
    process.stdout.write(`${JSON.stringify(definitions, null, 2)}\n`);
    return;
  }

  const missing = [
    token === undefined || token === "" ? "DISCORD_BOT_TOKEN" : null,
    appId === undefined || appId === "" ? "DISCORD_APP_ID" : null,
    guildId === undefined || guildId === "" ? "GUILD_ID" : null,
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    fail(`Missing env var(s): ${missing.join(", ")}. Set them and try again.`);
  }

  // Narrowed above, but keep the compiler honest about the union.
  if (!token || !appId || !guildId) fail("Missing env vars.");

  // A wrong id would register commands to the wrong place (or 404), so refuse early.
  // The values are not echoed: DISCORD_APP_ID is a secret.
  if (!isSnowflake(appId)) fail("DISCORD_APP_ID is not a snowflake (expected 17-20 digits).");
  if (!isSnowflake(guildId)) fail("GUILD_ID is not a snowflake (expected 17-20 digits).");

  const response = await fetch(`${API_BASE}/applications/${appId}/guilds/${guildId}/commands`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(definitions),
  });

  const rawBody = await response.text();

  if (!response.ok) {
    // Discord error bodies never include the token, so this is safe to print.
    fail(`Register failed: ${response.status} ${response.statusText}\n${rawBody}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    fail(`Register returned ${response.status} but the body was not JSON:\n${rawBody}`);
  }

  if (!Array.isArray(parsed)) {
    fail(`Register returned an unexpected body:\n${rawBody}`);
  }

  const lines = parsed.map((entry: unknown): string => {
    const command = (entry ?? {}) as RegisteredCommand;
    const name = typeof command.name === "string" ? command.name : "(unknown)";
    const id = typeof command.id === "string" ? command.id : "(no id)";
    return `${name}  ${id}`;
  });

  process.stdout.write(`Registered ${lines.length} command(s):\n${lines.join("\n")}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Register failed: ${message}\n`);
  process.exit(1);
});
