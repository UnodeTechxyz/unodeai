> Adapted from the upstream `internal-comms` skill (Apache-2.0); the changes are listed in `SOURCE.md`.

## Instructions
You are being asked to write a 3P update. 3P updates stand for "Progress, Plans, Problems." The main audience is for executives, leadership, other teammates, etc. They're meant to be very succinct and to-the-point: think something you can read in 30-60sec or less. They're also for people with some, but not a lot of context on what the team does.

3Ps can cover a team of any size, ranging all the way up to the entire company. The bigger the team, the less granular the tasks should be. For example, "mobile team" might have "shipped feature" or "fixed bugs," whereas the company might have really meaty 3Ps, like "hired 20 new people" or "closed 10 new deals." 

They represent the work of the team across a time period, almost always one week. They include three sections:
1) Progress: what the team has accomplished over the next time period. Focus mainly on things shipped, milestones achieved, tasks created, etc.
2) Plans: what the team plans to do over the next time period. Focus on what things are top-of-mind, really high priority, etc. for the team.
3) Problems: anything that is slowing the team down. This could be things like too few people, bugs or blockers that are preventing the team from moving forward, some deal that fell through, etc.

Before writing them, make sure that you know the team name. Take it from the request or your sources; if neither names it, ask for it, or write `[team name]` and list it as a gap.


## Tools Available
Use the sources this session actually has: what the user gave you, files in the workspace, and integrations this agent has been granted. In an organization that uses them, good sources are:
- Chat (for example Slack): posts from team members with their updates - ideally look for posts in large channels with lots of reactions
- Shared documents (for example Google Drive): docs written from critical team members with lots of views
- Email: emails with lots of responses of lots of content that seems relevant
- Calendar: non-recurring meetings that have a lot of importance, like product reviews, etc.


Try to gather as much context as you can, focusing on the things that covered the time period you're writing for:
- Progress: anything between a week ago and today
- Plans: anything from today to the next week
- Problems: anything between a week ago and today


If you don't have access, you can ask the user for things they want to cover. They might also include these things to you directly, in which case you're mostly just formatting for this particular format.

## Workflow

1. **Settle scope**: The team name and time period (usually past week for Progress/Problems, next
week for Plans). Take them from the request or the sources; ask only if neither gives them.
2. **Gather information**: Use available sources or ask the user directly
3. **Draft the update**: Follow the formatting guidelines
4. **Review**: Ensure it's concise (30-60 seconds to read), data-driven, and that every statement rests on a source

## Formatting

Unless the user's own template differs, the format is always the same, very strict formatting. Never use any other formatting than this or the user's template. Pick an emoji that is fun and captures the vibe of the team and update.

[pick an emoji] [Team Name] (Dates Covered, usually a week)
Progress: [1-3 sentences of content]
Plans: [1-3 sentences of content]
Problems: [1-3 sentences of content]

Each section should be no more than 1-3 sentences: clear, to the point. It should be data-driven, and generally include metrics where a source gives them; never invent a number. The tone should be very matter-of-fact, not super prose-heavy.
