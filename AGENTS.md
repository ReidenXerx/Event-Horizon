<!--
The block below is hand-maintained behavioral guidance and lives OUTSIDE the
gitnexus auto-generated markers on purpose: `npx gitnexus analyze` regenerates
everything between the markers above, but anything below is preserved.

Full reference: .cursor/rules/gitnexus.mdc (alwaysApply: true)
-->

## First move — before any code-understanding tool

This repo is GitNexus-indexed as `Event-Horizon`: 7391 symbols, 17846 edges, 401 execution flows, 295 clusters, **6537 vector embeddings**. GitNexus tools are the *primary* navigation surface, NOT a "remember to use this." Before reaching for `Grep`, `Glob`, `Read`, or `SemanticSearch`, ask: "Could a GitNexus tool answer this in one shot?" Almost always: yes.

| Intent | First-move tool |
| --- | --- |
| "how does X work?" / "trace this" / fuzzy concept lookup | `gitnexus_query({query: "..."})` (hybrid BM25 + **vector embeddings**) |
| "what calls X?" / 360° view of one symbol | `gitnexus_context({name: "X"})` |
| "what breaks if I change X?" / pre-edit safety | `gitnexus_impact({target: "X", direction: "upstream"})` |
| "did my edits affect anything else?" / pre-commit | `gitnexus_detect_changes({scope: "unstaged"})` |
| "rename X to Y" | `gitnexus_rename({symbol_name: "X", new_name: "Y", dry_run: true})` |
| "what does endpoint /api/x do?" | `api_impact({route: "/api/x"})` |
| "find all writers/readers of field foo" | `gitnexus_cypher` with `ACCESSES` (`reason: 'write'` or `'read'`) |
| Codebase orientation / functional areas | READ `gitnexus://repo/Event-Horizon/clusters` |
| Step-by-step trace of a flow | READ `gitnexus://repo/Event-Horizon/process/<name>` |

`Grep` / `Glob` are appropriate ONLY for: string literals, comments, raw text in JSON/YAML/MD, config keys not modeled in the graph, or exact-string lookups where you already know what you want.

## Anti-patterns — STOP and reconsider

- About to `Grep("functionName")` → STOP. Use `gitnexus_context({name: "functionName"})` — returns callers, callees, file location, and processes the symbol participates in.
- About to `Read` a file end-to-end to "see what it does" → STOP. Use `gitnexus_query` for the concept, then `gitnexus_context` on returned symbols. `Read` is for exact bytes only.
- About to do `git diff | grep` to assess a change → STOP. Use `gitnexus_detect_changes` — maps hunks to symbols, processes, and risk level.
- About to find-and-replace for a rename → STOP. Use `gitnexus_rename` with `dry_run: true` (graph edits vs text_search edits are tagged separately).
- About to skip impact analysis to "save a tool call" before editing → STOP. Workspace contract requires `gitnexus_impact` before editing any function/class/method.
- Tool returned multiple candidates for a name → DO NOT GUESS. Re-call with `uid` / `target_uid` from the ranked list.

## Full feature surface — don't forget any of this

**Tools:** `query`, `context`, `impact`, `detect_changes`, `rename`, `cypher`, `api_impact`, `route_map`, `shape_check`, `tool_map`, `list_repos`, `group_list`, `group_sync`.

**Embeddings (6537):** `query` fuses BM25 + vector via RRF. Both rankers depend on LadybugDB extensions that need OpenSSL 3 DLLs on PATH; when they are missing the MCP server silently degrades to *no* keyword search and an exact-scan vector fallback capped at 10k chunks. Check with `gitnexus doctor` — it must say `Full-text search: available` AND `Semantic mode: vector-index`. A CLI probe is NOT a valid test: the Bash tool's shell snapshot already has the DLLs on PATH, so the CLI passes while the MCP server fails. Pass `task_context` and `goal` to sharpen ranking. Embeddings persist across `npx gitnexus analyze` unless you pass `--drop-embeddings`.

**Resources** (lightweight, 100-500 tokens — read these first to orient):

