# Skill: triage-old-worktrees

# Triage Old Worktrees

## When to Use

Use this skill when the repo has accumulated worktrees in `.worktrees/` whose branches may or may not have been merged into `main`. This skill provides a systematic, agent-driven process to classify each worktree and produce a clear action plan.

## Prerequisites

- `origin/main` is the integration branch.
- Worktree branches start from `origin/main` and target PRs to `main`.
- **Do NOT assume merge-commit-only PR workflow.** Real repos mix merge commits and squash merges. A squash-merged branch tip is NEVER an ancestor of `origin/main`, so ancestor checks alone produce false "unmerged" results (observed: 5+ fully-landed branches flagged as distinct in one audit). Use the layered merged-detection in Step 1.
- `git cherry` (patch-id equivalence) does NOT detect squash merges — squashing combines commits, so patch-ids change. Do not rely on it.

## Process Overview

```
01-baseline     → scripts/collect-baseline.sh gathers per-worktree git metrics
02-first-pass   → one subagent scans all candidate worktrees for novel work
03-second-pass  → parallel deep-dive subagents for meaningful worktrees
04-aggregate    → verdicts.jsonl + scripts/aggregate.py → final-report.{md,csv,html}
```

All outputs live under `.worktrees/<analysis-wt>/triage-output/` (a single subdirectory keeps the analysis worktree clean and the report set trivially committable).

Create the analysis worktree from `origin/main` first, e.g.:

```
git worktree add .worktrees/worktree-triage-YYYYMMDD -b triage/worktrees-YYYYMMDD origin/main
```

---

## Step 1: Baseline Metrics & Criteria

Run the collected-metrics script (read-only, safe to re-run):

```
bash <skill-dir>/scripts/collect-baseline.sh .worktrees/<analysis-wt>/triage-output origin/main
```

This writes `triage-output/baseline-data.jsonl`, one JSON record per worktree.
The collector skips the main checkout, the analysis worktree itself, and
hidden/dot-prefixed worktree names (transient scratch like `.base-gate-$$`).
Fields:

```
name, path, branch ("DETACHED" if detached), head, date (last commit),
ancestor (YES/NO vs main), ahead, behind,
dirty (status --porcelain line count), dirtySample,
footprintFiles (files the branch touched since merge-base),
footprintDiffersVsMain (of those, how many differ between branch tip
                        and the current main tree)
```

### Merged-detection ladder (apply in order)

1. `ancestor=YES` → merged. (For detached HEADs this is the common landed shape.)
2. `ancestor=NO, footprintFiles>0, footprintDiffersVsMain==0` → contents match main exactly on the branch's own footprint → landed via squash/re-play. Confirm by the first pass reading the residual anyway (cheap).
3. `ancestor=NO, footprintDiffersVsMain` small (≤3) → "near-landed": the residual diff is either post-merge forward evolution or a tiny unmerged residue. First pass must READ that diff and judge.
4. Otherwise → clearly distinct work.

Never classify merged-ness from ancestor status alone whenever the repo uses squash merges.

### Triage categories

**Category A — Auto-skip / safe to delete after dirty-check:**
- ancestor=YES AND clean tree.
- ancestor=YES AND dirty → still lands here, but the dirty files must be inspected (see below) — uncommitted work in a merged worktree is the #1 silent-loss risk in this whole procedure. Untracked agent litter (`.the-usual-*`, `.claude/`, `node_modules`, regenerated gate artifacts) does not count as real work.
- Detached HEAD + ancestor + clean.

**Category B — First-pass only (quick inspection):**
- Near-landed (footprintDiffersVsMain ≤3).
- Doc/plan-only namespaces **as derived from the actual data** (see below).

**Category C — Deep-dive required:**
- Clearly distinct work.
- Any worktree whose uncommitted (dirty) content is judged real.

### Derive branch namespaces from the repo — do not use fixed lists

Don't hardcode "plan-like" prefixes (`plan/*`, `docs/*`, `proof-*`…) — they silently misclassify in real repos. Example observed failure: `the-usual/*` branches are real automation *work products* (not plans), while `docs/*`, `investigation/*`, `release/*`, `build/*`, plus campaign namespaces like `df1/gate-*`, were the actual doc/meta ones. Build the namespace → category map from the first-pass evidence (what the commits actually touch), and state it explicitly in `baseline-criteria.md`.

