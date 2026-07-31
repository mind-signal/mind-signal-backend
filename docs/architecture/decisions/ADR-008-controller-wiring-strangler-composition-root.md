# ADR-008: Controller Wiring Strangler — Composition Root + HOLD-1 β G9 예외

<!-- Append-only after Accepted — documentation.md §Append-only rule 참조. -->

---

- **Status**: Accepted
- **Date**: 2026-05-15
- **Phase**: I PR-A1
- **Applies to**: BE
- **Deciders**: @gs07103
- **Related**: ADR-006 (Phase G DDD/BDD/TDD pilot), ADR-007 (Clock port at session seam)
- **Supersedes**: 없음

## Context

Phase G에서 `PairSubjectService`가 신설되었으나 production reach가 0이었음
(`pair-subject.service.ts:importers_of=0`). `session.controller.ts:126`이 legacy
`pairDeviceProcess` (`pairing.service.ts:83`)를 직접 호출하여 Clock-injected
race-free 경로가 실제 HTTP 트래픽에 적용되지 않음.

Phase I PR-A7 (ADR-007)에서 Clock port를 도입하여 race condition을 차단했으나
controller wiring 없이 production code는 여전히 race 가능. PR-A1는 controller
단일 진입점을 PS로 wire하여 본질 목표 (production reach 0 → 실제 reach + race
영구 차단)를 달성함.

## Decision

### §1: Module-level singleton 정책 + PairSubjectService request-scope factory

- `src/07-shared/clock/index.ts`에 `export const systemClock: Clock = new SystemClock()`
  singleton 추가
- `src/06-entities/sessions/index.ts`에
  `export const sessionRepository = new SessionRepository()` singleton 추가
- 두 singleton 모두 stateless wrapper로 인스턴스 상태 0건 — module-top 안전
- 레이어 제약: `systemClock`은 services/entities import 금지
  (session.controller 단일 import 허용)
- `PairSubjectService`는 **request-scope factory** — `session.controller.pairDevice`
  handler 진입 시마다 `new PairSubjectService(sessionRepository, systemClock)` 인스턴스화
- 이유: PS는 `recordedEvents` mutable buffer 보유 (pair-subject.service.ts:47, :118).
  module-top singleton 시 production 매 페어링마다 buffer 누적 + 동시 요청 간 공유로
  메모리 누수 + race
- 진화 압력 시점: 두 번째 controller가 Clock 필요 + PS 패턴 확장 시
  Option B (`01-app` composition root factory)로 재검토

### §2: HOLD-1 β G9 예외 + 행위 동등성 3조건 + helper-only export

- `pairing.service.ts:83-138 pairDeviceProcess` 본문 0건 수정 (G9 strict 정합)
- 예외: line 126-135 inline listener fire loop →
  `firePairingCompleteListeners(session.groupId, session.subjectIndex)` 1줄 교체 +
  신규 named export `firePairingCompleteListeners(groupId, subjectIndex)` 추가
- G9 예외 근거: **mechanical refactor + 행위 동등성 3조건**
  1. 동일 Set(`pairingListeners`) 순회함
  2. 동일 `void Promise.resolve(cb({...})).catch(console.error)` 패턴 사용함
  3. 동일 인자 shape (`{groupId, subjectIndex}`) 전달함 — baseline callback
     `PairingCallback` (`(data: {groupId: string, subjectIndex: number | null}) => void | Promise<void>`)
     정합
- `pairingListeners` Set 자체는 module-private 유지 (export 금지) — caller 직접 mutate 차단
- helper 시그니처: `(groupId: string, subjectIndex: number | null): void` —
  baseline callback type 정합
- escape hatch: 미래 event bus 도입 시 `firePairingCompleteListeners` 단일 교체점
- @deprecated JSDoc 추가 — Phase L에서 제거 (admin 경로 통일 검토와 함께)

### §3: Controller-level listener fire + async rejection best-effort catch + scale-out idempotency 한계 + adminPair scope-out

- 시점: `pairSubjectService.execute()` 성공 직후 + `res.json()` 전
- async rejection best-effort catch — listener 콜백 비동기 거부가 응답 차단하지 않음
  (기존 LD-12 대안 D 정합)
