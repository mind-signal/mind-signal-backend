# Session Aggregate — 6Q Discovery Applied (Phase G)

> Companion: `docs/patterns/ddd-discovery-via-6q.md` (6 forcing questions 일반 가이드)
> Companion: `.claude/skills/office-hours-ddd-discovery/SKILL.md`
> Companion: `.plans/_archive/legacy/G-mind-signal-ddd-bdd-tdd/DOMAIN-MODEL-NOTES.md` (SESSION-W107) (code-review-graph 실측 단일 근거)
> Purpose: `SessionAggregate` 도메인 모델링 결정을 6Q 형식으로 박제.
> Scope: mind-signal-backend 단일 저장소. 페어링 흐름(`CREATED → PAIRED`) 한 줄.
> Frame (P1): 학습/시연 + Phase F 자산 활성화 + 새 기여 주장 0건.

---

## §0. 도입 — 왜 Session을 통합체로 선택했나?

mind-signal-backend의 핵심 비즈니스 단위는 "한 번의 EEG 실험 세션"이다. 이 한 세션이 `CREATED → PAIRED → MEASURING → COMPLETED`의 상태 머신을 거치고, 각 전이에 명확한 트리거(QR 스캔, 측정 시작, 정상 완료, 만료/취소)가 있다. 외부 의존(파이썬 엔진, GenAI API)이 적고, 도메인 규칙이 한 도큐먼트에 응집된다.

후보 비교 (`DISCUSS.md §8`):
- **Session** ✅ — 상태 머신 명확, 라이프사이클 1 도큐먼트, 5/26 시연 흐름(QR 페어링)과 직접 연관
- `Measurement` — Python 데이터 엔진과 강결합, BE 단독 경계 흐림 (보류)
- `AnalysisResult` — GenAI API 외부 의존이 핵심, BE 단독 의미 약함 (보류)

따라서 본 단계 통합체 = `SessionAggregate` (단일). 다른 엔티티(User, EegRecord, AnalysisResult)는 그대로 엔티티 상태 유지.

---

## §1. 6Q 답변 (실측 정합)

본 섹션은 `DOMAIN-MODEL-NOTES.md §3.4`를 그대로 옮긴 표를 코드 참조와 함께 박제한다. 모든 답변은 `code-review-graph` MCP 실측(130 files / 630 nodes / 4647 edges, 2026-05-12) 기반.

### Q1. Invariant — 절대 깨지면 안 되는 규칙

**답변** (두 층위로 분리):

**(a) 단일 Session 도큐먼트 차원** (`SessionAggregate` 책임):
- `pairingToken !== ''` (빈 토큰 금지)
- `subjectIndex >= 1` (그룹 내 번호는 1부터)
- status 전이 그래프 강제 — `canTransitionTo()`가 enforce (`session.schema.ts:131-153`)
- 만료 후 `CREATED` 상태에서는 `EXPIRED`만 허용 (`session.schema.ts:138`)

**(b) 그룹 차원** (Mongoose 인덱스 책임, aggregate 외부):
- 같은 `groupId`에 `subjectIndex` 1과 2가 한 번씩만 등장 → `groupId_subjectIndex_unique` 복합 unique 인덱스 (`session.schema.ts:156`)

**근거**: DOMAIN-MODEL-NOTES §1.1 / §3.4 Q1. **본 SessionAggregate는 그룹 invariant를 책임지지 않음** (Q4 정합).

**Code참조**:
- `session.schema.ts:13-19` (status enum)
- `session.schema.ts:131-153` (canTransitionTo)
- `session.schema.ts:156` (복합 unique 인덱스)

---

### Q2. Transitions — 상태 전이 명세

**상태 6종** (`Session['status']` union):
`CREATED` / `PAIRED` / `MEASURING` / `COMPLETED` / `EXPIRED` / `CANCELLED`

**전이 표** (모든 허용/금지 명세):

| 출발 상태 | 도착 상태 | 허용 | 트리거 메서드 |
|---|---|---|---|
| (시작) | CREATED | ✅ | `SessionAggregate.create()` |
| CREATED | PAIRED | ✅ | `aggregate.pair(userId)` |
| CREATED | EXPIRED | ✅ | `aggregate.expire()` (5분 타임아웃) |
| CREATED | CANCELLED | ✅ | `aggregate.cancel(reason)` |
| CREATED | MEASURING | ❌ | 페어링 미완 — 불허 |
| PAIRED | MEASURING | ✅ | `aggregate.markMeasuring()` |
| PAIRED | CANCELLED | ✅ | `aggregate.cancel(reason)` |
| PAIRED | EXPIRED | ❌ | 이미 페어링됨 — 불허 |
| MEASURING | COMPLETED | ✅ | `aggregate.complete()` |
| MEASURING | CANCELLED | ✅ | `aggregate.cancel(reason)` (10초 무응답) |
| COMPLETED/EXPIRED/CANCELLED | (어디든) | ❌ | 종착 상태 — 어떤 전이도 불허 |

