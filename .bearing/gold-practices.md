<!-- BEGIN GENERATED: gold-practices — bearing owns this block and rewrites it on update. Add YOUR rules below the END marker, where they are safe. -->
# Gold practices — what went wrong before

**Ships with bearing. Applies to every project.** Where the north-stars say what *this* project is,
these say how the work is done anywhere. Numbered `GP-#`, cited the same way.

**North-stars outrank gold practices.** A project's own invariant is more specific than a general
rule, so on conflict the `NS-#` wins and you say which one and why.

**This block is bearing's**, and `bearing update` rewrites it. **Your own practices go below the
END marker at the bottom**, numbered `PP-#`; nothing down there is ever touched. Rules about what
*this project is* still belong in `.bearing/northstars.md`.

---

**Every rule here has a scar, and the scar is the point.** There is deliberately nothing about
writing tests, naming things, or keeping commits small: you already do that, and a rule you already
follow costs context and changes nothing. What is here is the set of mistakes that got made *anyway*
— by a competent agent, on a real codebase, while being careful — because those are the ones knowing
better does not prevent.

---

## The work

- **GP-1** — **Executed, or unverified.** A statement about behaviour that came from reading code,
  grepping, or reasoning is a *hypothesis*. Say "I ran X and saw Y", or say you have not checked.
  *Scar: "a fresh install then uninstall leaves nothing behind" — asserted from a grep that was
  subtly wrong. Executing it found six leaked paths.*

- **GP-2** — **A test that has never failed has never been tested.** After writing a test for a fix,
  revert the fix and watch it fail. If it still passes, it does not cover the fix and you have
  bought nothing. *Scar: twice in one week. The second time a neighbouring fix masked the one the
  test was written for, so the revert check reported zero failures.*

- **GP-3** — **Test at the seam the bug lives at.** A unit test that passes an argument the real
  pipeline never produces is green and dead. Ask which caller supplies that input in production.
  *Scar: a context-window fix tested as `resolve(300_000, undefined)` while the shipped config
  always passed a number — so the fix could not run, and did not, for two releases.*

- **GP-4** — **A fixture chosen for convenience tests the case that cannot fail.** Ask what your
  setup makes *impossible*; that is the untested path. *Scar: the fixture had a tracked config file,
  which sends the code down its skip branch — so the create branch, the one that leaked, was never
  executed by any test.*

- **GP-5** — **An assertion that cannot fail is not an assertion.** *Scar: three in one codebase — a
  substring check against text that always contained it, a revert check written as `return "" ||
  (…)` where the empty string is falsy, and a fixture whose search term matched under both branches.
  All three passed. None tested anything.*

- **GP-6** — **A silent no-op is indistinguishable from success.** A substitution that matched
  nothing, a loop that ran zero times, a script pointed at the wrong directory. Assert that state
  *changed*, not that the command returned 0. *Scar: two edits silently matched nothing, so "0 tests
  fail" was measuring an unmodified file.*

- **GP-7** — **Verify the probe before believing the result.** A failing check is a claim too, and a
  broken harness fails in exactly the shape of a broken feature. When a result is surprising, suspect
  the measurement first. When the result changes and the code under
  test did not, suspect the ENVIRONMENT before the subject — a suite that suddenly fails everywhere
  is describing its surroundings, not its subject. *Scar: a hook run without its project-directory
  variable operated on the wrong root and "proved" a working fix was broken; three probe harnesses
  reported confident numbers that were artefacts of shell quoting; and two runs regressed to "nothing
  found" through two edits chasing it, because the dev server had exited and another project's server
  had taken the port, so every request 404'd.*

- **GP-8** — **Every line you print is a claim, and a command's exit status is the only evidence it
  worked.** `cmd; echo "done"` prints "done" when cmd failed — the shell moved on. In a pipeline `$?`
  is the LAST stage, so `cmd | grep x; echo $?` reports grep. Gate the message on the status, or
  print the command's own output and read it. *Scar: "pushed" printed after a rejected push, and a PR
  comment posted saying the branch was updated — the echo was unconditional and the rejection
  scrolled past above it; a commit hash named before reading the output it came from.*

## The design

