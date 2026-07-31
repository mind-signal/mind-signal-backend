# ADR-009: Invariant Locality and Legacy Migration Policy (PR-A8)

<!-- Append-only after Accepted — documentation.md §Append-only rule 참조. -->

---

- **Status**: Accepted
- **Date**: 2026-05-16
- **Phase**: I PR-A8
- **Applies to**: BE
- **Deciders**: @gs07103
- **Related**: ADR-006 (Session Aggregate DDD Pilot), ADR-007 (Clock Port), ADR-008 (Controller Wiring)
- **Supersedes**: 없음

## Context

PR-A1 머지(ADR-008, `d8b6915`) 직후 3가지 취약점 잔존함:

1. `SessionAggregate.fromDocument()` invariant 부재 — Repository가 DB에서 읽은 임의 값을 검증 없이 통합체로 전달 가능함. `subjectIndex: null` 도큐먼트 hydration 시 도메인 invariant가 무음으로 깨짐.
2. `session.repository.ts:62` `?? 0` fallback — null subjectIndex를 0으로 마스킹하여 null provenance를 소실시킴. invariant 검증이 없어도 0은 subjectIndex < 1 조건을 만족하지 않으므로 잘못된 통합체 반환.
3. admin force-pair 경로(`pairing.service.ts`, `admin-pair.service.ts`) + measurement/post-measurement 11+ 직접 Mongoose read 경로가 Aggregate hydration scope 밖에 잔존함 — ADR-009 §3 risk 박제, Phase L deprecation 예정.

dev DB 실측: total=9, subjectIndex >= 1 = 9, legacy null = 0 (T4 dry-run stdout 입증 의무, Atlas 미접근 시 운영자 확인).

## Decision

### §1: Invariant Locality — Aggregate `fromDocument()` 단독

- `SessionAggregateDocumentFields.subjectIndex` 타입을 `number | null`로 변경함 (DB 레거시 도큐먼트 수용).
- `SessionAggregate.fromDocument()` 내부에 2건의 invariant 검증 추가함:
  - `!doc.pairingToken` → `InvariantViolationError('empty pairing token')`
  - `doc.subjectIndex == null || doc.subjectIndex < 1` → `InvariantViolationError('subjectIndex must be >= 1, got N')`
- Mongoose schema 미강화 (Approach A). 도메인이 Mongoose 의존 0건 유지 (depcruise R-DDD-1 정합).
- Repository는 단순 변환 어댑터 역할 유지 — `fromDocument` 호출만, invariant 검증 책임 0건.

근거: DDD single source of truth (Vernon 2011). FSD 레이어 경계 (도메인이 Mongoose 의존 0). DISCUSS Q1 (a) 채택.

### §2: Legacy 마이그레이션 — 일회성 idempotent 스크립트 (dry-run + apply 2모드)

- `scripts/migrate-2026-05-16-pr-a8-subject-index.ts` 신규 생성함.
- 분류 4종 정책:
  - `no-op`: subjectIndex >= 1 (정상) — 변경 없음
  - `auto-fix`: CREATED + 미만료 — group_counters 기반 재할당 (트랜잭션)
  - `manual-block`: CREATED 만료 또는 EXPIRED — apply 차단, 운영자 수동 처리
  - `paired-legacy`: PAIRED / MEASURING / COMPLETED / CANCELLED — 시연 기록 보존, apply 차단
- apply 차단 조건: manual-block > 0 OR paired-legacy > 0 시 nonzero exit + 운영자 메시지.
- counter preflight: apply 직전 group별 `seq = max(existing subjectIndex)` 동기화 (E11000 collision 사전 차단).
- E11000 명시 catch: `group {gid} subjectIndex=N collision — manual resolve required` + transaction rollback.
- exit code: 0 = clean, 1 = apply blocked, 2 = unexpected error.
- `process.exit()` 미사용 — `process.exitCode` + 자연 종료 (stdout flush 보장).
- 실행: `npm run migrate:pr-a8:dry-run` / `npm run migrate:pr-a8:apply` (`-r tsconfig-paths/register` 의무).

