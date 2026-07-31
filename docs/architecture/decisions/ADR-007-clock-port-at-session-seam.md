# ADR-007: Clock Port at Session Pairing Seam (PR-A7)

<!-- Append-only after Accepted — documentation.md §Append-only rule 참조. -->

---

- **Status**: Accepted
- **Date**: 2026-05-13
- **Applies to**: BE
- **Deciders**: @gs07103
- **Related**: ADR-006 (Session Aggregate DDD Pilot), 이슈 #52, `.plans/_archive/legacy/H-deep-module-poc/RESULT.md` (DOCS-W102) (Phase H GO, A-7 race trigger 발견), `.plans/_archive/legacy/I-pr-a7-clock-port/ (SESSION-W109){DISCUSS,PLAN}.md`

## Context

Phase H deep-module-poc(2026-05-13 GO 결정)에서 다음 race condition 발견:

`PairSubjectService.execute({pairingToken, userId})` 한 호출 안에서 시간을 3곳에서 독립 관찰함:
1. `SessionAggregate.pair()` 내부 `isExpired()` 1차 호출 (`session.aggregate.ts:163` `Date.now()`)
2. catch 분기 `isExpired()` 2차 재호출 (`pair-subject.service.ts:76`)
3. `SessionPairedEvent.occurredAt` (`pair-subject.service.ts:101` `new Date().toISOString()`)

PAIRED 상태 + boundary clock 시나리오에서 race 발생 가능:
- 1차 `isExpired()` = false (T-1ms < expiresAt = T) → SA L117 status !== 'CREATED'로 `InvalidStatusTransitionError` throw
- 2차 `isExpired()` = true (T+1ms ≥ expiresAt = T, 시간 진행) → `expire()` 호출 → SA L143 status !== 'CREATED'로 새 `InvalidStatusTransitionError` throw
- 결과: `InvalidStatusTransitionError`가 `AppError`로 감싸지지 않고 외부 raw 노출 (5xx + 영문 도메인 에러 메시지)

또한 hardcoded `Date.now()` / `new Date()`로 test에서 시간 분기를 결정적으로 재현 불가능.

