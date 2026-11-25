# Hatch Discord bot

A Cloudflare Worker that answers Discord over HTTP interactions. It runs `/focus` timers,
`/launch` and `/waitlist`, a daily check-in, and `/hatch` — the assistant, private buddy
spaces and personal memory.

What it is for, what it must never become, and the rules every change follows are in
[AGENTS.md](AGENTS.md) and [WHAT-NOT-TO-DO.md](WHAT-NOT-TO-DO.md). Read those first.

## Commands

| Command | What it does |
| --- | --- |
| `/focus minutes:<25\|50\|90> [goal]` | Posts a timer card and pings **Session Pings**. A Durable Object posts "time's up" when it ends. |
| `/launch` | Countdown to the beta, or "it's open" after 30 Nov 2026, 6:00 PM IST. |
| `/waitlist` | Private links to hatchh.io and docs.hatchh.io. |
| `/hatch ask question:` | Answers from Hatch's help docs. Public in the channel. 20/hour, 80/day per person. |
| `/hatch space [name]` | Preview card, then builds a private category with a text channel, a voice room and one live status message. |
| `/hatch add buddy:` / `/hatch remove buddy:` | Confirm-button invite/removal. Owner only. |
| `/hatch remember fact: [kind:]` | Stores a fact the person chose to share. |
| `/hatch memory` | Shows everything stored. |
| `/hatch forget [fact:]` | Forgets one thing, or everything on a button. |
| `/hatch usage` | How many Ask Hatch questions are left. |

The daily check-in posts at 09:00 IST to `GOALS_CHANNEL_ID` and opens a thread.

## Setup

1. **Secrets** (never in `wrangler.jsonc`, never committed):

   ```sh
   wrangler secret put DISCORD_PUBLIC_KEY
   wrangler secret put DISCORD_BOT_TOKEN
   wrangler secret put DISCORD_APP_ID
   wrangler secret put AI_BASE_URL
   wrangler secret put AI_API_KEY
   ```

   For `wrangler dev`, put the same values in `.dev.vars` (gitignored).

2. **Ids** in `wrangler.jsonc` `vars`: `GUILD_ID`, `SESSION_PINGS_ROLE_ID`,
   `GOALS_CHANNEL_ID`. A value still starting with `PASTE_` turns that feature off safely.

3. **Interactions endpoint:** set `<worker-url>/interactions` as the Interactions Endpoint
   URL in the Discord Developer Portal.

4. **Invite the bot** with these permissions:

   | Permission | Needed for |
   | --- | --- |
   | Send Messages, Embed Links | every command |
   | Use Application Commands | slash commands |
   | Create Threads, Send Messages in Threads | daily check-in |
   | Manage Channels | `/hatch space` — creating the category and rooms |
   | Manage Roles | permission overwrites when adding or removing buddies |

   Do not grant Administrator.

5. **Register commands** after any change to `src/definitions.ts`:

   ```sh
   npm run register -- --dry-run   # preview, no network call
   npm run register                # registers to GUILD_ID
   ```

## Development

```sh
npm install
npm run typecheck
npm test
npm run dev        # local Worker, --test-scheduled to fire the cron
```

`npm run deploy` runs typecheck and tests before `wrangler deploy`. Never run
`wrangler deploy` on its own.

## How it is built

| Path | Purpose |
| --- | --- |
| `src/index.ts` | `/interactions` routing, component buttons, cron. The side-effect layer. |
| `src/verify.ts` | Ed25519 signature check. |
| `src/commands.ts` | Pure `/focus`, `/launch`, `/waitlist` handlers. |
| `src/checkin.ts` | Pure weekday prompts and thread names. |
| `src/hatch.ts` | Pure `/hatch` plan: what each subcommand shows. |
| `src/ai.ts` | Assistant client (OpenAI-compatible) and the prompt. |
| `src/knowledge.ts` | Hatch facts, from docs.hatchh.io. The model has no built-in knowledge of Hatch. |
| `src/memory.ts` | Pure memory rules; `src/memory-store.ts` is the Durable Object. |
| `src/ratelimit.ts` | Pure 20/hour, 80/day rule; `src/usage-store.ts` is the Durable Object. |
| `src/space.ts` | Pure space rules (buddies, timers, status message); `src/space-store.ts` is the Durable Object. |
| `src/timer.ts` | `FocusTimer` Durable Object for `/focus`. |
| `src/discord.ts` | Small REST helper. Every message sets `allowed_mentions`. |
| `scripts/register-commands.ts` | Registers slash commands. |
| `test/*.test.ts` | Vitest. Pure modules tested directly; Discord and the model are faked. |

Handlers in `commands.ts`, `checkin.ts`, `hatch.ts`, `memory.ts`, `ratelimit.ts` and
`space.ts` are pure: no network, no clock. Keep it that way — the tests depend on it.
