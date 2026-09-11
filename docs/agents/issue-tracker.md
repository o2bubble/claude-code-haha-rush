# Issue tracker: Local Markdown

Issues and PRDs for this repo live as markdown files.

## Conventions

- **Specs / PRDs** live at `.scratch/<feature-slug>/PRD.md`
- **Implementation tickets** live in a single `tickets.md` at the repo root, with all tickets in dependency order (blockers first)
- Triage state is recorded per-ticket via the `Status:` line near the top of each ticket section (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

**For specs / PRDs** (`to-spec`, `to-prd` and similar):
Create a new file at `.scratch/<feature-slug>/PRD.md` (creating the directory if needed).

**For implementation tickets** (`to-tickets` and similar):
Write a single `tickets.md` at the repo root, all tickets in dependency order (blockers first). Use the format:

```
# Tickets: <short name of the work>

A one-line summary of what these tickets build. Reference the source spec if there is one.

Work the **frontier**: any ticket whose blockers are all done. For a linear chain that means top to bottom.

## <Ticket title>

**What to build:** the end-to-end behaviour this ticket makes work, from the user's perspective.

**Blocked by:** other ticket titles that gate this one, or "None — can start immediately".

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2
```

## When a skill says "fetch the relevant ticket"

Read `tickets.md` at the repo root and locate the ticket by its title.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` — the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
