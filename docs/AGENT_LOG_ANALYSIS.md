# Agent Log Analysis Guide

Use this guide when the user asks to analyze agent chat logs, rollout JSONL files, or agent-viewer exports in order to improve agent instructions, helper scripts, or repo structure.

## Goal

Find workflow waste that should be fixed at the instruction or repo-helper level, not just inside one session.

Prioritize issues that repeatedly cost:

- extra tool calls
- extra context tokens
- extra latency
- extra human supervision
- fragile recovery steps

## Primary Inputs

- Raw Codex rollout logs such as `status-ui/agent-viewer/temp/*.jsonl`
- Cleaned copies exported by the agent viewer when available
- Related instruction files such as `AGENTS.md`, `CLAUDE.md`, repo-local instructions, and workflow docs
- Existing helper scripts under `bash/`, `package.json` scripts, and repo-local scripts

## First Command

For read-only rollout analysis, do not run a sync that moves submodule checkouts.
Read this guide and use the reusable streaming JSONL summarizer instead of ad
hoc `node -e` probes. It redacts generated-image/base64 payloads while keeping
line numbers, saved paths, prompts, and byte counts:

```bash
yarn agent:analyze-log <rollout.jsonl> --all
```

`--all` includes workflow-waste findings. When the user primarily asks what to
improve in the agent flow, `--workflow-waste` is the focused mode; run it first,
then inspect only the cited lines before proposing instruction or helper changes.

If repo context is also needed, use `bash bash/task-context.sh --skip-pull status`
so the safety scan does not detach active submodules just to inspect logs.

## Required Mindset

- Treat the user request as the source of truth. Judge whether the agent actually moved toward that request.
- Treat each meaningful part of the user's wording as potentially binding. Check whether every requested action, constraint, preference, and success condition was actually noticed, interpreted correctly, and handled.
- Answer the user's stated symptom first, but do not stop there. Also inspect adjacent tool-call and write patterns for independent workflow waste that the user may not have named yet.
- Optimize for reusable fixes. Prefer “add one helper and one instruction rule” over “the agent should think harder”.
- Distinguish one-off noise from repeated failure patterns.
- Keep authored instructions concise. Only propose new rules that are actionable and testable.

## What To Look For

### 1. Repeated ad hoc command sequences

Find command clusters that the agent assembled manually during the run and that should become a script, yarn helper, or documented one-liner.

Examples:

- repeated multi-repo status checks
- repeated branch validation before push
- repeated `git -C` loops
- repeated grep/sed/read sequences to answer one stable question
- repeated cleanup/recovery flows after common failures

For each candidate, answer:

- Was the sequence repeated in the same run or across related runs?
- Is the sequence deterministic enough for a helper?
- Should the fix be a repo script, a hub helper, or an instruction rule?

### 2. “Simple task became many attempts”

Look for cases where a small user request triggered too many exploratory commands, retries, or long reasoning loops.

Examples:

- user asked to push, but the agent wandered through many git probes
- user asked for a file path or status, but the agent read many unrelated files
- user asked for one command result, but the agent spent time planning instead of executing

Flag when:

- the task had an obvious helper that was not used
- the agent ignored an existing workflow rule
- the agent lacked a crisp fallback for common failure modes

### 3. Context waste from oversized reads

Find large reads that did not materially help solve the task, especially when a smaller or aggregated read would have been enough.

Examples:

- opening huge instruction blocks repeatedly
- reading large source files when a targeted `rg` plus narrow `sed` window would do
- pasting full command output where a summarized helper already exists
- using raw logs when the cleaned viewer export would be enough

For each case, decide whether the fix is:

- instruction tightening
- file splitting
- a new summary doc
- a new helper script
- a recommendation to use cleaned exports first

### 4. Avoidable serial exploration

Find cases where the agent asked one question with many sequential read-only commands instead of one aggregated helper or one parallel batch.

Examples:

