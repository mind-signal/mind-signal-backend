
# Test Modification Rules — Mind Signal Backend (Jest + supertest)

## When to modify tests

Every code change MUST have its existing tests run first. Whether you also
*change* a test depends on whether behavior actually changed — use this table:

| Code Change Type | Affected Test Layer | Required Action |
|-----------------|--------------------|-----------------| 
| API route added | unit + integration | Create new test file(s) with supertest |
| Controller/service signature changed | unit (direct) + integration (indirect) | Update existing assertions and fixtures |
| Mongoose schema changed | integration | Update fixtures/factories, add migration test |
| Business logic modified | unit | Update assertions, add edge case tests |
| Dependency version bumped | snapshot (may break) | Review diff → intentional = `npm test -- -u`; unexpected = fix code |
| Config / env var changed | integration + smoke | Update environment fixtures |
| **Refactoring (behavior unchanged)** | **none** | **Do NOT modify tests — if they break, the refactoring is wrong** |

## Test modification checklist (5 steps)

For every code change, follow this sequence:

1. **Identify affected layers** — Use the mapping table above. If unsure, err on the side of more layers.
2. **Run existing tests first** — `npm test` before any test changes. This establishes which tests break from your code change vs. which were already broken.
3. **Modify tests to match new behavior** — Update assertions, fixtures, mocks. Add new test files for new functionality. Follow the AAA pattern (Arrange-Act-Assert).
4. **Run verification loop** — Full `npm run verify` (format:check + typecheck + depcruise + lint + test + build). See `.agents/rules/verification-loop.md`.
5. **Review test diff** — `git diff -- 'src/**/*.test.ts'` must make sense relative to the code change. If the test diff is larger than the code diff, reconsider your approach.

## Snapshot management (Jest)

**NEVER run `npm test -- -u` blindly.**

When a snapshot test fails:

```
1. Read the failure diff carefully
2. Ask: "Is this change intentional — did I deliberately change the output?"
   → YES: run `npm test -- -u`, then `git diff` the .snap files
   → NO:  the code change introduced a bug — fix the code, not the snapshot
3. After updating, review the git diff of snapshot files
   → If the diff looks wrong, revert and fix the code instead
```

> **First-time snapshots**: If this is a brand-new snapshot test (no `.snap` file exists yet),
> the "missing snapshot" error is expected. Run `npm test` once — Jest auto-creates the
> snapshot on first run. Then re-run to confirm it passes.

## Dynamic values in snapshots

**Never snapshot non-deterministic values** (timestamps, UUIDs, session IDs, random data).
If the response contains dynamic values:

- Use `expect.any(String)` / `expect.any(Number)` matchers, OR
- Mock the source of randomness (`Date.now`, `crypto.randomUUID`) in the test, OR
- Use `toMatchInlineSnapshot()` with manually curated expected output

Example: an API response containing `createdAt: new Date()` — mock `Date.now` to a fixed value.

## Matching existing project patterns

Before creating new test files:

- **Check test directory structure**: `__tests__/` vs. colocated `*.test.ts` vs. `tests/` folder. Follow existing convention.
- **Check mock patterns**: some tests use `jest.mock('mongoose')`, others mock at the service layer. Match what exists.
- **Check import style**: alias (`@07-shared/...`, `@06-entities/...`) vs. relative. Match existing tests.

## supertest API route test pattern

```typescript
import request from 'supertest';
import app from '@01-app/app'; // Express app instance

describe('POST /api/sessions', () => {
  it('유효한 요청 시 201 반환함', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ groupId: 'valid-group-id' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sessionId: expect.any(String) });
  });

  it('Zod 검증 실패 시 400 반환함', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .send({ groupId: 12345 }); // 잘못된 타입

    expect(res.status).toBe(400);
  });
});
```

## Prohibitions

- **No `npm test -- -u` without reading the diff first**
- **No deleting tests to make CI green** — fix the code or update the test correctly
- **No `// eslint-disable` or `@ts-ignore` to suppress test failures** — these mask real bugs
- **No skipping tests** (`test.skip()`, `xit()`) without a documented reason and issue link.
  Standing exception: a test that depends on a file outside this repo (e.g.
  `mind-signal-data-engine`) — CI checks out this repo only, so guard with
  `fs.existsSync` and skip conditionally:
  ```typescript
  const hasFile = fs.existsSync(filePath);
  const itIfFile = hasFile ? it : it.skip;
  itIfFile('파일이 있을 때만 검증함', () => { ... });
  ```
- **Refactoring PRs must not change test assertions** — if a test breaks during refactoring, the refactoring changed behavior
- **No Vitest APIs** — this repo uses Jest. `vi.mock`, `vi.fn`, `vitest` imports 사용 금지

## New feature test requirements

When adding a new feature (API route, service, utility):

- **Minimum**: 1 unit test covering the happy path + 1 edge case
- **API route**: happy path (200/201) + invalid input (400) + auth guard (401) with supertest
- **Service**: unit test with mocked dependencies (jest.mock)
- Follow existing test file naming convention (check `__tests__/` vs. colocated)

## CI 환경 주의사항

CI는 MongoDB·Redis에 연결하지 않음. CI 대상 테스트는 mock으로 격리해야 함.
`npm run infra:up`이 필요한 integration 테스트는 로컬에서만 실행.
자세한 내용: `.agents/rules/verification-loop.md` "MongoDB·Redis 미연결 상태 CI 테스트" 섹션 참조.