- **GP-9** — **A default indistinguishable from an explicit choice disables everything downstream
  that would correct it.** If code treats "the user told me" and "nobody told me" as the same value,
  it cannot tell them apart later — so record the absence, not a stand-in. *Scar: a context window
  defaulted to 200000, which the estimator read as the user's own statement of fact and returned
  immediately; every correction beneath it was unreachable in any real install.*

- **GP-10** — **Question the premise before tuning the number.** A limit that needs raising twice is
  pointing at a design, not asking for a value. *Scar: a CI timeout went 15 → 25 minutes; the fix was
  not doing that work in that job at all.*

- **GP-11** — **A list that must be kept in sync will fall out of sync — compute it.** Any
  hand-maintained mirror of something the code already knows is a defect waiting for someone to
  forget. *Scar: a module-boundary invariant kept as a list broke silently twice before it was
  derived from the imports instead.*

- **GP-12** — **Bound anything on a hot path.** A check that runs "once" runs on every tool call
  unless something stops it. *Scar: an evidence lookup intended to resolve one value per session
  re-read two dozen files on every single tool call, worst case concluding nothing each time.*

- **GP-13** — **Your blast radius includes what you cause other tools to write.** Accounting for
  your own writes is not enough if you invoke something that writes too. *Scar: a mode whose entire
  promise was leaving the repository untouched was verified clean at install — then the indexer it
  triggered appended to a tracked file and created another, and the repo went dirty.*

## The evidence

- **GP-14** — **Establish a contract from the thing that defines it, never from something that
  calls it.** Rank every source by distance from where the behaviour is decided: the producer's own
  implementation, then its published spec, then anything downstream. A call site tells you what one
  developer *believed* the contract was — which is a claim about them, not about the contract, and
  it carries their bugs forward as evidence.

  The reason this rule gets broken is an assumption, not laziness: that the producer is out of
  reach. Check before believing that. A code search across the organisation's repositories usually
  answers it in one call, with no access request and no waiting. When it genuinely is unreachable,
  the conclusion is still available — but it is now *"the callers behave as if X"*, which is a
  weaker claim than *"the contract is X"*, and it gets written down as the weaker one.
  *Scar: the meaning of two query parameters was settled by reading a frontend mapping helper,
  which was itself inverted. The real contract said the opposite, and both conclusions built on the
  reading were wrong.*

- **GP-15** — **Work the ladder in order, and only descend when a rung genuinely fails.**

  1. **The authoritative artefact** — the spec, the schema, the generated contract. Refresh it
     first: a stale copy is not the artefact, it is a third-hand account of one.
  2. **Detective work.** The producer's own source. How the rest of the codebase already does this
     — an existing caller shows you the *shape*: which call to make, in what order, with what
     wired up. It does **not** show you what the values mean (GP-14), and the two are easy to
     conflate precisely because the example is right there and looks authoritative. Documentation.
     The git history of the lines in question. Past tickets **and their comment threads**, which is
     where the decision usually lives while the ticket body records only what was asked for.
  3. **Ask the person you are working with.**
  4. **Only then block on someone else.**

  Both directions are failures and only one of them is visible. **Skipping up** — handing a person a
  question that rung 1 or 2 already answered — wastes their time and looks like diligence.
  **Skipping down** — guessing where you could simply have asked — produces a confident answer with
  nothing underneath it, and nobody finds out until it is wrong.
  *Scar: two wrong conclusions were escalated to a person while the service's own source, readable
  without asking anyone, went unread.*

## The shared path

- **GP-16** — **The same fix in N places is one implementation with N call sites.** This binds
  *across* separate changes too: three PRs each pasting the same block is the same defect as one
  file pasting it three times, and splitting the work does not license duplicating it. **A copied
  explanatory comment is the tell** — if the prose has to travel with the code, the code should have
  been extracted. *Scar: three separate PRs for one bug each independently reimplemented the same
  ~10-line mechanism, carrying an identical multi-paragraph comment along with it.*

- **GP-17** — **When your tooling lies, fix the tooling.** A wrong selector, a signal that does not
  mean what you thought, a check that passes for the wrong reason: fix it in the shared helper, not
  in the one-off script that happened to hit it. A signal *proven* to lie gets removed, not routed
  around — leaving it in place means the next person believes it. *Scar: three lessons from one test
  run were fixed inside a single verification script while the shared helpers kept the broken
  versions, so every later run inherited them.*

