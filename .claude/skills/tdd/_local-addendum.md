# `_local-addendum.md` — mind-signal-backend TDD 스킬 로컬 컨텍스트

> 본 파일은 Phase G가 Phase F 박제 `tdd` 스킬(Pocock 9 파일 byte-identical)을 mind-signal-backend에 활성화하면서 추가한 **로컬 컨텍스트**다.
> Pocock canonical 9 파일은 byte-identical 의무. 본 addendum 1 파일만 로컬 신규.
> ADR-005 skill-vendor-policy 정합: vendored canonical 파일과 _local-addendum.md를 명확히 분리.

---

## 0. 본 스킬을 mind-signal-backend에서 사용할 때 알아야 할 것

mind-signal-backend는 다음 기술 스택을 쓴다:

| 영역 | 사용 도구 |
|---|---|
| 언어 | TypeScript 5.x (strict mode) |
| 프레임워크 | Express 4 + Mongoose 8 |
| 테스트 러너 | **Jest 30 단일** (Vitest 도입 금지 — `.claude/rules/test-modification.md`) |
| HTTP 테스트 | supertest (단, Phase G의 BDD 인수 테스트는 supertest 미사용 — Q1 LOCK) |
| 통합 테스트 DB | `mongodb-memory-server` (Jest globalSetup 패턴) |
| 빌드/타입 검사 | `tsc + tsc-alias` |
| 정적 분석 | ESLint 9 (`--max-warnings 0`) + Prettier |
| 계층 검사 | `dependency-cruiser` (FSD 규칙 + Phase G R-DDD-1/2) |

Pocock canonical은 언어 독립적으로 작성된 outside-in TDD 흐름. mind-signal-backend에서는 **Jest + supertest + mongodb-memory-server 위에서 동일 흐름** 적용.

---

## 1. mind-signal-backend FSD 계층과 TDD 위치

`.claude/rules/architecture.md` FSD 계층 규칙 (`01-app → 02-processes → 05-features → 06-entities → 07-shared`)에서 TDD의 각 단계가 머무는 위치:

| Pocock 단계 | mind-signal-backend 적용 위치 |
|---|---|
| Outside acceptance test | `src/05-features/{domain}/__tests__/*.bdd.test.ts` (Jest describe/test 자연어 Given/When/Then) |
| Application use case test | `src/05-features/{domain}/services/*.service.test.ts` (mongodb-memory-server) |
| Domain unit test | `src/06-entities/{domain}/domain/*.aggregate.test.ts` (Jest pure, no mock, no DB) |
| Repository integration test | `src/06-entities/{domain}/repository/*.repository.test.ts` (mongodb-memory-server) |

본 단계(Phase G) `Session` 도메인에 한정하여 적용. 후속 단계 H/I 진입 시 동일 패턴을 FE/DE에 복제하는 결정은 별도 평가.

---

## 2. mind-signal-backend 한국어 주석 규칙과 Pocock 영문 가이드의 정합

Pocock canonical은 영문 + 코드 예시 중심. mind-signal-backend의 한국어 주석 명사형 종결 규칙(`.claude/rules/code-style.md`)과 충돌하지 않는다.

| 규칙 | 적용 |
|---|---|
| 코드 주석 명사형 종결 (~함 / ~완료 / ~처리 / ~반환 / ~생성 / ~사용 / ~임) | 본 스킬을 따라 작성한 모든 신규 코드 주석 의무 |
| 테스트 describe/test 명칭 | Pocock 권고는 자연어 시나리오. mind-signal에서는 한국어 + Given/When/Then 키워드 혼용 (예: `test('Given operator alice가 ..., When subject bob이 ..., Then ...', ...)`) |
| 파일 이름 | dot-role suffix 의무 (`session.aggregate.ts` / `pair-subject.service.ts` / `session.repository.ts` / `pair-subject.bdd.test.ts`) |

---

## 3. Pocock canonical과 Phase G LOCK의 정합 확인

