# Verification Loop Rules — Mind Signal Backend

## 6-step pipeline

Run in this order after any code change (fail-fast):

```bash
npm run format:check   # format check — Prettier (src/**/*.ts)
npm run typecheck      # type check — tsc --noEmit
npm run depcruise      # architecture — Dependency Cruiser FSD boundary check
npm run lint           # static analysis — ESLint 9
npm run test           # tests — Jest + supertest (NODE_ENV=test)
npm run build          # build — tsc + tsc-alias → dist/
```

All at once:

```bash
npm run verify
# = format:check && typecheck && depcruise && lint && test && build
```

## Purpose and failure handling per step

| Step | Command | Purpose | On failure |
|------|---------|---------|-----------|
| format:check | `npm run format:check` | style consistency, avoids lint false positives | run `npm run format`, re-check |
| typecheck | `npm run typecheck` | catch type errors before runtime | fix types, rerun |
| depcruise | `npm run depcruise` | detect FSD layer boundary violations | fix import paths, rerun |
| lint | `npm run lint` | code quality / security rules | `npm run lint:fix`, then fix manually |
| test | `npm run test` | functional/integration regression | see `.agents/rules/test-modification.md` |
| build | `npm run build` | validates the deploy artifact | fix compile errors, rerun |

### Why format:check runs before lint

If Prettier's formatting (semicolons, quotes, line breaks) and an ESLint rule disagree, `lint` produces format-related false positives. Running `format:check` first clears pure formatting issues so `lint` only reports real ones.

### depcruise is advisory today

FSD-boundary rules in `.dependency-cruiser.cjs` are `warn` unless `DEPCRUISE_BLOCKING=true` is set; other depcruise rules are `error`. CI runs the step with `continue-on-error: true`, so it does not block merge yet — fix violations anyway rather than relying on that.

## CI parity

Local pipeline and CI (`.github/workflows/ci.yml`) steps must match.

| Step | Local command | CI step name |
|------|----------|-------------|
| Format | `npm run format:check` | Check Format |
| Typecheck | `npm run typecheck` | Type check |
| Architecture | `npm run depcruise` | Architecture check (depcruise) — `continue-on-error: true` |
| Lint | `npm run lint` | Run Lint |
| Test | `npm run test` | Run Tests |
| Build | `npm run build` | Build Project |

A mismatch between local and CI steps is a bug — fix it immediately.

## MongoDB/Redis not connected in CI

CI does not connect to external infra (MongoDB, Redis). CI-targeted tests must be mocked.

- Integration tests that need real DB/Redis run only locally, after `npm run infra:up` (Docker Redis).
- Externally-dependent tests use the `it.skip` guard pattern — see `.agents/rules/test-modification.md`.

## Agent self-verification rules

1. Never declare work complete before the full loop passes.
2. On step failure, fix the root cause:
   - No bypassing hooks with `--no-verify`.
   - No adding `// eslint-disable-next-line` without a cited reason.
   - No deleting or commenting out a failing test to get green.
3. Escalate to a human after 3 consecutive failures at the same step — don't attempt increasingly aggressive fixes.
4. If the pipeline command itself is broken (missing package, etc.), report the infra problem before touching code.