### §3: A-8 우회 통로 차단 검증 — 일반 페어링 hydration 경로

- 회귀 시뮬레이션 ABC 6 stdout 박제 (T5):
  - A: aggregate invariant 무력화 → test FAIL (TS2345 + 실행 불가) → 복구 → PASS
  - B: repository fallback `?? 0` 복구 → spy test FAIL (subjectIndex: 0 vs null) → 복구 → PASS
  - C: 마이그레이션 no-op stdout 무력화 → grep exit 1 → 복구 → grep exit 0
    (C는 Atlas 접근 필요 — execute env 미접근, 운영자 확인 의무)
- **admin force-pair 경로 scope-out**: `pairing.service.ts` / `admin-pair.service.ts` 본문 수정 0건 (G9 strict + ADR-008 정합). 잠재 risk 잔존 — Phase L deprecation 일정 예정.
- **measurement/post-measurement 11+ 직접 Mongoose read 경로 scope-out**: `measurement.service.ts:241,348,385`, `post-measurement/services/*.ts`, `sequential.routes.ts:34` 등 Session.findById/findOne/find 직접 — Aggregate hydration scope 밖, Phase L 의존.

## Consequences

**Positive:**
- DDD single source of truth 달성 — invariant가 도메인 계층에만 존재함.
- null subjectIndex hydration 시 즉시 InvariantViolationError (500) → controller `next(err)` → global handler — 무음 데이터 오염 차단.
- PR-A1/PR-A7/ADR-006/ADR-007/ADR-008 패턴 정합 — 아키텍처 일관성 유지.
- 5/26 시연 안전 — 범위 최소화, G9 strict 유지.

**Negative:**
- admin 경로(`pairing.service.ts`, `admin-pair.service.ts`) 및 11+ 직접 Mongoose read 경로는 invariant scope 밖 — Phase L deprecation 전까지 잠재 risk 잔존.
- C 회귀 시뮬레이션은 DB 접근 필요 — execute env에서 BLOCKED (ECONNREFUSED), 운영자 확인 의무.

## Alternatives Considered

**(b) Mongoose schema 강화 (Approach B):**
`subjectIndex: { required: true, min: 1 }` schema 레벨 validation 추가.
- 기각 이유: 도메인 invariant가 Mongoose layer에 분산 (DDD single source of truth 위반). schema 변경 시 운영 부담 ↑. `session.aggregate.ts` type이 Mongoose 의존 → depcruise R-DDD-1 위반. 5/26 시연 1주 전 risk.

**(c) Repository hydration invariant:**
`toAggregate()` 내부에서 직접 null 검사 + throw.
- 기각 이유: FSD layer 위반 — 도메인 책임(invariant)이 `06-entities/repository`로 누출. Repository는 단순 변환 어댑터여야 함 (Stemmler 2019 strangler pattern 정합).

**(d) Aggregate + Schema 양쪽 (Approach B hybrid):**
`fromDocument()` + Mongoose schema 동시 강화로 A-8 우회 100% 차단.
- 기각 이유: Approach B 위험(schema 변경 부담 + 시연 risk) 동반. (a)만으로 일반 페어링 hydration 경로는 완전 차단됨. admin/직접 read 경로 차단은 Phase L에서 별도 처리가 적합.

## References

- `docs/architecture/decisions/ADR-006-session-aggregate-ddd-pilot.md`
- `docs/architecture/decisions/ADR-007-clock-port-at-session-seam.md`
- `docs/architecture/decisions/ADR-008-controller-wiring-strangler-composition-root.md`
- `.plans/_archive/legacy/I-pr-a8-invariant-locality/DISCUSS.md` (SESSION-W113)
- `.plans/_archive/legacy/I-pr-a8-invariant-locality/PLAN.md` (rev.3)
- `.plans/_archive/legacy/I-pr-a8-invariant-locality/HANDOFF.md`
- `docs/reports/paar-2026-05-16-pr-a8-regression-sim/` (회귀 시뮬레이션 ABC 6 stdout + dry-run)
