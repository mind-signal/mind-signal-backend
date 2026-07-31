# ADR-006: Session Aggregate DDD/BDD/TDD Pilot (Phase G)

<!-- Append-only after Accepted — documentation.md §Append-only rule 참조. -->

---

- **Status**: Accepted
- **Date**: 2026-05-12
- **Applies to**: BE
- **Deciders**: @gs07103
- **Related**: ADR-004 (engine URL abstraction), Phase 18 engine-proxy-sync (LOCK), `.plans/_archive/legacy/G-mind-signal-ddd-bdd-tdd/CRITIQUE.md` (SESSION-W107) Round 2 (🟡 5 prerequisites), `DOMAIN-MODEL-NOTES.md` (code-review-graph 실측 단일 근거)

## Context

본 단계(Phase G)는 다음 4 bullet의 **P1 frame** 안에서 진행됨 (Prerequisites P-4 정합 의무 — DISCUSS §1, §2 #6, PRD DR-G, 본 ADR Context 4 위치 일관 표현):

1. **졸업 프로젝트 학습 + 2026-05-26 교수 면담 시연** — 효과 측정 주장 없음. 시연 통과 + 한국어 시나리오 외부 낭독 feedback 1회로 가치 박제.
2. **산업 표준 패턴 적용** — Vernon 2011 "Effective Aggregate Design Part I" 단일 aggregate + Stemmler 2019 "TypeScript DDD Mongoose Adapter" + Pocock outside-in TDD 9 파일 (MIT) + Garry Tan gstack 6Q discovery (MIT).
3. **Phase F 박제 자산 활성화** — `feat/F-template-ddd-tdd-augmentation` (2026-05-06 DONE) 작업으로 3 GitHub 템플릿(spring/typescript/python)에 박제된 9 파일을 mind-signal-backend에 SHA256 byte-identical 복제 + 1 신규 `_local-addendum.md`. 박제 자산이 본 단계 적용 없이는 mind-signal에 dead asset.
4. **새 기여 주장 0건** — 차별점 = 학생 horizon + 한국어 명명 가이드 + Phase F 박제 자산 활성화 (모두 market-tier). 학술적 새 기여 주장 없음 — `arXiv 2007.09863` TDD 효과 학술 inconclusive + Cucumber.io "BDD는 collaboration이지 tooling 아님" 단일 개발자 horizon 제약 인정.

추가 컨텍스트:

- 기존 `Session`이라는 단어가 ① Mongoose DB 모양(`session.schema.ts`) ② 비즈니스 규칙 두 가지를 동시에 가리키고 있어 IDE 자동완성/import 검색/사람 판단에서 혼동 발생 가능. NECESSITY-EVIDENCE.md 5건 인용으로 잠재 위험 박제 (CRITIQUE Round 2 P-1 통과).
- `code-review-graph` MCP build (130 files / 630 nodes / 4647 edges, 2026-05-12) 실측으로 기존 `pairDeviceProcess(pairingToken, userId)` 시그니처 + `Session.findOne({pairingToken})` 직접 조회 패턴 + `pairingListeners` (LD-12 대안 D) Set 등록 패턴 + `group_counters` 원자 연산이 페어링 흐름에 미사용 (creation 흐름 전용) 등 12 정정 발견.
- Phase 17.6 (dual-trigger.service.ts 안정 동작) + Phase 18 (engine-proxy-sync LOCK, execute 5/26 이후) 충돌 회피 의무 — `02-processes/engine/` + `pairing.service.ts` 수정 0건 strict.

## Decision

본 단계에서 다음 8 가지 결정 LOCK:

1. **명칭 분리** — Mongoose Model `Session` 이름 그대로 유지 + 도메인 통합체는 `SessionAggregate` 신규 명칭. `src/06-entities/sessions/domain/session.aggregate.ts`.
2. **Aggregate boundary = 단일 Session 도큐먼트** — 1 `SessionAggregate` = 1 MongoDB document = 1 트랜잭션 단위. 그룹 차원 invariant(같은 `groupId`에 `subjectIndex` 1과 2 unique)는 Mongoose `groupId_subjectIndex_unique` 복합 인덱스가 enforce (aggregate 외부).
3. **시그니처** — `SessionAggregate.create({id, groupId, subjectIndex, pairingToken, operatorId, mode, expiresAt})` 7 인자 + `pair(userId: string)` 1 인자 (mind-signal-backend `userId` 컨벤션 정합, `subjectId` 명칭 미사용).
4. **순수 타입 분리** — `src/06-entities/sessions/types/session.types.ts` 신규에 `SessionStatus` 6종 union 단일 정의. `ExperimentMode`는 `@07-shared/constants/experiment` single source 유지(re-export only, drift 회피).
5. **Repository strangler** — `SessionRepository` (`findById` / `findByPairingToken` / `save` / `saveNew`)가 SessionAggregate ↔ Mongoose 양방향 변환 단일 지점. `findByPairingToken`은 기존 `Session.findOne({pairingToken})` (`pairing.service.ts:94`) 어댑터.
6. **응용 서비스 병렬 존재** — `PairSubjectService.execute({pairingToken, userId})` 5단계 흐름은 기존 `pairDeviceProcess(pairingToken, userId)`와 동일 시그니처로 병렬 존재(strangler). 본 단계는 기존 `pairing.service.ts` **수정 0건** — 컨트롤러 통합은 후속 PR.
7. **depcruise 신규 규칙 2** — `R-DDD-1 no-mongoose-in-domain` (`domain/` → `mongoose` 또는 `sessions/model/session.schema` 차단) + `R-DDD-2 no-redis-socket-in-domain` (`domain/` → `07-shared/lib/(redis|socket)` 차단). 순수 타입(`session.types.ts`) + `@07-shared/constants/*` 차단 대상 외 (정규식 매칭 안 됨).
8. **BDD 인수 = Jest 단독 + 서비스 직접 호출** — Q1 LOCK. supertest / HTTP 라우트 / Express app import 0건. Cucumber.js는 별도 `spike/cucumber-poc` 가지로 격리. 본 단계 정식 도구는 기존 Jest 단일.

추가 결정:

- **도메인 이벤트 = type-only + 메모리 기록** — `SessionPairedEvent { type, sessionId, userId, occurredAt, groupId, subjectIndex, mode }` 타입 정의 + `PairSubjectService.recordedEvents` 배열. `pullDomainEvents()` 발행 큐 / persisted outbox 미채택 (Phase E TS-Q17 A3 정합).
- **기존 `pairingListeners` 통합 호출은 본 단계 제외** — LD-12 대안 D 호출 흐름은 후속 controller 통합 PR로 분리. 본 단계는 `pairing.service.ts` 수정 0건 의무 (G9) 보존 우선.
- **AppError 코드 매핑 실측 정합** — 만료 토큰 `401` (`pairing.service.ts:104`), 전이 불가 (이미 PAIRED) `400` (L111), 토큰 없음 `404` (L96), userId 형식 부정합 `400` (L89). rev.2 stale 가정(410/409)은 rev.3 정정으로 폐기.

## Alternatives considered

### Option A: 단일 Session 통합체 (선택)

단일 Session 도큐먼트를 aggregate boundary로 두고 그룹 차원 invariant는 Mongoose 인덱스에 위임함.

**Trade-offs**: 도메인 응집도 명확, 단위 테스트 가볍고 빠름 (DB 없이 1초 8건). 단점 — 그룹 수준 비즈니스 규칙이 코드(도메인) + 인프라(인덱스) 두 곳 책임 (Mongoose 인덱스 변경 시 도메인 invariant 영향).

**Accepted because**: Vernon 2011 "Smaller aggregates preferred" 정합 + mind-signal 동시성 모델(group_counters $inc 원자 연산)이 이미 그룹 단위 unique 보장 + 단일 도큐먼트 트랜잭션이 MongoDB cross-document 트랜잭션보다 비용/복잡도 ↓.

### Option B: Group aggregate (기각)

`groupId` 하나에 1~2 Session을 묶는 큰 통합체로 모델링하고 그룹 차원 invariant를 aggregate에 흡수함.

**Trade-offs**: 그룹 차원 비즈니스 규칙을 한 곳에 집중 가능. 단점 — MongoDB cross-document 트랜잭션 필요 + 동시성 제어 복잡도 ↑ + 그룹 invariant("같은 groupId에 subjectIndex 1과 2 unique")는 이미 Mongoose 인덱스가 enforce하므로 흡수 net value 약함.

**Rejected because**: 비용/복잡도 대비 net value 약함 + Vernon 2011 표준 권고와 반대 방향.

### Option C (status quo): 현재 함수형 service 유지

기존 `pairDeviceProcess` 함수만 유지하고 도메인 layer 신설 없음. Phase F 박제 자산 미활용.

**Trade-offs**: 변경 0건 — 안전. 단점 — Phase F 9 파일이 mind-signal에 dead asset + 5/26 시연 자료 부재 + 학습 가치 0.

**Rejected because**: 본 단계 P1 frame ("Phase F 자산 활성화") 의무 미충족.

## Consequences

이 결정 이후 **더 쉬워지는** 것:

- "세션이라는 개념이 코드에서 한 객체(`SessionAggregate`)로 명확히 표현되며, 페어링 한 줄 흐름이 한 파일(`PairSubjectService`)에 모여 있다"고 시연 시 설명 가능 — 5/26 교수 면담 가시성 확보.
- 도메인 단위 테스트가 DB 없이 빠르게 돔 (8건 도메인 + 5건 응용 서비스 = 0.5초 이하).
- 후속 단계(Phase H FE / Phase I DE)가 같은 패턴(통합체 + Repository + 응용 서비스) 적용 시 한국어 명명 가이드 + 6Q 적용 문서 + skill 9 파일 재사용 가능.
- depcruise R-DDD-1/R-DDD-2가 도메인 layer 무결성(외부 의존 0건) 자동 검사 — 후속 PR에서 실수로 mongoose import 시 즉시 차단.

이 결정 이후 **더 어려워지는** 것:

- `Session` ↔ `SessionAggregate` 두 명칭이 공존 — 신규 작성자는 어느 쪽을 import해야 할지 한국어 명명 가이드(`NAMING-GUIDE.md`) 참조 필요.
- 통합체-모델 변환기(`SessionRepository`)가 추가 — 새 필드 추가 시 4 곳 수정 필요 (`session.schema.ts` + `session.types.ts` + `session.aggregate.ts` `fromDocument` + `session.repository.ts` `toAggregate`).
- 기존 `pairDeviceProcess`와 신규 `PairSubjectService`가 병렬 존재 (strangler) — controller 통합 PR이 별도 필요. 두 경로 동시 유지 시 listener 발화 동작 차이 가능 (기존 경로 = listener 발화 / 신규 경로 = 메모리 기록만).

새로 발생하는 **기술 부채** (모든 ADR은 일정 부채 수반함, 명시적 기록 의무):

- **TD-G-1** (Listener 통합 후속 PR) — 신규 `PairSubjectService`가 기존 `pairingListeners` (LD-12 대안 D) fire-and-forget 호출 미수행. controller 통합 시 헬퍼 export 추가 또는 양쪽 fire 방식 결정 필요. 부채 만료 시점 = Phase H/I 또는 Phase G+1 후속 PR.
- **TD-G-2** (mongodb-memory-server 미설치) — 본 단계 통합 테스트는 Jest mock 기반. 진짜 MongoDB 통합 검증은 후속 인프라 정비 PR (mongodb-memory-server 도입 + Repository 진짜 DB 시나리오 추가). 부채 만료 시점 = CI 인프라 정비 시점.
- **TD-G-3** (controller 점진 이전 미완) — HTTP `GET /join/:token` 라우트는 여전히 `pairDeviceProcess` 호출. 신규 `PairSubjectService`로 점진 이전 작업이 후속 PR로 남음.
- **TD-G-4** (`__v` 낙관적 잠금 미활성) — 현재 `toJSON()`에서 `__v` 삭제 중 — 동시성 제어 불가 상태. 본 단계 미변경, 별도 ADR로 처리 예정.
- **TD-G-5** (Cucumber.js spike 결과 박제 보류) — `spike/cucumber-poc` 가지에서 PoC 검증은 본 phase gate 외. 후속 단계 H/I 진입 전 `SPIKE-CUCUMBER.md` 박제 + 도구 정식 채택 여부 평가 의무.

## Implementation notes

- 가지: `feat/G-ddd-bdd-tdd-pilot` (단일, 11 atomic commit + 1 머지)
- 진입점:
  - 도메인: `src/06-entities/sessions/domain/session.aggregate.ts` (199 lines)
  - 변환기: `src/06-entities/sessions/repository/session.repository.ts` (103 lines)
  - 순수 타입: `src/06-entities/sessions/types/session.types.ts` (24 lines)
  - 응용 서비스: `src/05-features/sessions/services/pair-subject.service.ts` (120 lines)
  - BDD 인수: `src/05-features/sessions/__tests__/pair-subject.bdd.test.ts` (193 lines, 3 시나리오)
- depcruise 신규 규칙: `.dependency-cruiser.cjs` (forbidden 배열에 (e) R-DDD-1 + (f) R-DDD-2 추가)
- 6Q 적용 문서: `docs/patterns/session-aggregate-6q-applied.md` (213 lines)
- Skill vendoring: `.claude/skills/tdd/` + `.claude/skills/office-hours-ddd-discovery/` (9 파일 byte-identical + 1 신규 `_local-addendum.md`)
- 산출물 PAAR:
  - `docs/reports/paar-2026-05-12-phase-g-isolation-proof.md` (G9 통과)
  - `docs/reports/paar-2026-05-12-phase-g-verify-green.md` (G8 통과)
- Verify: `npm run verify` 6단계 GREEN (288 tests PASS, 회귀 0건)

## References

- Vernon, Vaughn (2011), "Effective Aggregate Design Part I: Modeling a Single Aggregate" — https://www.dddcommunity.org/wp-content/uploads/files/pdf_articles/Vernon_2011_1.pdf
- Stemmler, Khalil (2019), "How to Design & Persist Aggregates - Domain-Driven Design w/ TypeScript" — https://khalilstemmler.com/articles/typescript-domain-driven-design/aggregate-design-persistence/
- Pocock, Tim — outside-in TDD guide (MIT) (Phase F vendored)
- Garry Tan, gstack — Six forcing questions v2.0.0 (MIT) (Phase F vendored)
- mind-signal `mind-signal-backend/CLAUDE.md` §7 (status enum), §8 (Operator/Subject ubiquitous language)
- `.plans/_archive/legacy/G-mind-signal-ddd-bdd-tdd/DISCUSS.md` rev.4 (Q1~Q6 LOCK + P1 frame)
- `.plans/_archive/legacy/G-mind-signal-ddd-bdd-tdd/DOMAIN-MODEL-NOTES.md` (code-review-graph 실측 12 정정 단일 근거)
- `.plans/_archive/legacy/G-mind-signal-ddd-bdd-tdd/CRITIQUE.md` Round 1~5 (Verdict 🟡 PROCEED-WITH-CONDITIONS + Contract/Reality/Completeness Lens PASS)
- Related ADRs: ADR-004 (엔진 URL 추상화), 후속 미작성 ADR(s) — `__v` 낙관적 잠금, controller 통합 등