### Scope & time window

Default scope = **ALL worktrees in `.worktrees/`** (if they're being triaged, they're stale by definition). Only filter by date if the user asks for it.

### Output

Write `triage-output/baseline-criteria.md`: the merged-detection ladder, the measured bucket distribution (ancestor/near-landed/distinct/dirty counts), the derived namespace map, and the verdict vocabulary (below).

---

## Step 2: First Pass — Novel Work Detection

Deploy **one fresh (no-context) subagent** to scan all worktrees in scope. Hand it `baseline-data.jsonl` + `baseline-criteria.md`; its job is the qualitative pass.

### Checks per worktree

```bash
git -C <path> log --oneline origin/main..HEAD | head -8   # what is this
git -C <path> status --porcelain                           # if dirty>0
git -C <path> diff --stat                                  # if tracked dirty
# near-landed: read the residual diff on the branch's own footprint
git diff <HEAD> origin/main -- $(git diff --name-only $(git merge-base origin/main <HEAD>)..<HEAD>)
```

Judge per worktree: **meaningful?** (unmerged or uncommitted work that might matter) and a 3–8 word summary from commit subjects.

### Output

- `triage-output/first-pass-table.md` — one row per worktree: worktree | branch | date | ancestor? | status | commits ahead | files Δ | meaningful? | summary.
- `triage-output/worktrees-to-deep-dive.txt` — one worktree name per line: all clearly-distinct worktrees, near-landed ones with real residue, and merged-but-dirty ones with real uncommitted work.

Contract for the subagent's return message: counts, the deep-dive list, ≤5 surprises, any errors — under 400 words. Full tables go in the files, not the message.

---

## Step 3: Second Pass — Deep Evaluation

Deploy **multiple fresh subagents in parallel**, grouped by topic area (3–4 worktrees per subagent). Derive groups from the first-pass summaries so each subagent's worktrees share a domain (e.g. UI polish, session restore, campaigns, infra).

### Verdict categories

1. **ready-landing** — done, useful, never landed.
2. **finish-work** — significant useful progress, incomplete.
3. **throw-away-useless** — dead end / mistake / superseded.
4. **in-main** — functionality already on `origin/main` (possibly squash-merged).

Plus metadata: `confidence` (high|medium|low) and `land-effort` (none|tiny|small|medium|large — effort to land any remaining value).

### Deep-dive checks

