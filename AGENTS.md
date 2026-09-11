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