Pocock canonical 9 파일은 byte-identical 의무. Phase G가 그 위에 부과한 LOCK:

| Phase G LOCK | Pocock 정합 |
|---|---|
| Q1 — BDD 인수 테스트 = Jest 단독 + 서비스 직접 호출 (supertest 미사용) | Pocock outside-in의 "outside" 정의는 HTTP에 한정하지 않음. 서비스 직접 호출도 outside-in 정합 (단위 위 응용 계층) |
| Q2 — `SessionAggregate` 명칭 분리 | Pocock interface-design.md 정합 (도메인 객체 의도 명확화) |
| Q3 — 6 상태 그대로 + 1 전이만 시연 | Pocock tests.md 권고 "1 시나리오 = 1 behavior" 정합 |
| Q4 — group_counters 응용 서비스 책임 | Pocock deep-modules.md "single responsibility" 정합 (도메인 외부 책임 명시) |
| Q5 — 응용 서비스 = `05-features/sessions/services/` (FSD 규칙) | Pocock 가이드는 위치 미규정 — FSD 규칙이 mind-signal-backend 고유 |
| Q6 — depcruise 규칙 2개 | Pocock 가이드는 외부 도구 미규정 — depcruise는 mind-signal-backend 고유 |

---

## 4. 본 스킬과 mind-signal-backend의 다른 스킬·문서 간 cross-reference

- **`office-hours-ddd-discovery/SKILL.md`** (같은 vendoring, 6Q 발견 인터뷰) — DDD 도메인 발견 시 사용. 본 스킬과 짝 (TDD outside-in이 BDD 인수에서 시작 → DDD 도메인 발견 → TDD 단위 사이클)
- **`docs/patterns/ddd-discovery-via-6q.md`** (Phase F 복제 + Phase G 적용 결과 `session-aggregate-6q-applied.md`) — 6Q 답변 박제
- **`.claude/rules/test-modification.md`** "No Vitest APIs" — 본 스킬을 적용할 때 Jest API만 사용 의무
- **`.claude/rules/verification-loop.md`** — TDD 사이클 완료 후 `npm run verify` 6단계 PASS 의무
- **`.plans/_archive/legacy/G-mind-signal-ddd-bdd-tdd/NAMING-GUIDE.md` (SESSION-W107)** — 본 스킬을 따라 생성한 모든 영어 명사의 한국어 의미 박제

---

## 5. 본 스킬 사용 시 자기 체크리스트

mind-signal-backend에서 본 스킬을 따라 작업할 때 다음을 매 사이클 자기 검증:

- [ ] 테스트를 먼저 빨간색(실패)으로 만들었는가?
- [ ] 통과시킬 최소 코드만 적었는가? (Minimum Code 게이트)
- [ ] 신규 의존성 0건 (`package.json` devDependencies 추가 0)?
- [ ] FSD 계층 import 방향 준수 (`npm run depcruise` PASS)?
- [ ] 한국어 주석 명사형 종결 위반 0건?
- [ ] 기존 Jest 테스트 회귀 0건 (`npm test` 결과 동일 PASS 수)?
- [ ] `eslint-disable` / `ts-ignore` / `test.skip()` 신규 0건?

---

## 6. 본 addendum 변경 시

본 addendum은 mind-signal-backend 로컬. Pocock canonical 9 파일과 무관하게 mind-signal 컨텍스트 변경에 따라 갱신 가능.

Pocock canonical 9 파일 (SKILL.md, deep-modules.md, interface-design.md, mocking.md, refactoring.md, tests.md, UPSTREAM.md, office-hours/SKILL.md, office-hours/UPSTREAM.md)은 **수정 금지** — Phase F가 박제한 SHA256 byte-identical 의무 유지. canonical 갱신 시 Phase F의 14a-bis Revision sync trigger(2026-11-01) 절차를 거친다.

---

**END _local-addendum.md** — mind-signal-backend TDD 스킬 로컬 컨텍스트 박제.