1. **Git analysis:** `log origin/main..HEAD`, `diff --stat $(merge-base)..HEAD`.
2. **In-main check:** footprint diff vs main (squash-landed?) + grep origin/main for distinctive identifiers + `git log origin/main --oneline --grep=<keywords>`.
3. **Supersession check:** does current main implement the same capability differently and newer?
4. **Bug-still-exists check:** read current main code for the scenario the branch addresses.
5. **Uncommitted-work check:** if dirty, read the actual dirty diff — never trust `status` line counts. Judge salvage value. Flag "do not delete until archived/committed" loudly when real.
6. **Tests (optional, only when verdict-changing):** check for `node_modules` in the worktree FIRST — stale worktrees often lack it; do not install dependencies. Run only focused patterns (`npm run test:vitest -- run <pattern>`, or the repo's equivalent); never broad suites; never use the shared test coordinator's broad gates from a triage deep dive.
7. **Anti-poison check:** explicitly call out any file that must never be committed (deliberate red-proof mutations, temp diagnostics) and any branch that is the *only copy* of its work (unpushed).
8. Look for context on main since the branch point — the branch's topic area may have been heavily reworked (check recent merge/squash subjects).
9. **Never defer the verdict to the user.** If in doubt, dig more.

### Output contract

Each subagent writes ONE report at `triage-output/deep-dive/NN-<topic>.md`. Per worktree, a section starting with a strict front-matter block (the aggregator depends on this shape):

```yaml
worktree: <name>
branch: <branch>
date: <last-commit-date>
ahead: <n>
behind: <n>
verdict: <ready-landing | finish-work | throw-away-useless | in-main>
confidence: <high|medium|low>
land-effort: <none|tiny|small|medium|large>
```

then an Evidence section (cited commits/diffs/grep results/file paths — evidence over vibes) and a Recommendation (2–5 sentences).

Return message: one line per worktree (`name: verdict (confidence) — reason`), ≤3 surprises, under 250 words.

---

## Step 4: Aggregate Final Report

Do this step **deterministically — not by subagent**. (Observed failure: an aggregation subagent returned empty output and died on resume; the output contract is fully mechanical, so code beats an agent here and is re-runnable after any adjustment.)

1. The orchestrator (you) reads all `deep-dive/*.md` files and authors `triage-output/verdicts.jsonl` — one JSON object per line:

```json
{"name": "...", "verdict": "finish-work", "confidence": "high", "land_effort": "small", "analysis": "1-2 sentence evidence summary", "deepdive": "deep-dive/03-campaigns.md"}
```

Condense each deep-dive's Evidence/Recommendation into `analysis`. Also add entries for any non-deep-dived worktrees that deserve better than the automatic derivation (e.g. plan branches whose plans have standalone value — flag as kata candidates in `analysis`). `deepdive` is optional; omit it for derived rows.

2. Run:

```
python3 <skill-dir>/scripts/aggregate.py .worktrees/<analysis-wt>/triage-output origin/main
```

It validates that every worktree in `worktrees-to-deep-dive.txt` has a verdict, writes `final-report.csv` (74-column-safe CSV, one row per baseline record) and `final-report.html` (self-contained, sortable/filterable, verdict-filter buttons, color-coded, links into `deep-dive/`), and prints verdict counts. Cross-check the printed counts against the first-pass table totals.

3. Hand-author (or delegate, but then VERIFY the file exists and is non-empty) `triage-output/final-report.md`: executive summary with verdict counts, one section per action priority (ready-landing → finish-work → in-main → throw-away → skipped), per-item narratives for the first two sections, a full reference table pointer, and a numbered "recommended next actions" list. Include a Cautions subsection listing anything destructive-yet-tempting (poison files, unpushed only-copies, uncommitted WIP).

4. Verify the HTML renders (open it, check row count + a filter click). Then commit the whole `triage-output/` tree on the analysis branch.

### `final-report.csv` columns

`num,worktree,branch,date,verdict,confidence,land_effort,category,analysis`

Categories: `ready-landing`, `finish-work`, `in-main`, `throw-away`, `skipped-plan`, `skipped-trivial`.

---

## Expected Outcomes

```
.worktrees/<analysis-wt>/triage-output/
├── baseline-criteria.md
├── baseline-data.jsonl
├── first-pass-table.md
├── worktrees-to-deep-dive.txt
├── deep-dive/
│   ├── 01-<topic>.md
│   └── ...
├── verdicts.jsonl
├── final-report.md
├── final-report.csv
└── final-report.html
```

The final report tells you:
- Which worktrees are deletable (in-main / throw-away / skipped)
- Which to land (ready-landing)
- Which need finishing and what's blocking (finish-work)
- Which contain uncommitted or unpushed work that deletion would silently destroy (the real point of the exercise)

## After the Audit — approval gates

Deletions destroy uncommitted/unpushed work by design; PRs and katas mutate the shared repo state. Therefore, per repo policy, present the report and get explicit user approval before acting. Then, in priority order:

1. **Protect loss-risk items first:** commit/extract uncommitted WIP; push unpushed only-copies as archive branches; land salvageable untracked files (tests, docs) via normal PRs.
2. Delete worktrees in `in-main` / `throw-away` / `skipped` (only after step 1 clears their cautions).
3. Create PRs for `ready-landing` branches (after the repo's normal broad gate).
4. File katas for `finish-work` items, referencing worktree paths + deep-dive assessments.

## Pitfalls (observed)

- **Squash merges defeat ancestor checks.** Use the footprint ladder, always.
- **Uncommitted work is where the bodies are buried.** A "merged" worktree can hold the most valuable uncommitted diagnostics in the repo. Always read dirty diffs.
- **A branch can add nothing to git history and still look busy** — e.g. a fix that was merged, then reverted, leaves the worktree byte-identical to a reverted PR. Compare against the merged-and-reverted possibility explicitly.
- **"Partially landed" is usually post-merge forward evolution**, not residue — read the actual residual diff before flagging.
- **Only-copy branches** (unpushed) must be called out before any deletion list is acted on.
- **Verify subagent artifacts exist.** An agent claiming completion proves nothing; check the files.
- Keep every subagent's return message small; artifacts carry the detail.