- sync throw behavior intentionally preserved until Phase L — baseline
  `Promise.resolve(cb(...)).catch(...)` 패턴에서 sync throw는 escape 가능.
  Phase L에서 `Promise.resolve().then(() => cb(data)).catch(...)` 패턴 전환 ADR 후보
- scale-out idempotency 한계: single BE process 기준 + `pairingListeners` module-level
  Set은 multi-dyno scale-out 시 dyno마다 별도 Set 보유 → 동일 listener 중복 fire 또는
  누락 가능. 본 ADR scope는 single BE process로 제한, multi-dyno는 별도 phase L에서
  Redis pub/sub 도입 ADR로 분리 (K-followup F-04 정합)
- **adminPairDevice scope-out**: `adminPairDevice` (Phase K)는 `admin-pair.service.ts:38`에서
  `pairDeviceProcess`를 직접 재사용함. PR-A1 scope 외 — PR-A1 이후에도 admin 경로는
  기존 `pairDeviceProcess` + inline listener fire 유지. 일반/admin 경로 통일 여부는
  **Phase L-pairing-service-removal**에서 재검토

## Alternatives considered

### Q1 A: PS 내부 직접 fire

G9 위반 + listener 결합도 PS 침투.

**Rejected because**: PairSubjectService는 도메인 서비스로 infra 결합(listener fire) 침투 금지.

### Q1 C: event bus publisher

본 PR scope 확장 + 신규 모듈 bug surface.

**Rejected because**: escape hatch는 helper named export로 보존 — Phase L에서 전환 가능.

### Q1 D: 신규 endpoint로 PS, legacy 유지

본질 목표 미달.

**Rejected because**: production reach 0 해소가 PR-A1 core goal — 병렬 endpoint는 해결 아님.

### Q2 B: 01-app composition root factory

DI 컨테이너 도입 미합의 — 시기상조.

**Rejected because**: 두 번째 controller가 Clock 필요할 시점에 재검토 (진화 압력 기준).

### HOLD-1 α: controller-only fire, Set 외부 노출

캡슐화 깨짐 — Set caller 직접 mutate 가능.

**Rejected because**: `pairingListeners` Set은 module-private 유지 필수.

## Consequences

### 긍정 결과

- `PairSubjectService` production reach 0 → 1 (실제 HTTP route가 호출)
- A-7 race condition production 영구 차단 (실제 사용자 요청이 Clock-injected path 사용)
- DUAL_2PC 자동 트리거 보존
  (controller-level dual fire + `startup-listeners.ts:21` callback chain 정합)
- 응답 일관성 — `InvalidStatusTransitionError` raw 5xx 노출 차단
  (모든 분기 `AppError` 401/400/404 정합)
- `pairDeviceProcess` deprecation 경로 확보
  (호출 카운트 0 → Phase L에서 안전 제거)
- PRD S5.1.2 정합 — "응용 서비스 진입점은 `PairSubjectService.execute()`" 실제 코드와 일치

### 부정 결과 (수용)

- adminPair 경로 비대칭 (PR-A1 후 일반 pair만 PS, admin pair는 legacy)
- multi-dyno scale-out 미해소 (K-followup F-04로 분리)
- helper indirection 비용 (controller가 `firePairingCompleteListeners` 호출 — verbose)
- sync throw escape risk 잔존 (Phase L에서 패턴 전환)

## References

- ADR-007 Clock port at session seam (선행)
- Phase G DDD/BDD/TDD pilot (ADR-006)
- DISCUSS rev.3 (`.plans/_archive/legacy/I-pr-a1-controller-wiring/DISCUSS.md` (SESSION-W108))
- PLAN rev.3 (`.plans/_archive/legacy/I-pr-a1-controller-wiring/PLAN.md`) — cross-review 3 Round 수렴
- HANDOFF §4 LOCK 6개
- codex 5.5 cross-review threads `019e20eb` + `019e21b9` + `019e2bd3` + `019e2bea`
- DOCS-W103-followup-backlog F-04 (multi-dyno scale-out)
- HOLD-1 β G9 예외 근거 — DISCUSS rev.1 LOCK

## Append-only edits

> Status 변경 또는 superseded 시점에만 본 섹션을 갱신함. Decision 본문 수정 금지.