- multiple `git status` calls across repos instead of `yarn status:all`
- repo-by-repo search instead of `yarn find:repos`
- repeated file existence checks that could be answered by one `rg --files`

### 5. Failure-recovery friction

Look for recurring failure classes where the agent had to improvise recovery.

Examples:

- dirty worktree blocked pull
- detached HEAD confusion
- wrong working directory
- stale worktree checkout conflicts
- branch mismatch before pointer update

When this appears, check whether:

- a helper already exists but instructions failed to steer the agent to it
- a helper is missing and should be added
- the instructions need an explicit stop condition and recovery sequence

### 6. Instruction drift or overload

Find places where the current instructions are causing waste.

Examples:

- rules are too long, so the agent rereads large blocks often
- important workflow rules are buried and easy to miss
- two instruction sources overlap or conflict
- a rule says “use helper X”, but helper X is absent, unclear, or incomplete

Prefer fixes such as:

- move niche workflows into focused docs
- add “read this doc when asked about X” routing lines
- shorten top-level rules and point to narrower docs

### 7. User-request coverage gaps

Check whether the agent actually handled all meaningful parts of the user's request, not just the broad theme.

Examples:

- one requested deliverable was never produced
- a constraint was ignored
- a preference was noticed late and caused rework
- the agent solved an adjacent problem instead of the one asked
- the response partially answered the request but skipped a specific user phrase
- the agent emitted `task_complete` after a failed validator while saying the result was partial, not complete, or still blocked

For each gap, answer:

- Which exact user wording was missed, misread, or under-weighted?
- Did the agent ignore it, reinterpret it, or forget it during execution?
- Would a better instruction have prevented the miss?
- Should the fix be a general instruction about request parsing, or a narrow workflow-specific rule?

### 8. Symptom-adjacent workflow waste

When a user reports one visible symptom, still scan the surrounding log for independent waste patterns that contributed to the session cost or fragility.

Examples:

- creating a temporary executable script inside an authored output folder
- creating or patching temporary authoring scripts under `/tmp` or `/private/tmp`
- create-run-debug-delete loops for one-off generators
- repeated manual markdown or JSON repairs that could be a structured apply helper
- ad hoc staging directories or generated files that were not validated before later stages
- a problem only recognized after the user points to a screenshot or hidden reasoning/tool trace

For each candidate, answer:

- Was the evidence present in the original log before the user pointed it out?
- Did the agent report it in the first analysis, or only after a follow-up prompt?
- Should this become a helper, a stricter workflow instruction, or a checklist item in the analysis guide?
- If the user later says "fix all of it", was this candidate preserved as an implementation requirement rather than downgraded to advice?
- For week-review logs, did `yarn agent:analyze-log --workflow-waste` report `Review handoff completed after failed validation`? If yes, check whether the agent should have continued via `yarn review:week:run-to-pass <performer> <week>` instead of waiting for a user "finish it" message.
- For week-review screenshot/source repairs, inspect whether the agent created local-only screenshots, specs, or provenance files to appease validation. That is a flow regression; valid repairs use tracked real E2E artifacts, tracked review artifacts, or remove the unsupported screenshot claim.

## Method

1. Freeze scope.
   Record the exact user ask, the target repos, and the expected outcome.

2. Decompose the user request.
   Build a compact checklist of the user's wording:
   - requested actions
   - constraints
   - preferences
   - non-goals
   - explicit deliverables
   - implied success conditions that are clearly stated in the wording

3. Build a compact timeline.
   Extract:
   - user asks
   - assistant commentary updates
   - tool calls
   - failures
   - retries
   - final outcome

4. Score request coverage.
   For each checklist item, mark it:
   - handled correctly
   - handled late
   - handled incorrectly
   - not handled

5. Cluster waste patterns.
   Group repeated reads, repeated command families, retry loops, and large-context moments.

6. Compare against existing helpers and instructions.
   Check whether the agent missed an existing script or whether the repo lacks one.