근거: Phase H codex 5.5 r2 강한 인정 (thread `019e1f19-f5b3-7150-90b7-e71bd3066b23`) + Claude 4-Lens rebuttal Lens 3 + plan-review W2 코드 트레이스 (이슈 #52 본문).

## Decision

본 단계에서 다음 5 가지 결정 LOCK:

1. **Clock port 신규** — `src/07-shared/clock/{clock.ts, system-clock.ts, fixed-clock.ts, index.ts}` 신규. `interface Clock { now(): Date }` + SystemClock(production) + FixedClock(test). FSD 07-shared 레이어 정합 (06-entities, 05-features 모두 import 방향 정합).

2. **시그니처 변경 — Method param + Date 전달** (Approach A) — `SessionAggregate`:
   - `pair(userId: string, now: Date): void` — Date 인자 추가, 내부 `isExpired(now)` 호출 + `_pairedAt = now` 박제
   - `isExpired(now: Date): boolean` — `Date.now()` 제거, 주입 Date와 `expiresAt` 비교

3. **PS Clock 1회 관찰 + A-6 동반 fix** — `PairSubjectService`:
   - `constructor(repo: SessionRepository, clock: Clock)` — 둘 다 required (A-6 PS constructor optional default soft seam 해소)
   - `execute()` 진입 시 `const now = this.clock.now()` 1회 관찰 → SA `pair(userId, now)` / `isExpired(now)` / `event.occurredAt = now.toISOString()`에 동일 Date 객체 전달
   - 한 호출 단위 내 시간 결정성 보장 → race 차단의 인터페이스 강제

4. **Composition root는 PR-A1 (controller wiring)으로 분리** — 현재 PS는 controller가 호출하지 않음(importers_of=0). 본 PR은 BDD/unit test에서만 명시 주입(`new PairSubjectService(stubRepo, new FixedClock(testNow))`). production `SystemClock` 단일 인스턴스 생성 위치는 PR-A1에서 DI 패턴 정식 결정.

5. **`fromDocument` 영향 0건** — Approach A는 SA에 Clock 미주입. `SessionAggregate.fromDocument(doc)` 시그니처 변경 0. A-8(fromDocument invariant locality) 별건 PR과 독립.

## Alternatives considered

### Option A: Method param + Date 전달 (선택)
- 장점: race production 차단 **인터페이스 강제** (caller가 다른 시점 주입 불가) / SA pure domain 유지 (infra 의존 0) / Two-adapter rule 정합 (DEEPENING.md L29) / Phase H Step 5 시나리오 5 결정성 자연 보장
- 단점: SA 시그니처 변경 → 기존 SA test 8건 + SR test L123 + PS test 5건 + BDD 3건 갱신
- 채택 이유: race를 production code 차원에서 영구 차단 + Matt Pocock vendor skill `improve-codebase-architecture` 원리 100% 정합

### Option B: Constructor inject SA
- 장점: caller 시그니처 변경 최소 (pair/isExpired no-arg 유지)
- 단점: race 차단이 SA 내부 캐싱 약속에 의존 (인터페이스 강제 불가) / SA가 Clock 의존 보유 (pure domain 깨짐) / `fromDocument` hydration 경로에서 Clock 주입 복잡 (A-8과 충돌)
- 거부 이유: 같은 SystemClock 인스턴스를 공유해도 `now()`가 매번 새 Date 반환 → catch 분기 `isExpired()` 재호출 시 race 잔존. race 차단을 SA 내부 메모이제이션 약속에 맡기는 것은 LANGUAGE.md §Locality 약화

### Option C: Static Clock + jest.useFakeTimers()
- 장점: 시그니처 변경 0
- 단점: production race 그대로 잔존 (test mock trick) / static `Date.now()`는 in-place 수정 위치 아님 → DEEPENING.md §Seam discipline 위반 / adapter 1개 (Two-adapter rule 미충족, mock은 의미 있는 substitution 아님)
- 거부 이유: 본 PR의 본질 목표(race를 production에서 영구 차단)에 미달

## Consequences

### 긍정 결과
- **race 차단**: 한 `execute()` 호출 단위 내 시간 관찰 1회 = 시간 결정성 인터페이스 강제. `InvalidStatusTransitionError` 외부 raw 노출 경로 차단
- **test 결정성**: `FixedClock` 주입으로 boundary 직전/직후 결정적 재현 가능 — Phase H tdd-spec §2.4 시나리오 4 Context A/B/C + §2.5 시나리오 5 PASS 입증
- **A-6 soft seam 동반 해소**: PS constructor required 격상으로 composition root 명시화 (DEEPENING.md §Seam discipline 정합)

### 부정 결과 (수용)
- SA test 8 → 9 갱신 + SR test L123 + PS test 5건 + BDD 3건 시그니처 정합 갱신 필요
- `fromDocument` 영향 0건이지만, A-8(invariant locality)는 본 PR scope 외 잔존 — 별건 후속 PR

### 회귀 0 박제 (이슈 #52 PR description 정합)
- Phase G 21 test → 본 PR 후 36 PASS (SA 9 + SR 5 + PS 5 + BDD 8 + clock 4 + 외 sessions test = 73 sessions+clock 영역 PASS)
- 기존 거동(paired/expired/retry-after-paired의 AppError statusCode + message) 불변
- `pairing.service.ts` 수정 0건 (Phase G G9 의무 유지)
- depcruise R-DDD-1/R-DDD-2 위반 0건 (06-entities → 07-shared 방향 정합)

### 후속 의무
- PR-A1 (controller wiring): production `SystemClock` 단일 인스턴스 composition root 정식 결정
- PR-A8 (fromDocument invariant locality): SA `fromDocument` invariant 분담 ADR

## References

- 이슈 #52: https://github.com/KWONSEOK02/mind-signal-backend/issues/52
- Phase H GO: `Team-project/.plans/_archive/legacy/H-deep-module-poc/RESULT.md`
- Phase H tdd-spec: `mind-signal-backend/docs/reports/paar-2026-05-13-deep-module-poc-tdd-spec.md` §2 5 시나리오
- Phase H codex r2: thread `019e1f19-f5b3-7150-90b7-e71bd3066b23` (A-7 강한 인정)
- vendor skill 원리: `.claude/skills/improve-codebase-architecture/`
  - LANGUAGE.md L31-32 §Locality / L38 "the interface is the test surface"
  - DEEPENING.md L27-32 §Seam discipline / L29 "Two adapters means a real one" / L36 "Tests assert on observable outcomes through the interface, not internal state"
- plan-review Round 1 (`feature-dev:code-reviewer`, 2026-05-13): verdict PROCEED-WITH-CONDITIONS → 6 이슈 PLAN.md 반영 후 PROCEED

## Append-only edits

> Status 변경 또는 superseded 시점에만 본 섹션을 갱신함. Decision 본문 수정 금지.