## The handover

- **GP-18** — **Reporting something as unverified is not a handover.** If you could not check it,
  hand over the means to check it. And **finding the data is your job, not theirs**: a link that
  opens the exact case in the exact state, created if none exists, opened by you first to confirm it
  lands where you said — plus why the obvious candidates do not work, because most will not and they
  will otherwise conclude the feature is broken. *Scar: "find an unpaid invoice and click the vendor"
  sends someone hunting through a backend for a record that mostly does not exist — the single most
  expensive part of a manual check, and the part that could have been done for them.*

- **GP-19** — **Send each fact to the reader who can act on it.** A PR description, a status update
  and a handover have different readers, and a fact that is essential in one is noise in another.
  The team-facing artefact carries what a reviewer must act on: the problem, the cause, the fix, how
  to check it, and anything you changed beyond what was asked. Your route to the answer — what you
  have not got to yet, why something is still draft, the approach you nearly took — has a reader
  too, and it is the person you are working with, not everyone who opens the PR later.

  **This is not licence to omit it** (GP-1, GP-8). An unverified claim is still said out loud and
  still gets a means to check it (GP-18); what changes is *where*, not *whether*. The test is one
  question: **would this reader do something differently knowing it?** A limitation they must work
  around, yes. An account of how you got here, no.
  *Scar: a PR body carried notes on what remained unverified and why a branch was still draft —
  written for one person, read by the whole team, and useless to every one of them.*

- **GP-20** — **An instrument that sees a subset reports success in the shape of the whole.** Before
  trusting a count, ask what it CANNOT see — the part outside its scope never shows up as a zero, it
  never shows up at all. Prefer observing the OUTCOME to enumerating the inputs you thought of: press
  submit rather than counting filled fields. *Scar: a completeness check counted `input[type=text]`
  and reported "all filled" while a date picker and two selects sat empty; a hook counting file edits
  watched the edit tools and saw 6 of ~96, because the rest went through the shell.*

- **GP-21** — **Hand over a decision, not a chore.** Whatever mechanical step you leave undone becomes
  the recipient's, and it is the part most likely to make them defer the whole request. Do everything
  that does not need them, then hand over exactly what does — the prefilled form, the exact command,
  the diff, closed options with a recommendation. Holds for whoever is next: a subagent, a reviewer,
  your own next session. *Scar: a blank KYC form handed to a person when every field but one was
  already known.*

- **GP-22** — **Declining to answer is the cheapest possible answer, so any comparison by cost ranks
  it first.** Check both sides actually produced a result before comparing what producing it cost:
  nothing in a cost metric separates a fast answer from a fast refusal, so the failing side takes the
  prize and the worse it fails the more it wins. Same shape in a cache posting its best hit rate while
  returning nulls. Score the answer first, the cost second, and name the non-answers. *Scar: a
  benchmark priced `impact` against grep at 5294x — the graph had answered `impactedCount: 0` in ~250
  tokens for a field it could not traverse, advising "confirm with a text search".*

- **GP-23** — **Verify the exit condition, not that the remedy ran.** A fix that completes is not a
  fix that worked: re-check the thing you were trying to clear. A remedy that recreates its own
  precondition looks identical to one that succeeded, because the action *did* succeed — retry
  storms, a cache-clear repopulating from the same bad source, a restart that re-runs the failing
  migration. *Scar: three skills answered "index is stale" with a bare `analyze`, which omits
  `--embeddings` — and an index without embeddings is stale by the contract's own definition.*

- **GP-24** — **A repair lands on the instance; go find the pattern's other instances.** Before
  closing a fix, search for the same shape elsewhere — the sibling is usually already written and
  usually still broken, and it is invisible because the bug you just understood makes the other one
  look obviously fine. *Scar: five in one session — the scorecard's label map was fixed for drift
  and `stats`, twenty lines away, was not; `.gitignore` had managed blocks while `.gitnexusignore`
  was overwritten wholesale; seed-once covered `hooks.json` and not the config beside it;
  `addedEngines` was recorded so uninstall could reverse it while `createdPackageJson` was not.*