**만료 분기** (`canTransitionTo` 특수 규칙):
- `isExpired() === true` + `current === 'CREATED'` → `EXPIRED`만 허용 (다른 전이 모두 차단)

**근거**: `session.schema.ts:131-153` 실측. `mind-signal-backend/CLAUDE.md §7` 박제.

**본 단계 시연 범위**:
- **실제 구현**: `CREATED → PAIRED` (`SessionAggregate.pair(userId)`)
- **메서드 골조만**: `markMeasuring()`, `complete()`, `expire()`, `cancel()` 4개 — 후속 단계에서 활성화

---

### Q3. Events — 어떤 사실을 발행하는가?

**답변**: `SessionPairedEvent` 단일.

**Shape** (`SessionPairedEvent` 타입 정의):

```typescript
export type SessionPairedEvent = {
  type: 'SessionPaired';
  sessionId: string;
  userId: string;          // 페어링한 Subject의 userId
  occurredAt: string;       // ISO 8601
  groupId: string;          // 8-hex 대문자
  subjectIndex: number;    // 1 또는 2
  mode: ExperimentMode;     // DUAL | SEQUENTIAL | BTI | DUAL_2PC
};
```

**발행 방식 — 두 가지 동시 수행** (DOMAIN-MODEL-NOTES §3.6 옵션 A — 통합):

1. **메모리 내 기록** (`PairSubjectService.recordedEvents` 배열) — 테스트 검증용
2. **기존 `pairingListeners` 호출** — 런타임 동작 보존 (LD-12 대안 D, `pairing.service.ts:13/126-135`)

기존 `pairingListeners`의 callback shape는 `cb({ groupId: string; subjectIndex: number | null }) => void | Promise<void>` (`pairing.service.ts:9-12`). 본 신규 도메인 이벤트는 더 풍부한 정보(`type`, `sessionId`, `userId`, `occurredAt`, `mode`)를 포함한다.

**미채택 패턴**:
- `pullDomainEvents()` 발행 큐 (Phase E TS-Q17 A3 LOCK 정합)
- Persisted outbox (별도 ADR 검토 대상)

---

### Q4. Consistency Boundary — 트랜잭션 단위는?

**답변**: **단일 Session 도큐먼트**. 1 `SessionAggregate` = 1 MongoDB document = 1 트랜잭션 단위.

**boundary 외부 책임** (aggregate가 책임지지 않음):
- **그룹 단위 unique** (`groupId+subjectIndex`) → Mongoose `groupId_subjectIndex_unique` 복합 인덱스가 enforce
- **`group_counters` 원자 할당** (`subjectIndex`) → 기존 `createGroupSessionProcess` (`pairing.service.ts:38-75`) 책임. 본 단계 페어링 흐름에 **미사용** (code-review-graph 실측 — `pairDeviceProcess` callees에 `group_counters` 호출 0건)

**페어링 흐름 ↔ 세션 생성 흐름 분리**:
- `createGroupSessionProcess` (세션 생성, `group_counters` 사용) — 본 단계 미수정
- `pairDeviceProcess` (페어링, `Session.findOne({pairingToken})` 직접 조회) — 본 단계 미수정 (strangler — 신규 `PairSubjectService`와 병렬)
- 두 흐름은 같은 파일에 있지만 **호출 경로가 분리**되어 있음 (callees graph 검증)

**근거**: DOMAIN-MODEL-NOTES §1.2 / §3.4 Q4. DISCUSS rev.4 §9.3 stale 정정 — "본 단계가 카운터 호출을 응용 서비스에 가져오지 않음" 명시.

---

### Q5. Creator — 누가 통합체를 만드는가?

**답변** (두 흐름 분리):

**기존 흐름** (본 단계 미변경):
- `createGroupSessionProcess(groupId?, creatorId?)` — 운영자(Operator)가 QR 발급 시 호출. `crypto.randomBytes(4)` 8-hex `groupId` 생성 → `group_counters` `$inc`로 `subjectIndex` 원자 할당 → `crypto.randomBytes(3)` 6-hex `pairingToken` 생성 → `new Session({...}).save()` (status `CREATED`, 5분 만료).

**신규 흐름** (본 단계 추가, strangler):
- `PairSubjectService.execute({pairingToken, userId})` — 피실험자(Subject)가 QR 스캔 시 호출. 페어링 한 줄 흐름만 처리 (`CREATED → PAIRED`). **새 Session 도큐먼트를 만들지 않음** — 기존 도큐먼트의 상태 전이만.

**Aggregate 생성 시점**:
- DB에서 꺼낼 때: `SessionRepository.fromDocument(doc)` 또는 `SessionRepository.findByPairingToken(token)` 어댑터가 `SessionAggregate.fromDocument()` 호출
- 신규 생성 시: `SessionAggregate.create({ id, groupId, subjectIndex, pairingToken, operatorId, mode, expiresAt })` 7 인자 factory. 본 단계는 BDD 테스트에서만 직접 호출.

**근거**: DOMAIN-MODEL-NOTES §3.4 Q5. PLAN §6.2 T1.1 코드 스케치.

---

