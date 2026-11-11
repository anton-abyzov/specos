<!-- SW:META template="agents" version="3.1.22" sections="header,loop,rules" -->

<!-- SW:SECTION:header version="3.1.22" -->
# spec-os

SpecWeave increments live in `.specweave/increments/NNNN-slug/spec.md`: Problem, Scope, Acceptance Criteria, Approach and Tasks. `ledger.jsonl` records claims and completions. Start with `specweave pickup`.
<!-- SW:END:header -->

<!-- SW:SECTION:loop version="3.1.22" -->
## The loop

1. `specweave pickup`: applies the latest handoff, prints the open increment, next task and ACs, claims, branch, notes and memory.
2. New work needing ACs or handoff: `specweave create-increment "title"`, then fill spec.md. Ask only critical decisions, one at a time with a recommendation, and record them under `## Decisions` (sw-increment). If an open increment owns the files, add ACs and tasks there. Skip it for one PR under ~300 changed lines, a follow-up fix, a UI tweak or an investigation: `specweave small-fix "<why>"`. Plan multi-day work, cross-platform changes, auth, payments, migrations and work another tool or machine will pick up; these win over size. Close what you open: its plan ends with "Verify and close NNNN".
3. Work the task inside its Files, commit as `NNNN: what changed`, then `specweave task done T-NN --run "<its Test>"` (it claims the task). Parallel agents run `specweave task claim T-NN` first. `--line`/`--link` feed `specweave cards --md`.
4. When the last task is done or skipped, without asking: `specweave verify`, a fresh-context review (subagent or new session) for anything that ships, `specweave complete NNNN`. PR-shipped work needs `task done` first.
5. Stopping with tasks left, or switching tools: `specweave handoff --reason "<why>"`.

**Handoff.** When the user says "hand off", "out of tokens" or "switching accounts", or "[Usage limit reached" appears (not in auto-handoff checkpoint mode), run `specweave handoff --reason "<why>"`; tell them to say "pick up" in the other tool. Other usage notes mean keep working; say so. When the user says "pick up", run `specweave pickup`; continue through step 4, passing any given id/title. Take the newest handoff if several; say which.

Tasks in spec.md: `### T-01 Title`, then `- AC: AC-01 | Files: src/a.ts, tests/e2e/a.test.ts | Test: npm test -- e2e/a`. ACs derive from done tasks. Notes: `specweave note "<text>"`. Skills: `.agents/skills/sw-*` and `.claude/skills/sw-*`; other tools: `npx vskill install anton-abyzov/specweave/sw-do`.
<!-- SW:END:loop -->

<!-- SW:SECTION:rules version="3.1.22" -->
## Rules

- A task is done when its Test exits 0 and you have seen the real output. A Test checks the AC as users would (CLI, HTTP, UI, API); add unit tests only when asked or when config or conventions require them. Never skip, weaken or delete a test to pass, and never set a status by hand.
- One agent per branch. Claims older than 2h are stale. On `ledger.jsonl` conflicts keep both sides' lines.
- Commit durable decisions in spec.md Approach or one fact per file in `.specweave/memory/`, indexed in `MEMORY.md`, for all tools.
- Check a secret exists without printing it; never commit `.env*`.
- Without the CLI, append ledger lines yourself, one JSON object per line, UTF-8, LF: `{"t":"T-01","e":"claim","by":"<tool>@<host>","at":"<ISO time>"}` (`e` is claim, done, release, skip or block; `done` needs `"evidence":"<commit sha>"`, `skip` needs `"note":"<why>"`).
<!-- SW:END:rules -->

## Commands

| Action | Command |
|---|---|
| Build | TODO: not detected — fill in the build command |
| Test | TODO: not detected — fill in the test command |
| Lint | TODO: not detected — fill in the lint command |

If a cell still says TODO, fill it in from `package.json`/`Makefile` and commit; `specweave verify` runs these rows.

## Project notes

(architecture map, things agents get wrong here, recurring mistakes; keep it short)