- **GP-25** — **Reproduce the failure before you name its cause; a fix aimed at an unreproduced cause
  is a guess wearing a fix's clothes.** The plausible mechanism arrives before the evidence and feels
  like understanding, and everything downstream inherits it — the fix, the comment confidently
  explaining it, the check written to prove it. And point that check at **the code that actually
  broke, not the replacement you just wrote**: a negative test against your own new module exercises
  something that never existed on the broken branch, so it passes and certifies nothing. Restore
  pristine, make it fail, *then* fix. *Scar: a PDF worker failure was diagnosed as a bundler refusing
  to resolve a bare specifier inside `new URL(…, import.meta.url)`. A shared module and a `?url` fix
  were written and the negative test passed — because it tested the new module. The bundler resolves
  that specifier correctly. The real cause was an `if (!workerSrc)` guard that a dependency's major
  bump had silently invalidated by assigning a placeholder default at import time.*

- **GP-26** — **A measurement whose control arm cannot be seen moving is not evidence.** Prove the
  setup can register the change at all, then read it. Alternate the arms, repeat, report medians,
  print the confounder itself, and prefer one metric with no timing in it — "49 chunks after auth"
  vs "0" is the same claim with no variance to argue about. *Scar: four in one session, each a
  confident number. a localhost benchmark prices per-request latency at zero, so a change that
  removes round trips read as noise at −51ms and as −509ms at 40ms RTT — the same change, the same
  build. One run per arm reported an optimisation 800ms WORSE, because one arm refreshed an expired
  token and the other did not. A window bounded by a pattern match at BOTH ends read 0 on both arms
  — not "nothing loaded late" but "the pattern matched an earlier call and collapsed the window", and
  zero-because-fixed is indistinguishable from zero-because-mismeasured. And appending a comment to
  test cache invalidation produced byte-identical output and three unchanged hashes, which reads
  exactly like a pass: the minifier had eaten the only change. Corollary: "it got smaller" cannot
  tell a deferral that loads late from one that never loads — assert the request happened AND
  happened after the boot path.*

- **GP-27** — **A negative check answers before its data exists.** `role !== SUPPORT` is true while
  `role` is still undefined, so it silently answers a question it has no data for; `role === ADMIN`
  beside it is immune, and not because it was better guarded. When a check can run during boot,
  prefer the positive form or gate on the "have I loaded this" flag the store already keeps. The bug
  is not a missing guard — it is the direction of the comparison. Same family as GP-9: absence is
  being handled as if it were a value. *Scar: a support rep was shown terms they can never accept, on
  every page load.*
<!-- END GENERATED: gold-practices -->

## This project's own practices

**Everything below this line is yours. `bearing update` never touches it.** Numbered `PP-#` so a
citation can never collide with a bearing `GP-#` — they are renumbered upstream as rules are added.

Same bar as above: a rule earns its place with a **scar**. If it has no scar it is advice the model
already follows, and it costs context to say so. If a rule here turns out to be true of every
project rather than this one, it belongs upstream — say so and it can be promoted.

<!-- Carried over from this repo's own gold-practices when bearing split the file. -->

- **PP-1** — **When behaviour improves, the failing test is usually the thing that is wrong.**
  A test encodes a claim, and a claim can go stale exactly like a comment. After a fix, a red test
  has two readings — the change broke something, or the test pinned a detail the change was
  supposed to remove — and they are indistinguishable from the colour alone. Read what the test
  asserts before repairing the code to satisfy it, and when the assertion was about SHAPE
  (an identifier, an inline expression, a call site) rather than behaviour, rewrite the assertion
  to the behaviour it was standing in for. Otherwise the suite quietly becomes a ratchet that
  forbids improvement.
  *Scar: five times in one session — a guard asserting an inline filter that had been extracted, a
  copy test asserting a sentence that had been corrected, a field name that had been renamed. Each
  time the code was right and the test was the stale artefact.*

- **PP-2** — **Undo what YOU changed, not what the file was.** `git checkout <file>` restores from the
  index, so it discards every uncommitted change in that file — including the hours of work sitting
  next to the one line you were reverting. It is the natural reach after deliberately breaking code to
  prove a test fails, and it is silent: the command succeeds, the file looks plausible, and the loss
  surfaces later as a test that no longer covers anything. Invert the edit you made, or copy the file
  aside first and restore from the copy. Reserve `git checkout` for a file you have not touched since
  the last commit. *Scar: three times in one session, mutation-testing a guard then reverting with
  `git checkout` — once it wiped an uncommitted build-manifest change wholesale, once an INI-tweak
  warning that had to be retyped from the commit message, and each time the file compiled and the
  suite passed, so nothing announced it.*