7. Propose the smallest reusable fix.
   For each issue, prefer one of:
   - add helper script
   - add/update yarn script
   - add targeted instruction rule
   - split a large doc into focused docs
   - add a “use cleaned export first” note

8. When the user asks what recent agent-flow change caused a regression, extract commits from the rollout before concluding.
   Use message timelines, `git commit` outputs, compare links, branch pushes, and `git diff` commands in the log to identify the helper/doc commits involved. Then inspect those diffs or `git blame` for the behavior boundary that changed, especially validators, final gates, staged authoring helpers, screenshot helpers, generated-evidence collectors, and instructions.

9. Check for symptom-adjacent misses.
   Ask whether the log contained optimization targets that were outside the user's stated symptom but still visible in tool calls, patches, retries, or temporary files.

10. Rank by leverage.
   Put high-frequency and high-latency problems first.

10. Report workspace state.
   End the result with the dirty repos or submodules that matter to the analysis.
   If a recommended fix would require cleaning, checking out, or moving a dirty repo,
   ask the user before doing that cleanup and name the exact repo/path.

## Evidence Rules

- Quote only the minimum log snippets needed to prove the pattern.
- Do not dump full logs into the report.
- Prefer counts and concise examples:
  - “7 git probes before first push attempt”
  - “3 large file reads where one `rg` would have answered the question”
  - “same multi-repo loop handwritten twice”
- Separate observed evidence from your inference.

## Output Format

Produce a markdown report with these sections:

## Source Request

- Original user request
- Scope analyzed
- Assumptions

## Request Coverage

For each meaningful part of the user's wording include:

- User wording or a tight paraphrase
- Coverage status:
  - handled correctly
  - handled late
  - handled incorrectly
  - not handled
- Evidence from the log
- If not handled correctly, the proposed instruction fix

## High-Leverage Findings

For each finding include:

- Title
- Why it is wasteful
- Evidence from the log
- Root cause
- Recommended fix type:
  - helper script
  - instruction change
  - file split / doc restructure
  - existing-helper adoption
- Concrete proposed change

## Proposed Instruction Changes

- Exact instruction additions, removals, or rewrites
- Where each change should live

## Proposed Repo Helpers

- Helper name
- What it should do
- Which repeated pattern it replaces

## Context Hygiene Fixes

- Which reads should become narrower
- Which docs should be split or summarized
- When cleaned JSONL export should be preferred

## Residual Risks

- Cases where the log may reflect a one-off issue rather than a policy problem

## Decision Rules

- Recommend an instruction change when the agent failed to honor a meaningful part of the user's wording and the miss could be prevented by a durable parsing/alignment rule.
- Recommend an instruction change when the right tool already exists but the agent did not use it.
- Recommend a helper when the agent had to reconstruct the same command family manually.
- Recommend doc splitting when large stable files are repeatedly opened only for a small subsection.
- Recommend no change when the agent’s extra work was caused by genuinely ambiguous requirements.

## Log-Specific Tips

- For Codex rollout logs, ignore noise first: `token_count`, encrypted reasoning payloads, bulky session metadata, and repeated system/developer blocks unless they are directly relevant to the failure.
- Treat `image_generation_*` `result` fields as binary payloads, not analysis text. Use the analyzer's redacted image-generation summary instead of reading or pasting raw base64.
- Use the cleaned export from the agent viewer when it preserves the evidence you need.
- If you need raw logs, inspect narrowly and summarize; do not paste large raw sections into the report.
- Track both command count and “time-to-first-correct-action”. Many optimization opportunities show up there before they show up in total command count.

## Success Criteria

A good analysis does all of the following:

- checks whether all meaningful user wording was actually handled
- identifies reusable optimization opportunities
- ties each recommendation to concrete log evidence
- distinguishes instruction fixes from code/helper fixes
- avoids bloated quoting and unnecessary log replay
- gives maintainers a short path to implement the improvements