### Q6. Forbidden — 절대 허용하면 안 되는 동작

**답변** (3 종):

**(a) `COMPLETED → MEASURING` 불가**: 측정이 정상 완료된 세션을 다시 측정 중으로 되돌리면 데이터 무결성 깨짐. `canTransitionTo`가 차단 (`session.schema.ts:147` — `COMPLETED: []`).

**(b) 종착 상태에서 전이 0건**: `COMPLETED` / `EXPIRED` / `CANCELLED` 세 상태에서 어떤 전이도 금지. 모두 빈 배열 (`session.schema.ts:147-149`).

**(c) `subjectIndex < 1` 불허**: 피실험자 번호는 1부터 시작. 0이나 음수는 invariant 위반 → `InvariantViolationError`. `SessionAggregate.create()` 입력 검증.

**근거**: DOMAIN-MODEL-NOTES §3.4 Q6. `session.schema.ts:142-150` (transitions 표).

---

## §2. Aggregate Boundary 결정 — "단일 Session 도큐먼트"인 이유

**대안**:
- **A. 단일 Session** (선택) ✅
- **B. Group을 통합체로** — `groupId` 하나에 1~2 Session을 묶는 큰 통합체

**대안 B 거부 이유**:
- 그룹 단위 unique 보장은 Mongoose 인덱스 + `group_counters` 원자 연산이 이미 충분히 처리. aggregate에 흡수 시 동시성 제어 복잡도 ↑
- 그룹 단위 트랜잭션은 MongoDB에서 cross-document 트랜잭션 필요 — 단일 도큐먼트 쓰기보다 비용/복잡도 ↑
- 그룹 invariant("같은 groupId에 subjectIndex 1과 2가 unique")는 이미 Mongoose 복합 인덱스가 enforce하므로 aggregate 흡수 net value 약함

**근거**: Vernon 2011 "Effective Aggregate Design Part I" — "Smaller aggregates preferred. Use the aggregate as a unit for data storage operations." (`session.schema.ts:156` 정합).

---

## §3. P1 Frame 정합

본 6Q 답변은 다음 frame 안에서 작성되었음 (학습/시연 + Phase F 자산 활성화 + 새 기여 주장 0건):

1. **학습**: 6Q × DDD 매핑을 mind-signal에 적용해 본 첫 사례 — 학생 horizon 학습 가치
2. **시연**: 2026-05-26 교수 면담에서 `SessionAggregate` + `PairSubjectService` 흐름과 BDD 시나리오를 한국어로 낭독
3. **Phase F 자산 활성화**: `.claude/skills/office-hours-ddd-discovery/SKILL.md` (Phase F 박제, SHA256 byte-identical) 활용
4. **새 기여 주장 0건**: 6Q gstack 원본 (Garry Tan v2.0.0 MIT) + Vernon 2011 + Stemmler 2019 산업 표준 적용. 차별점 = 학생 horizon + 한국어 명명 가이드 + Phase F 자산 활성화 (모두 market-tier)

---

## §4. 후속 단계로 넘기는 결정

- **`pullDomainEvents()` 발행 큐** — 본 단계 미채택. Phase H/I에서 재평가.
- **Persisted outbox 패턴** — 본 단계 미채택. 별도 ADR.
- **`__v` 낙관적 잠금** — 현재 `toJSON()`에서 삭제 중. 본 단계 그대로 유지, 별도 ADR.
- **HTTP 라우트 `GET /join/:token` 리팩토링** — Q1 LOCK으로 본 단계는 응용 서비스 직접 호출만. 컨트롤러 연결은 별도 PR.
- **나머지 5개 상태 전이의 응용 서비스화** — `PAIRED → MEASURING / MEASURING → COMPLETED / * → EXPIRED / * → CANCELLED` — 후속 단계 평가.

---

## §5. 참조 표

| 항목 | 위치 |
|---|---|
| 코드 실측 단일 근거 | `.plans/_archive/legacy/G-mind-signal-ddd-bdd-tdd/DOMAIN-MODEL-NOTES.md` |
| Aggregate 설계 결정 LOCK | `.plans/_archive/legacy/G-mind-signal-ddd-bdd-tdd/DISCUSS.md` rev.4 (Q1~Q6) |
| 한국어 명명 가이드 | `.plans/_archive/legacy/G-mind-signal-ddd-bdd-tdd/NAMING-GUIDE.md` rev.2 |
| 실행 계획 (Wave 0~3) | `.plans/_archive/legacy/G-mind-signal-ddd-bdd-tdd/PLAN.md` rev.3 |
| 6Q 일반 가이드 | `docs/patterns/ddd-discovery-via-6q.md` |
| 6Q 스킬 (gstack v2.0.0 MIT) | `.claude/skills/office-hours-ddd-discovery/SKILL.md` |
| Pocock TDD 스킬 (MIT) | `.claude/skills/tdd/SKILL.md` |

---

**END docs/patterns/session-aggregate-6q-applied.md** — Session aggregate 6Q discovery 박제. DOMAIN-MODEL-NOTES §3.4 정합.