- **PP-3** — **A type-checker cannot miss what a template cannot require.** Index-arithmetic
  edits to markup — find a start, find a close tag, splice — silently swallow the CONTENT
  between them, and the result still compiles, because children are optional in JSX, cells are
  optional in a table row, and a body is optional in most templates. The compiler proves the
  brackets balance, not that anything is inside them. Edit markup by matching a unique literal
  string, and after any bulk pass grep for the empty shape you might have created
  (`<div className="x"></div>`) and count a token you know must survive
  (`grep -c "{props.label}"` before vs after). *Scar: converting an inline style to a class by
  splicing from the style attribute to the next `</div>` deleted `{props.label}` from a stat
  tile — typecheck passed, 340 tests passed, and the only evidence was a blank label on a
  screen nobody had opened yet.*

- **PP-4** — **Where bad input is a silent no-op, enumerate the references and assert each
  resolves.** Some subsystems have no type system and no error channel: an undefined CSS custom
  property, a missing env var, an unregistered feature flag, an absent i18n key. They do not throw
  and do not warn — they evaluate to nothing, and the surrounding construct quietly degrades. CSS is
  the worst of them, because an unresolved `var()` invalidates the ENTIRE declaration: `border: 1px
  solid var(--typo)` is not a default-coloured border, it is no border. No compiler, linter, review
  or unit test sees any of this, because nothing is wrong with the *code*. The test that pays walks
  the real source, collects every reference, and asserts each one is declared — then proves itself by
  failing on an injected typo. *Scar: `--eh-accent`, `--eh-accent-soft`, `--eh-border` and
  `--eh-dur-quick` were never defined anywhere in the theme. Eight call sites across four pages,
  including the selected-state outline on two toggle controls — so "included" and "not included"
  rendered identically, with no border in either state. Typecheck was clean and 348 tests passed
  throughout; the audit that found it took twenty lines.*

- **GP-28** — **Never capture an immutable store's snapshot into a long-lived closure.** Redux and
  friends hand back the state *as it was*; a snapshot taken before an operation cannot see its
  result, and nothing about that reads as wrong at the call site. Take a getter, and prefer a
  signature that makes passing a snapshot a compile error rather than a runtime silence. *Scar: a
  bulk mod update built its "did the mod I asked for finish?" reader from `api.getState()` while
  assembling the run. Every later lookup searched a state in which the just-installed mod did not
  exist, read both ids back as `undefined`, failed the identity check on the RIGHT mod, and
  discarded the completion event as somebody else's. One mod updated; the run then sat out a
  fifteen-minute timeout. Changing the parameter to a getter caught all three call sites instantly.*

- **GP-29** — **An argument that looks like a label may be a discriminator.** Copy the literal from
  the host's own call site; never invent a descriptive value for a parameter you have not read the
  handler for. *Scar: `api.events.emit("mod-update", game, modId, fileId, "event-horizon-curator-tools")`
  — the host's own caller passes `mod.attributes.source` there, which reads like attribution. The
  handler opens with `if (source !== "nexus") return;`. It returned on its first line: no download,
  no error, and not one line in either log. The only diagnosis available was noticing the HOST's log
  was empty too.*

- **GP-30** — **A long silent step is indistinguishable from a hang.** Any step over roughly ten
  seconds must announce itself, and where the cost is a size, say the size — "hashing the package"
  is a puzzling wait, "hashing the package (9.4 GB)" is an explained one. *Scar: packaging a 9.4 GB
  collection was reported as frozen. It was computing the finished file's own checksum: minutes of
  reading, with the output file on disk no longer changing — the exact signature of a hang. The
  module had neither logging nor progress.*

- **GP-31** — **Log what a matcher REJECTS, not only what it accepts.** A discarded event and no
  event at all look identical from outside, and the rejection is where the bug lives. *Scar: a
  waiter matching install-completion events on identity logged only its success. When its identity
  source went stale it rejected the correct event every time, silently, and the failure presented as
  "nothing happened".*