- `gitnexus://repo/Event-Horizon/context` — stats + staleness check
- `gitnexus://repo/Event-Horizon/clusters` — all 295 functional areas with cohesion + keywords
- `gitnexus://repo/Event-Horizon/processes` — all 401 execution flows
- `gitnexus://repo/Event-Horizon/process/<name>` — step-by-step trace of one flow
- `gitnexus://repo/Event-Horizon/schema` — full graph schema (read before writing Cypher)

**Edge types** (filter `CodeRelation` by `type`): `CALLS`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, `HAS_METHOD`, `HAS_PROPERTY`, `METHOD_OVERRIDES`, `METHOD_IMPLEMENTS`, **`ACCESSES`** (with `reason: 'read'` or `'write'` — use this for field-level data-flow tracing), `DEFINES`, `MEMBER_OF`, `STEP_IN_PROCESS`, `HANDLES_ROUTE`, `FETCHES`, `HANDLES_TOOL`, `ENTRY_POINT_OF`.

**Group mode** (cross-repo / monorepo): pass `repo: "@<groupName>"` (or `"@<groupName>/<member>"`) to `query` / `context` / `impact` for cross-boundary analysis via the Contract Registry.

**Index freshness:** every tool reports staleness. On a stale-warning, run `npx gitnexus analyze` (preserves embeddings) and retry the failed tool.

For the full reference (Cypher recipes, disambiguation discipline, per-task workflows), see `.cursor/rules/gitnexus.mdc`.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Event-Horizon** (13684 symbols, 37615 relationships, 587 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "master"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "master" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- Explore with `query({search_query: "concept"})` for process-grouped flows.
- Use `context({name: "symbolName"})` for callers, callees, and flows.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/Event-Horizon/context` | Codebase overview, check index freshness |
| `gitnexus://repo/Event-Horizon/clusters` | All functional areas |
| `gitnexus://repo/Event-Horizon/processes` | All execution flows |
| `gitnexus://repo/Event-Horizon/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |
| Work in the Curator area (567 symbols) | `.claude/skills/gitnexus-area-curator/SKILL.md` |
| Work in the Manifest area (529 symbols) | `.claude/skills/gitnexus-area-manifest/SKILL.md` |
| Work in the Installer area (392 symbols) | `.claude/skills/gitnexus-area-installer/SKILL.md` |
| Work in the Build area (244 symbols) | `.claude/skills/gitnexus-area-build/SKILL.md` |
| Work in the Environment area (109 symbols) | `.claude/skills/gitnexus-area-environment/SKILL.md` |
| Work in the Install area (100 symbols) | `.claude/skills/gitnexus-area-install/SKILL.md` |
| Work in the Doctor area (70 symbols) | `.claude/skills/gitnexus-area-doctor/SKILL.md` |
| Work in the Scripts area (65 symbols) | `.claude/skills/gitnexus-area-scripts/SKILL.md` |
| Work in the Ui area (63 symbols) | `.claude/skills/gitnexus-area-ui/SKILL.md` |
| Work in the Resolver area (54 symbols) | `.claude/skills/gitnexus-area-resolver/SKILL.md` |
| Work in the Actions area (38 symbols) | `.claude/skills/gitnexus-area-actions/SKILL.md` |
| Work in the Identity area (30 symbols) | `.claude/skills/gitnexus-area-identity/SKILL.md` |
| Work in the Pages area (28 symbols) | `.claude/skills/gitnexus-area-pages/SKILL.md` |
| Work in the Table area (26 symbols) | `.claude/skills/gitnexus-area-table/SKILL.md` |
| Work in the Runtime area (21 symbols) | `.claude/skills/gitnexus-area-runtime/SKILL.md` |
| Work in the Components area (20 symbols) | `.claude/skills/gitnexus-area-components/SKILL.md` |
| Work in the Errors area (19 symbols) | `.claude/skills/gitnexus-area-errors/SKILL.md` |
| Work in the E2e area (15 symbols) | `.claude/skills/gitnexus-area-e2e/SKILL.md` |
| Work in the Cluster_1 area (13 symbols) | `.claude/skills/gitnexus-area-cluster-1/SKILL.md` |
| Work in the Cluster_264 area (12 symbols) | `.claude/skills/gitnexus-area-cluster-264/SKILL.md` |

<!-- gitnexus:end -->
