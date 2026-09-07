# North-stars — Event-Horizon

**This file is AUTHORITATIVE.** It outranks every other doc, comment, and any agent's own
inference. When a source conflicts with a north-star, **the north-star wins and that source is
stale** — say so rather than silently averaging the two.

---

## What earns a place here

A north-star is a fixed point someone would otherwise **re-litigate, re-derive, or contradict** —
and the cost of that is real. Four kinds earn a number:

- **Invariants** — what must always hold, and what breaks when it doesn't. The good ones name the
  incident: *"uninstall once deleted the user's own notes because the directory looked ours."*
- **Term meanings** — the word this project uses in a non-obvious way. If two people can read
  "active user" differently, one of them is writing the wrong query.
- **Settled decisions** — chosen, with the reason, so it stops being reopened every quarter.
- **Rejected ideas** — the graveyard. This is the half people skip and the half that pays: without
  it, a good-sounding idea that was already measured and killed comes back every six months.

**What does NOT earn one:** anything the code already says, anything a linter enforces, style
preferences, and anything you would happily change next week. A file of forty soft opinions
anchors nothing — the agent skims it and the real invariants drown.

## Format

Number them `NS-#`, one claim each, and lead with the claim itself:

```
- **NS-#** — **The headline claim, stated in one sentence.** Then the mechanism, the numbers, or
  the incident that makes it true. Cite what you measured, not what you assume.
```

Two rules make the difference between a doc and an anchor:

1. **Claim first.** The re-anchor hook re-injects only the opening sentence of each entry, so an
   entry that opens with background and buries the rule delivers a cliffhanger and nothing else.
2. **Never renumber.** A number is a citation; reusing one silently rewrites every reference to it.
   Retire an entry by moving it under a "Superseded" heading with a line saying what replaced it.

Group them under headings as they accumulate — invariants, evidence, settled, open, superseded.
The order does not matter to the tooling; it matters to the person reading at 2am.

## How they get used

- **Session start** — you are told to read this file before forming any premise.
- **Mid-session** — the anchor hook re-injects the claims every N tool calls and after you write a
  doc, because that is when a drifted premise gets written down and becomes "settled".
- **When work is delegated** — the relevant subset goes to every subagent, so a fan-out cannot
  quietly contradict a decision you already made.
- **In review** — a finding that cites a north-star is a finding you can act on without arguing.

## Writing the first few

You do not have to invent them. They already exist, as scar tissue:

- The last three bugs that were **the same bug** wearing different clothes.
- Whatever you explained twice in review this month.
- The decision you keep having to defend.
- The thing a new person always gets wrong in their first week.

Ask your agent to propose a set from the repository's own history — `git log` for the reverts and
the "actually, no" commits, the review threads, the incident notes — then **edit hard**. Something
proposed and never checked is not a fixed point, it is a guess with a number on it.

<!-- Add your first entry below. Delete the guidance above whenever you like — this file is yours,
     and bearing seeds it once and never overwrites it. -->

## Invariants — must always hold

- **NS-1** — **Reliability and precision are the goal; download size and install time are not
  constraints.** The curator's words: "i dont care about file size at all. bc 1 time download in
  modern world even if its 20gb is minor shit man." A reference collection ships at 10.3 GB. Any
  design that trades correctness for bytes or minutes is answering a question nobody asked — and
  the opposite trade needs no justification.

- **NS-2** — **Never destroy a mod Event Horizon did not install.** This was violated twice, in one
  week, by two unrelated code paths, which is why it is an invariant rather than a code comment.
  The repair path uninstalled adopted mods to make them match; the mirror pass overwrote and
  deleted files in them. Both read `installedMods`, where an adopted mod carries the USER's Vortex
  id. Provenance now comes from the install journal, and any new path that removes, overwrites or
  uninstalls must consult it. `installPlan.ts` promises "Old profile is byte-untouched" — that
  sentence is load-bearing.

- **NS-3** — **"Do you already have this mod?" is a question about Vortex's per-game mod POOL,
  never about a profile.** In Vortex a mod lives in one pool per game; a profile only records which
  are enabled. Asking through the active profile answered a different question and cost a tester
  their evening: pairing five runs of a real log, `already-installed` decisions equalled the
  snapshot size exactly every time (1→1, 1→1, 0→0, 5→5, 99→99) because each interrupted run made a
  fresh, empty profile while 1,105 mods sat in the pool. After the fix: 1,093 recognised.

- **NS-4** — **Identity and integrity are separate passes and must stay separate.** The resolver
  answers "is this the same mod?" and may skip installing. Verification answers "did the right
  bytes land?" and runs over every mod including the ones we skipped. Conflating them produces the
  two worst outcomes this tool has: a wrong "already installed" that nothing checks, or a correct
  mod reinstalled because it was merely unrecognised.

## Settled — decided; do not relitigate

- **NS-5** — **Mirroring exists to give mod authors their exposure even though we override their
  files.** Bundle and mirror ship byte-identical results; the entire difference is that a mirrored
  mod stays a real Nexus mod — the user downloads it from Nexus, so the author keeps the download,
  and updates and endorsement still work. Bundling re-keys the mod to our repack and severs all of
  that. Any proposal to merge the two answers because "the bytes are the same" has missed the
  point of the feature.

- **NS-6** — **Bundling removes a mod's installer; mirroring does not.** A bundled mod ships a
  repack of the STAGING folder, which contains no `fomod/` script — verified across ten bundled
  archives in a real package, zero of which carried one. A mirrored mod still installs from its
  original archive, so its FOMOD still runs and still asks. This is the deciding fact for a mod
  whose installer answers cannot be replayed: bundle it.

- **NS-7** — **"Declare" is only for files the user is no worse off without.** Tool logs, `.bak`
  backups, a cache, an ini tuned to the curator's hardware. NOT LOD output and NOT a cleaned
  plugin: nobody installing the collection can regenerate those, and declaring them ships a world
  with no LODs or a dirty plugin, silently, with every file verifying.

- **NS-8** — **An empty `fomodSelections` is ambiguous and must never be guessed.** Measured on a
  1,755-mod collection: 301 mods recorded steps, of which 295 picked options and 6 deliberately
  picked nothing; 1,454 have no installer at all. A fourth shape exists — a mod that HAS a FOMOD
  and recorded nothing, because Vortex discards `installerChoices` when a variant is created
  without "Pre-populate installer options from existing mod". All three such mods in that
  collection are variants. Replaying "nothing" for those installs less than the curator has;
  refusing to replay stops a stranger's install dead. The build measures which it is by replaying
  the script with no choices and comparing against the staging folder both ways.

## Open

## Graveyard — tried, measured, rejected

- **NS-9** — **REJECTED: collapsing bundle/mirror/declare into "do users need these files?" with
  the tool picking the mechanism.** The proposed rule was "mirror when a Nexus archive resolves,
  bundle when it does not". It picks mirror for every mod whose installer cannot be replayed, and
  mirror leaves the dialog exactly where it is (NS-6). The three answers describe genuinely
  different outcomes for the mod author (NS-5) and for the user's install experience, and the
  curator is the only one who can weigh them. A fourth answer — "leave this mod out" — was added
  instead.

## Superseded — kept so old citations still resolve
