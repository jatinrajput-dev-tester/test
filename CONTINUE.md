# CONTINUE.md — Hatch Discord bot handoff

Everything below is what this session has built, fixed and deployed. Keep this file open if you pick the work back up after context is cleared. Nothing here is stored outside this repo.

---

## What this bot is

**Hatch** is a Discord bot for Hatchfam (Hatch's Discord server). Hatch is an Indian social accountability app for students at hatchh.io — this bot brings focus sessions, buddy spaces, daily check-ins and an assistant into Discord so nobody has to open the app to use these features.

- **Runtime**: Cloudflare Worker answering Discord HTTP interactions (no gateway, no discord.js)
- **State**: Durable Objects only — no D1, no KV, no R2, no external database
- **Commands**: registered to guild `1567841119524626442` (WDYEXC's server only)
- **Time zone**: Indian Standard Time (UTC+5:30), fixed offset, plain IST text in all messages
- **Deployed**: https://hatch-discord-bot.hatchbot-jtdas.workers.dev
- **Tests**: 168 passing across 7 files; typecheck clean

---

## Facts from this session that keep biting people

**The folder is misleading.** It's named `E:\TELGRAM BOT` but there is zero Telegram code. This is a Discord bot only. Do not build anything Telegram.

**IDs you will see everywhere:**
- App ID: `1574405329834221609`
- Guild ID: `1567841119524626442` (WDYEXC's server)
- Session Pings role: `1574411659177369701`
- Goals channel: `1573590971713851485` (`general`)
- Bot token: in `.dev.vars` (gitignored, never committed)
- Worker URL: `https://hatch-discord-bot.hatchbot-jtdas.workers.dev`

**Three bugs that already shipped and were fixed once each:**
1. `/hatch space` spun forever on "thinking…" — the follow-up webhook was addressed by interaction id instead of interaction token.
2. The bot never granted itself permission on the channels it created — building rooms inside its own hidden category failed with `Missing Permissions`.
3. Space creation lived in a separate Durable Object from space storage — `/create` wrote to one object and `/channels` read from another, so saved rooms were always lost ("couldn't save them"). Now one object, `SpaceStore`, handles everything for one owner.

Do not re-invent these. They are tested.

---

## What's built (every command)

### `/focus minutes:<25|50|90> [goal]`
Starts a focus timer in the current channel. Posts an ephemeral card showing starter, goal and end time, pings the Session Pings role, and when time is up posts "Time's up" in the same channel mentioning the starter. All times are IST text.

### `/launch`
Countdown to the Hatch beta (30 Nov 2026, 6:00 PM IST) with the waitlist link. After launch, says the beta is open.

### `/waitlist`
Ephemeral links to hatchh.io and docs.hatchh.io.

### `/hatch space [name]`
Builds a private buddy space: a category called "…'s friends", a text channel (`…-chat`) and a voice room (`…-focus`). Invisible to @everyone; owner and buddies only. Posts one live status message, edited in place — never re-posted. A second press returns the existing space instead of building a second one.

### `/hatch add @user`, `/hatch remove @user`
Add/remove buddies from your space. Owner only, max 6 buddies per space. Shows a preview card with Create/Cancel before changing anything.

### `/hatch remember <fact> [kind]`, `/hatch memory`, `/hatch forget`
Personal memory, opt-in and visible. Kinds: goal, preference, buddy, language, note. Max 25 entries, 160 chars each. `/hatch memory` shows everything; `/hatch forget` wipes one fact or everything.

### `/hatch ask <question>`
Answers Hatch questions using the Hatch API assistant endpoint (`AI_BASE_URL` / `AI_API_KEY`). Rate-limited: 20 per hour, 80 per day per person. Questions and answers are not stored.

### `/hatch usage`
Shows remaining AI quota for the hour and day.

### Daily check-in (cron `30 3 * * *` = 09:00 IST)
Posts a goal prompt to `#general` (`GOALS_CHANNEL_ID`) every day at 09:00 IST and opens a thread named "Check-in · DD MMM".

---

## File map

| File | Purpose |
|---|---|
| `src/index.ts` | Worker entry: `/interactions` routing, cron, deferred replies, space building |
| `src/commands.ts` | Command handlers, message copy, pure (no network, no clock) |
| `src/definitions.ts` | Command definitions, launch time, links |
| `src/space.ts` | Space rules: naming, overwrites, timers, buddies, `isBuilt`, status message |
| `src/space-store.ts` | `SpaceStore` Durable Object: one per owner, holds the space record |
| `src/time.ts` | IST helpers: `istTimeText`, `istDateTimeText`, `relativeText`, `fromIst` |
| `src/ai.ts` | `askHatch()`: OpenAI-compatible chat to `basis-default`, typed failures |
| `src/hatch.ts` | `/hatch` subcommand parsing and reply building |
| `src/checkin.ts` | Daily prompt text, thread name, posting |
| `src/timer.ts` | `FocusTimer` Durable Object: per-interaction timer with alarm |
| `src/memory-store.ts` | `MemoryStore` Durable Object: per-user memory record |
| `src/memory.ts` | Memory rules: remember, forget, summarize |
| `src/ratelimit.ts` | Per-hour / per-day rate-limit windows |
| `src/usage-store.ts` | `UsageStore` Durable Object: AI quota counters |
| `src/discord.ts` | Minimal Discord REST helper (no SDK): messages, channels, permissions |
| `src/verify.ts` | Ed25519 signature verification via WebCrypto |
| `src/env.ts` | All bindings in one interface |
| `scripts/register-commands.ts` | Registers commands to the guild (`--dry-run` supported) |
| `scripts/live-check.ts` | 16 flows against real Worker, Discord faked |
| `scripts/live-ai-check.ts` | 7 questions against real AI API |
| `test/*.test.ts` | 7 files, 168 tests |
| `wrangler.jsonc` | DO bindings (5 classes), migrations v1–v3, cron, vars |
| `.dev.vars` | Secrets: AI_BASE_URL, AI_API_KEY, DISCORD_APP_ID, DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN |

---

## How to run it

**Prerequisites:** Node.js, Wrangler, and the five secrets in `.dev.vars`:
```
AI_BASE_URL=<basis-default endpoint>
AI_API_KEY=<key>
DISCORD_APP_ID=1574405329834221609
DISCORD_PUBLIC_KEY=<from Discord dev portal>
DISCORD_BOT_TOKEN=<bot token>
```

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `vitest run` — 168 tests |
| `npm run deploy` | Typecheck + tests + `wrangler deploy` |
| `npm run dev` | Local dev server (`wrangler dev --test-scheduled`) |
| `npm run register -- --dry-run` | Register commands to the guild without shipping |

**Deploy:** `npm run deploy` is the one command. It will not deploy if tests fail or typecheck fails.

**Re-register commands:** whenever `src/definitions.ts` changes, run `npm run register`.

**Verify it's live:** hit `https://hatch-discord-bot.hatchbot-jtdas.workers.dev/` → should 404. An unsigned POST to `/interactions` → 401.

---

## What is stored (and what isn't)

| Data | Stored? | Where | Expires? |
|---|---|---|---|
| `/hatch ask` questions | No | — | — |
| `/hatch ask` answers | No | — | — |
| AI request timestamps | Yes | `UsageStore` | Oldest 24h dropped |
| `/hatch remember` facts | Yes | `MemoryStore` | Never (see below) |
| Running timers | Yes | `FocusTimer` | Deleted when timer fires |
| Space records | Yes | `SpaceStore` | Only on `/clear` |

**Gaps worth fixing before adding new features:**
- `MemoryStore` never expires — anyone who used `/hatch remember` once keeps that record forever. There's no per-account wipe, only per-fact `forget`.
- No database — Durable Objects only. If you want chat history or per-server settings, that's a new storage decision.

---

## What's left / open

- **Daily check-in channel:** `GOALS_CHANNEL_ID` points at `general`. If you want it in `#hatch`, change the var and redeploy.
- **Memory expiry:** see above.
- **`/hatch space` retry:** run `/hatch space` and press Create — the old half-built record is now finished rather than refused.
- **Probe category deleted:** the server is back to its original 8 channels; no leftovers from debugging.

---

## How to continue

1. Read `AGENTS.md` (project rules: no XP/leaderboards, no @everyone, ephemeral replies for personal things, IST text only).
2. Run `npm run typecheck && npm test` — must be green before anything.
3. Make your change. Add tests for every new command or action.
4. `npm run deploy`, then `npm run register` if commands changed.
5. Test in WDYEXC's server only — the bot is registered there and nowhere else.

---

Backups: `backup/` contains a full copy of this repo (2,747 files, 201 MB including `node_modules`), checksum-verified against the working tree at HEAD `4a13165`. Do not touch it until told.
