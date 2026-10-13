# Git Workflow Rules — Mind Signal Backend

## Branch strategy

- `main` is protected — never commit directly.
- Feature branches PR into `dev`; `dev` → `main` merges follow the team release cadence.
- Branch naming (product-wide rule; canonical text: `mind-signal/.plans/README.md`, section "브랜치 이름"; see `AGENTS.md` §11 for what a Work ID is):
  - If the work falls within the scope and completion criteria of a registered Work, use `{type}/{work-id}-{slug}` for any type. `{work-id}` is the full Work ID in lowercase. Examples from the merge history: `feat/ops-w013-message-bus-memory`, `fix/session-w005-subscriber-leak`, `docs/docs-w010-agent-docs-restructure`
  - If the work has no Work affiliation, use `{type}/{slug}` or `{type}/{issue-number}-{slug}` (format examples: `fix/readme-link`, `fix/123-readme-link`). The `#` before the issue number is optional: `fix/#123-readme-link` is the same format.
  - Never use an issue number in place of the Work ID on a branch that belongs to a Work; link the issue from the PR body.
  - One branch carries one Work. If you implement several Works, use one branch per Work.
  - Do not use the ID of a closed Work on a new branch. For work that fixes the result of a closed Work, use the new Work ID if you were given one; otherwise use the format for work with no Work affiliation.
  - Use lowercase English letters, digits, and hyphens for `{slug}`. It may differ from the Work folder slug.
  - `{type}` is the commit type that matches the final purpose of the work. `hotfix` is an extra branch prefix for urgent production fixes; it is not a commit type. It takes the place of `{type}` and follows the same formats as any other type: `hotfix/{work-id}-{slug}` for work that belongs to a Work, `hotfix/{slug}` or `hotfix/{issue-number}-{slug}` otherwise.
  - If the product plan files (`mind-signal/.plans/`) are unavailable, decide by the Work ID and scope you were given. If no Work ID was given, use the format for work with no Work affiliation.
  - `main` and `dev` are integration branches and keep their names; release PRs go from `dev` to `main`. Do not rename existing branches because of this rule. If the Work affiliation changes after the branch is created, record it in the PR body and keep the branch name.

## Commit convention — Conventional Commits 1.0

Pattern: `{type}({scope}): {description}`

| Type | Purpose |
|------|---------|
| `feat` | new feature |
| `fix` | bug fix |
| `docs` | documentation only |
| `chore` | build, config, package updates |
| `refactor` | restructuring without behavior change |
| `test` | adding or modifying tests |
| `ci` | CI workflow changes |
| `revert` | reverting a previous commit |
| `perf` | performance improvement |
| `style` | formatting / whitespace only |

Scope: lowercase kebab-case (e.g. `auth`, `sessions`, `measurement`, `engine`). Description: starts lowercase, no trailing period.

```text
feat(sessions): add pairing token-based session creation API
fix(auth): handle JWT expiry in refresh flow
refactor(measurement): extract engine proxy service
chore(deps): bump socket.io to 4.8.0
```

## One task = one commit

Each atomic task is one commit — no "WIP", "misc", or "fix fix" commits. One PR may hold several commits when each is independently meaningful.

## No direct commits to main

Flow: `work branch → PR → dev → PR → main`. Force-pushing `main` is prohibited under any circumstance; use `git reset --soft HEAD~N` locally before the first push if history needs rewriting.

## Co-authored-by

Every commit ends with:

```text
Co-authored-by: KWONSEOK02 <gwonseok02@gmail.com>
```

- Fixed email `gwonseok02@gmail.com` — `noreply` addresses prohibited.
- Fixed name `KWONSEOK02` (unified 2026-05-16 from the local-machine user `gs07103`, for GitHub attribution).
- No Claude `Co-Authored-By` line.

## One-time setup per clone

```bash
git config core.hooksPath .githooks
```

Without this the `.githooks/pre-push` hook will not run — the script exists in the repo but Git won't execute it until `core.hooksPath` is configured.

## Pre-push gate (`.githooks/pre-push`)

Runs on every `git push`:

1. Blocks if the current branch is `main`.
2. Checks commit subjects against the Conventional Commits pattern — range is `origin/dev..HEAD` when `origin/dev` exists, otherwise falls back to the last 10 commits on `HEAD`.
3. Blocks if the working tree has uncommitted changes, including untracked files.

Any failed check blocks the push; fix the issue and retry.

## Local verification before commit

```bash
npm run verify
# = format:check && typecheck && depcruise && lint && test && build
```

Never commit if any step fails — fix the root cause, then recommit.

## commitlint CI

`wagoid/commitlint-github-action@v6` runs on every PR (`pull_request: [main, dev]`), checking only the latest commit (`commitDepth: 1`) against the type-enum above.

**Currently advisory**: the workflow step has `continue-on-error: true`, so a failing check is visible in the PR but does not block merge. Switching to blocking is an explicit ADR-005 decision (it also requires adding `commitlint` to GitHub branch-protection required status checks at the same time) and has not happened yet.

## CI trigger coverage

`.github/workflows/ci.yml` triggers on push to `main`, `dev`, and `feat/**`/`fix/**`/`docs/**`/`refactor/**`, and on PRs into `main`/`dev`. A branch push already runs the full pipeline — you don't need to open a PR just to see CI results, but a PR is still required to merge.

**Exception**: only the four prefixes above are in the `push.branches` list. Pushing to a branch with any other prefix (`hotfix/**`, `chore/**`, `test/**`, `ci/**`, `revert/**`, `perf/**`, `style/**`) does not trigger CI. Open a PR into `dev`/`main` to get verification on this work.

## Merge strategy

- Default: **create a merge commit**. Do not ask about squash.
- Ask the user whether to squash only when the PR accumulated fix commits across 2+ CodeRabbit review rounds.
- Never auto-merge without the user's explicit instruction.