- **GP-32** — **A heredoc eats backslashes; write code files with the file-writing tool.** A quoted
  shell heredoc still collapses `\` to `\`, which silently changes the MEANING of the code it
  carries. Three separate instances in one session: `` `\s${value}` `` in a template literal became
  `s...` and matched nothing; a CSS template literal was terminated early by a backtick in prose;
  and `` `${hive}\${key}` `` became `` `${hive}\${key}` `` — where `\$` is an escaped dollar, so it
  built the literal text `HKLM${key}`. That last one is the worst shape available: `reg` answered
  "no such key", exit 1, and the code *correctly* reported the runtime as ABSENT. A malformed query
  is indistinguishable from a genuine negative unless you check the query itself. None of the three
  was a type error and none failed a build; two were caught only by running the code against a
  machine whose real answer was already known. *Scar: a runtime detector reported all four
  Microsoft runtimes missing on a machine that plainly had them.*

- **PP-1** — **Optional-chained dispatch is a silent no-op wearing the shape of an action.**
  `api.store?.dispatch(setModEnabled(...))` returns `undefined` and reports success when `store` is
  absent, so "enable this mod" enables nothing, for every mod, with no error and no log. Check the
  optional thing explicitly and SAY when it is missing; `?.` belongs on reads, not on the call that
  IS the effect. *Scar: four exported functions in the profile spine — create, switch, enable,
  disable — every one of them a no-op under a missing store, and the module had no test file at all.
  The user-visible symptom is "Event Horizon installed the mods but they are all still disabled",
  which is indistinguishable from an install that never ran.*

- **PP-2** — **`vi.spyOn` on an already-spied method returns the SAME spy, call history and all.**
  A `beforeEach` that re-spies without `mockClear()` lets test N find test N-1's line, so an
  assertion passes against the wrong evidence — and it passes, which is why nothing points at it.
  Clear the spy, and prefer `expect(spy).toHaveBeenCalled()` alongside the payload check so an
  assertion that finds nothing fails instead of vacuously succeeding. *Scar: a test asserting a
  no-store profile creation logs at `error` read the `info` line from the previous test's
  successful creation, and only failed because the LEVEL happened to differ. Had both been `info`
  it would have passed while testing nothing.*

- **PP-3** — **`Promise.race` does not stop the loser; it only stops listening to it.** The losing
  promise keeps every timer, subscription and watchdog it owns, and when one of those fires it
  rejects a promise nobody is awaiting — an unhandled rejection, arbitrarily long after the work it
  was watching finished. Stand the loser down explicitly in a `finally`, and attach the catch BEFORE
  cancelling, because cancelling settles by rejecting. *Scar: three race sites in the installer each
  abandoned a completion waiter. Ten of them fired in the same millisecond during the verify phase
  of a 1755-mod install, reporting `install.stalled` for mods that had gone in hours earlier. A
  fourth site had already been fixed and its `cancel()` doc described the bug; the comment at one of
  the three claimed "the other settles silently", which was simply false.*

- **PP-4** — **Build an exclusion list from the data, not from what sounds excludable — and test
  the KEEPS.** Every entry on such a list is verification given up, and the failure mode is silent:
  an over-broad rule stops checking real content and looks exactly like success. Read the real
  corpus first. *Scar: filtering unverifiable files out of a 354,819-file capture, two confident
  guesses were both wrong — `.bak` and `.old` are shipped content (a FaceGen mesh, an MCM settings
  backup), and `.0`–`.3` are not rotated logs but OpenSSL CA files Nemesis ships. Both are now
  pinned as tests that fail if the rule widens. Scope the rule by what it IS, too: the log that
  proved the case lived at `textures/aatj/armor/debug.log`, so a path rule scoped to `SKSE/Plugins`
  would have missed it — and matching by name instead covered Fallout 4 for free.*

- **PP-5** — **A derived count is a claim, and the wrong subtraction lies confidently.** Check what
  each operand actually contains before reporting a difference between them. *Scar:
  `goneSinceRecorded: journal.length - owned.size` reported "the user removed 1591 mods between
  runs" on a machine where nothing had been removed — `owned` deliberately excludes adopted entries
  and `journal.length` counts them, so the figure was exactly the adopted count every time. The
  function had no test.*

