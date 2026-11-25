# Hatchfam Discord — copy and onboarding (draft for approval)

Source facts: hatchh.io (launch 30 Nov 2026, 6:00 PM IST · free beta preview · pods + live sessions · no feed).
Nothing here is posted yet.

---

## 1. Server description (Community profile / invite card)

> The community home of Hatch — small pods and live co-working sessions for students who want to actually get things done. Beta opens 30 Nov 2026.

---

## 2. #welcome (pinned, read-only)

**Welcome to Hatchfam 🐣**

Hatch is a social platform built around accountability, not feeds. You join a small **pod** of people working toward the same kind of goal, and you show up for each other in live **sessions**: camera-on co-working calls where everyone just works.

This server is where we build it with you before and after launch.

**What's here**
• #announcements: launch news and release notes
• #introductions: say who you are and what you're working on
• #goals: post one goal for the week, and check in on it
• #wins: anything you finished, big or small
• 🔊 Focus Room 1 / 2: drop in, mute, and work alongside others
• #feedback, #bug-reports, #feature-ideas: tell us what to fix and build next

**Hatch itself**
Beta opens **30 November 2026, 6:00 PM IST**. Join the waitlist at https://hatchh.io. Help docs live at https://docs.hatchh.io.

Start in #introductions 👋

---

## 3. #rules (pinned, read-only)

**Hatchfam rules**

1. **Be kind and assume good intent.** No harassment, hate speech, slurs or personal attacks.
2. **Keep it safe for students.** No NSFW content, and nothing that sexualises anyone.
3. **No spam or self-promo.** That includes unsolicited DMs and invite links. Share your own projects in #wins when they're relevant.
4. **Respect focus rooms.** Stay muted unless the room agrees otherwise, and don't record or screenshot people without their consent.
5. **Protect privacy.** Don't share anyone's personal details, including your own address or phone number.
6. **Honest feedback, kindly delivered.** Criticise the product as much as you like; don't attack people.
7. **Follow Discord's Terms and Community Guidelines.** https://discord.com/terms · https://discord.com/guidelines

Moderators may remove messages or time out members who break these rules. Report a problem by pinging @Moderator or messaging a member of the Hatch Team.

---

## 4. First #announcements post

**Hatchfam is open 🐣**

This is the home of the Hatch community while we get ready for launch.

📅 **Beta opens 30 November 2026, 6:00 PM IST.** The waitlist is at https://hatchh.io
🎧 Focus Rooms are open now. Hop in and co-work with others.
🛠 Tell us what you'd want from Hatch in #feature-ideas. We read everything.

Pick **Launch Updates** in Channels & Roles if you want to be pinged for releases.

---

## 5. Channel topics (set as settings, not posts)

| Channel | Topic |
|---|---|
| #welcome | What Hatch is and how this server works. Start here. |
| #rules | The few rules that keep Hatchfam kind and focused. |
| #announcements | Launch news and release notes from the Hatch team. |
| #general | Chat with other hatchers. Keep it friendly. |
| #introductions | Who you are, what you're studying or building, and one goal you're chasing. |
| #goals | One goal for the week. Check back in on Friday. |
| #wins | Finished something? Post it here, big or small. |
| #feedback | What's working and what isn't. |
| #bug-reports | What happened, what you expected, and your device or browser. |
| #feature-ideas | What should Hatch do next? One idea per message. |

---

## 6. Onboarding (Discord native, requires Community)

**Default channels:** welcome, rules, announcements, general, introductions, goals, wins, Lounge, Focus Room 1.

**Q1. What brings you to Hatch? (multi-select, required)**
| Option | Gives |
|---|---|
| Find accountability / a pod | role Early Hatcher, channels #goals and #introductions |
| Co-work in focus rooms | role Session Pings, channels Focus Room 1 and 2 |
| Follow the launch | role Launch Updates, channel #announcements |
| Help shape the product | channels #feedback, #bug-reports and #feature-ideas |

**Q2. What are you working toward? (multi-select, optional)**
Exams & Study · Coding & Building · Career & Internships · Creative Work · Health & Habits, each mapped to the role of the same name.

**Q3. Where are you based? (single-select, optional; helps match co-working times)**
Asia & Oceania · Europe & Africa · Americas.

**Server Guide welcome:** "Hey {user}, welcome to Hatchfam, where students find their people and get things done together."
**New-member to-dos:** 1) Read #rules  2) Introduce yourself in #introductions  3) Post a goal in #goals  4) Join a Focus Room.
**Resource pages:** "What is Hatch?" (= #welcome) · "Rules" (= #rules) · "Launch" (= #announcements).

---

## 7. Bots: recommendation

Discord's built-in tools already cover onboarding, role picking, AutoMod, events and join alerts, so bots should only fill real gaps.

| Bot | Why | Permissions it asks for |
|---|---|---|
| **Carl-bot** | Logs deleted/edited messages and member joins/leaves into #mod-log (Discord's audit log doesn't record these), adds `!waitlist` and `!launch` auto-replies, and posts the rules and welcome as clean embeds. | Manage Roles, Manage Messages, View Audit Log, Embed Links, Send Messages |
| **Custom "Hatch" bot** (built here, hosted on Cloudflare Workers next to hatchh.io) | `/focus 25` and `/focus 50` start a co-working timer and ping Session Pings; a daily 9 AM IST check-in prompt in #goals; `/launch` countdown; `/waitlist` link. | Send Messages, Embed Links, Use Slash Commands |

**Deliberately not added:** XP/leveling bots (MEE6-style). Hatch's whole stance is "no feed, no dopamine loops", and rank-grinding contradicts it.
