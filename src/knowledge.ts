// Facts the assistant may use, taken from https://docs.hatchh.io (last updated 20 Nov 2026).
// The model has no built-in knowledge of Hatch — it answered "Hatch is a Python package
// manager" until these facts were supplied. Anything not listed here must be answered
// with "I'm not sure" plus a link to the docs. Never add guessed features, prices or dates.

export const HATCH_FACTS = `
WHAT HATCH IS
Hatch is a social space for students (16 and over) to work toward goals with other people.
Members pick a goal, find people working on the same kind of thing, join a small group or a
live room, report progress, and keep going afterward. It is made by Wrista Labs, a brand of
Wrista Technologies LLP, based in India. Website: https://hatchh.io

PODS
A pod is a small group built around one goal, with a single category and a fixed end date.
- Maximum size: up to 10 hatchers, including the person who created it (planned beta limit).
- The end date locks as soon as another hatcher joins, and pods cannot be extended.
- Pod names may be up to 80 characters.
- During the free beta, a person may be in 3 active pods at once, whether created or joined.
  Pending requests, waitlists and archived pods do not count toward the limit.
- A waitlist does not reserve a seat.
- Check-ins: one check-in per pod per day, editable the same day. "Today" follows India
  Standard Time (IST).
- Polls allow 2 to 10 answers and stay open from 5 minutes up to 7 days.
- Removal votes stay open 24 hours and need a strict majority of those who voted. A tie or too
  few votes means the member stays; voting is optional.
- When a pod reaches its end date it is archived automatically and becomes read-only.
  Check-in history, conversation and saved links stay readable under My pods → Archived.
  Admins can archive early; that cannot be undone. To leave, use Pod settings; a sole admin
  must transfer the admin role first.

SESSIONS
A session is a single live focus room with audio and video.
- Duration choices: 15, 25 or 30 minutes. During the free beta, sessions run up to 30
  minutes; longer sessions are planned for paid plans, which are not available yet.
- Room capacity: up to 10 people.
- Start immediately or schedule up to a week ahead. A person may have up to three planned
  sessions at a time.
- Audience can be anyone on Hatch, the pod's members, or only people you invite.
- Everyone joins with microphone and camera off; both are optional and chat works either way.
- Sessions are never recorded. Audio and video go only to people in the room.
- Chat starts closed. A personal focus line can be up to 60 characters and carries across rooms.
- Hosts can request a mute, add a co-host, remove someone, or lock the room. "End for everyone"
  closes it for all. If the host just leaves, the session continues and hosting passes on.
- Invite links can expire in 5 minutes, 1 hour, 24 hours or 7 days.

STARTING OUT
Create an account at https://app.hatchh.io with an email and a 6-digit code — there is no
password. Then choose a display name, give a birthday (used only to check you are 16 or older,
never shown), pick a goal, and join a pod. The docs suggest starting with one pod, checking in
daily even with a tiny step, and trying a short session first.

PRIVACY AND SAFETY
- Hatch does not sell user data and does not show ads.
- People you are not connected to must send a message request you can accept or decline.
- Suggestions are based on shared goals, pods, intentions and region, and come with an
  explanation. There is no match score.
- Account deletion: email wristalabs@gmail.com from the address on the account; Hatch replies
  within 30 days.
- Contact: wristalabs@gmail.com or Instagram @hatch.era.

BETA AND LAUNCH
- The web beta is usable now at https://app.hatchh.io and is free.
- The public launch is 30 November 2026, 6:00 PM IST. People on the waitlist are emailed.
- Joining the waitlist only sends launch emails; it does not create an account.
- Starter and Pro paid plans are "coming soon" and cannot be bought yet. No payment details
  are collected. No prices are published.
- Desktop and mobile apps are coming soon; the browser beta works on phones.
- Beta names, limits and steps may change. The changelog tracks updates.

WHAT HATCH IS NOT
Not a paid service during the beta. Not a recording service. Not ad-funded and it does not sell
data. Not open direct messaging between strangers. Not yet a native desktop or mobile app.
Not a match-score system. Not for people under 16.
`.trim();

export const SUPPORT_LINKS = {
  docs: "https://docs.hatchh.io",
  app: "https://app.hatchh.io",
  site: "https://hatchh.io",
  farm: "https://hatchh.io",
} as const;
