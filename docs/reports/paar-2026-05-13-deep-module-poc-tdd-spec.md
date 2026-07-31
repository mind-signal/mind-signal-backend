# PAAR — Phase G slice (deep-module PoC Step 5 — TDD 시나리오 명세)

> 날짜: 2026-05-13
> 단계: H-deep-module-poc Step 5 (TDD 시나리오 명세 추출 only)
> 선행: `paar-2026-05-13-deep-module-poc-codex-r2.md` (Step 4c — codex r2 option B 결정)
> 다음: Step 6 — RESULT.md 측정 + GO/NO-GO
> 본 산출물: 명세 문서 1건. **production code / test code / resource config 변경 0건**. 회귀 0 유지.
> 작성 원칙: LANGUAGE.md L38 "the interface is the test surface" + DEEPENING.md L36 "Tests assert on observable outcomes through the interface, not internal state"

---

## 0. §10 검증 체크리스트 통과 보고 (HANDOFF rev.4 §10 박제 정합)

> 본 표는 HANDOFF rev.4 §10 "체크리스트 통과 보고 양식" 정합. 다음 세션 재실행 시 같은 양식으로 재박제.

| 항목 | 결과 | 검증 도구 / 근거 |
|---|---|---|
| #1 external-source | Pass | Glob `mind-signal-backend/.claude/skills/improve-codebase-architecture/*.md` → 5 파일 실재 (SKILL/LANGUAGE/DEEPENING/INTERFACE-DESIGN + `_local-addendum.md`) |
| #2 source-quote | Pass | Grep 원문 검증: "the interface is the test surface" LANGUAGE.md L38 + DEEPENING.md L35 + SKILL.md L26 / "Rejected framings" LANGUAGE.md L49 / "Two adapters means a real one" LANGUAGE.md L39 + DEEPENING.md L29 / "Tests assert on observable outcomes through the interface" DEEPENING.md L36 / "Locality" LANGUAGE.md L31 + L47 |
| #3 ad-hoc-formula | Pass | 본 spec Pass/Fail 기준에 line ratio / threshold 2.0 / graph_node_count == mermaid_node_count 사용 0건. §1 정성 평가 3축(deletion test + Interface≈Implementation + Dependency category)만 사용 |
| #4 code-location | Pass | Read 직접 검증: `session.aggregate.ts` L69-90 create / L93-106 fromDocument / L113-123 pair / L142-147 expire / L150-159 cancel / L162-164 isExpired / `pair-subject.service.ts` L47-49 constructor / L58-109 execute / L60 ObjectId.isValid / L65 findByPairingToken / L72-83 try-catch + isExpired 재호출 / L97-105 event 객체 / `session.repository.ts` L62 `doc.subjectIndex ?? 0` 우회 통로 |
| #5 principle-mapping | Pass | 본 spec 시나리오 4·5 = LANGUAGE.md §Locality + §Depth + DEEPENING.md §Seam discipline 직접 인용. 후보별 4단계 표 (§3 deferred) 동반 |
| #6 graph-mermaid-unit | Pass | 본 spec 본문에 graph count vs mermaid count 자가검증 산식 0건. paar-mermaid §자가검증 = 분류별 inventory matching (계량적 1:1 아님) |
| #7 llm-consensus | Pass | A-7 Clock race 강한 인정 근거 = codex r2 §1.3 + Claude rebuttal §3.3 + 코드 read L72-83 + L113-123 + L162-164 직접 인용. 합의 단독 0건 |
| #8 stale-session-state | Pass | Glob `**/base44*` 0건 (3 프로젝트 docs/configs) + `Team-project/.claude/settings.json` Grep "UserPromptSubmit\|Stop" 0건 (PostToolUse + SessionStart 2개만 잔존) |
| #9 observable-outcome | Pass | 본 spec §2 5 시나리오 모두 5요소(Given / When / Then / observable outcome / non-goal) 명시. 내부 Date.now() 호출 횟수 명세 0건 |
| #10 deferred-candidate | Pass | A-5/A-6/A-8 §3 별도 섹션으로 분리. §1 spec scope / §5 Pass 기준 / §4 adapter 권고에 포함 0건 |

10항목 모두 Pass — Step 5 명세 본문 진입.

---

## 1. Spec scope (codex r2 §3.2 option B)

### 1.1 1순위 — PairSubjectService (PS)
- **근거 3축** (paar-depth §3.3 + Step 4a codex r1 Q1):
  1. **Deletion test** — PS 제거 시 5-step flow(L58-109) + 3 AppError 분기가 caller(controller / BDD test)로 흩어짐. "complexity reappears across N callers" (LANGUAGE.md L37) 정합
  2. **Interface ≈ Implementation** — 인터페이스 2 메서드(execute / drainRecordedEvents)는 슬림. 5단계 흐름 + 3 분기는 그 뒤로 숨음. depth 후보 정합 (LANGUAGE.md L19)
  3. **Dependency category 3종** (DEEPENING.md §1~4 분류) — D-1 MongoDB(Repository 어댑터 경유) / D-2 Clock(embedded) / D-4 ObjectId.isValid(in-process). PS는 3 카테고리 모두 경유하는 **응용 서비스 단일 hot path**

### 1.2 추가 — A-7 Clock seam race
- **근거**: codex r2 §1.3 강한 인정. PS `pair-subject.service.ts` L72-83 try-catch 후 `aggregate.isExpired()` 재호출 시점에 첫 호출(SA L114)과 다른 시간 판단 가능성 + PAIRED 상태에서 재호출 시 `expire()` (SA L142-147)가 새 `InvalidStatusTransitionError` 발생 가능
- **시나리오 4**(Clock seam race) + **시나리오 5**(single observed now)로 명세화

### 1.3 명세화 원칙 (LANGUAGE.md L38 + DEEPENING.md L36)
1. **The interface is the test surface** — Test가 검증하는 대상은 PS의 `execute()` 메서드와 `drainRecordedEvents()` + 영속화 후 `SessionRepository.findByPairingToken()` 관찰 결과. SA 내부 transition rule이나 `aggregate.pair()` 호출 자체를 검증 대상에 두지 않음
2. **Tests assert on observable outcomes through the interface, not internal state** — Then 절은 외부에서 관찰 가능한 결과(thrown AppError / 영속 상태 / drainRecordedEvents 반환값)만 검증. 내부 `Date.now()` 호출 횟수 / `aggregate.expire()` 호출 횟수는 non-goal

### 1.4 회귀 0 박제
- `mind-signal-backend/src/**` 수정 0건
- 본 PAAR 1건 추가 (`docs/reports/`)
- Phase G 11 commit(`feat/G-ddd-bdd-tdd-pilot`) untouched
- Clock port 실제 구현 / `SA.isExpired()` 시그니처 변경 / `PS.constructor` 수정 0건 — 모두 후속 PR 영역

---

## 2. 5 시나리오 명세 (Given / When / Then / observable outcome / non-goal)

### 2.1 Scenario 1 — PS happy path

- **Given (preconditions)**:
  - SessionRepository stand-in이 1 도큐먼트로 seed됨: `pairingToken = "TOK-VALID-S1"`, `status = 'CREATED'`, `expiresAt > now`, `groupId = "GRP-S1"`, `subjectIndex = 1`, `experimentMode = 'DUAL'`, `userId = null`, `pairedAt = null`, `creatorId = <operator ObjectId>`
  - 24자 hex `userId` 입력 (`Types.ObjectId.isValid` 통과)
  - 본 시나리오에서 Clock 관찰 시점 T0는 단조 증가하는 시스템 클럭의 한 순간 (시나리오 5에서 단일 snapshot 의무로 강화)
- **When (interface call)**:
  - `new PairSubjectService(stubRepo).execute({ pairingToken: "TOK-VALID-S1", userId: <24hex> })`
- **Then (observable outcomes)**:
  1. `Result.session.status === 'PAIRED'`
  2. `Result.session.userId === <24hex>`
  3. `Result.session.pairedAt instanceof Date` (non-null)
  4. `Result.event` 객체 shape (PS L97-105 정합):
     - `type === 'SessionPaired'`
     - `sessionId === <seed session._id>`
     - `userId === <24hex>`
     - `occurredAt` is ISO 8601 string
     - `groupId === "GRP-S1"`
     - `subjectIndex === 1`
     - `mode === 'DUAL'`
  5. 영속화 검증: subsequent `stubRepo.findByPairingToken("TOK-VALID-S1")` returns aggregate with `status === 'PAIRED'` and `userId === <24hex>`
  6. `service.drainRecordedEvents()` 첫 호출 시 `[Result.event]` 길이 1, 두 번째 호출 시 빈 배열(buffer 비움 검증 — PS L112-115 정합)
- **Non-goal**:
  - 내부 `Date.now()` 호출 횟수
  - `stubRepo.save()` 호출 횟수
  - `aggregate.pair()` 호출 빈도
  - 기존 `pairingListeners` (외부 Set, LD-12) 발화 — pair-subject.service.ts L14-19 NOTE 정합으로 본 흐름에서는 발화하지 않음을 명시 (검증 대상 외)

### 2.2 Scenario 2 — PS expired path (AppError 401)

- **Given**:
  - SessionRepository stub seeded: `pairingToken = "TOK-EXP-S2"`, `status = 'CREATED'`, `expiresAt < now` (확실히 만료된 시점)
  - 유효 `userId` 24-hex
- **When**:
  - `service.execute({ pairingToken: "TOK-EXP-S2", userId: <24hex> })`
- **Then**:
  1. `AppError` thrown — `statusCode === 401` and `message === '페어링 토큰이 만료되었습니다. 다시 시도해주세요.'` (PS L79-82 정합)
  2. 영속화 검증: subsequent `stubRepo.findByPairingToken("TOK-EXP-S2")` returns aggregate with `status === 'EXPIRED'` (PS L77-78 `expire() + save()` 정합 — observable through repository)
  3. `service.drainRecordedEvents()` returns empty array
- **Non-goal**:
  - `aggregate.expire()` 직접 호출 횟수
  - `aggregate.isExpired()` 호출 횟수
  - try-catch 분기 내부 sequence

### 2.3 Scenario 3 — PS retry-after-paired (AppError 400)

- **Given**:
  - SessionRepository stub seeded: `pairingToken = "TOK-PRD-S3"`, `status = 'PAIRED'`, `userId = <previous-user-24hex>`, `pairedAt = <prior Date>`, `expiresAt > now` (만료 전이지만 이미 PAIRED)
  - 신규 `userId` 24-hex (`previous-user`와 다름)
- **When**:
  - `service.execute({ pairingToken: "TOK-PRD-S3", userId: <new-24hex> })`
- **Then**:
  1. `AppError` thrown — `statusCode === 400` and `message === '현재 세션 상태(PAIRED)에서는 페어링할 수 없습니다.'` (PS L84-88 정합)
  2. **영속 상태 불변 검증**: subsequent `stubRepo.findByPairingToken("TOK-PRD-S3")` returns aggregate with `status === 'PAIRED'` (변경 0), `userId === <previous-user-24hex>` (덮어쓰기 0), `pairedAt` unchanged
  3. `service.drainRecordedEvents()` returns empty array
- **Non-goal**:
  - catch 분기 내부 isExpired() 호출 자체
  - PS가 `aggregate.expire()`를 호출하지 않았다는 사실의 직접 검증 (영속 상태 PAIRED 불변으로 간접 보장됨)

### 2.4 Scenario 4 — Clock seam race (A-7) — 결정성 명세

> 본 시나리오는 **A-7 Clock seam race**(codex r2 §1.3 강한 인정 + Claude rebuttal §3.3 Lens 3 박제)의 observable 표현. 실제 Clock port 구현은 후속 PR 영역(§4.3). 본 명세는 "Clock port가 도입되면 어떻게 결정성이 보장되어야 하는가"를 정의함.

- **가정 (port hypothesis)**:
  - 가설적 `Clock` 포트가 PS에 주입됨 (§4.1 시그니처). `SA.isExpired()`는 주입된 clock을 통해 시간을 관찰. 한 `execute()` 호출 내에서 모든 시간 관찰은 결정적이어야 함

- **Given**:
  - 동일 sessionDoc 2개 context로 seed (각각 다른 pairingToken): `pairingToken = "TOK-BND-A"`, `"TOK-BND-B"`, 두 도큐먼트 모두 `status = 'CREATED'`, `expiresAt = T`, 유효 `userId` 24-hex
  - **Context A**: FixedClock at `T - 1ms` 주입
  - **Context B**: FixedClock at `T + 1ms` 주입

- **When**:
  - 각 context별로 `service.execute({ pairingToken, userId })` 1회 호출

- **Then (cross-context observable)**:
  1. **Context A** — Scenario 1 결과와 동일: `Result.session.status === 'PAIRED'`, 영속 PAIRED, event recorded
  2. **Context B** — Scenario 2 결과와 동일: `AppError(401)` thrown, 영속 EXPIRED, drain empty
  3. **결정성**: 동일 context를 N회 반복 실행 시 N개의 결과가 모두 동일 (no flakiness, no race)

- **Within-call observable invariant (race 부재 강제)**:
  - `execute()` 한 번의 호출 안에서 `SA.pair()` 내부 `isExpired()` 첫 판단 (`SA.aggregate.ts:114`) + PS catch 분기 `aggregate.isExpired()` 재호출 (`pair-subject.service.ts:76`)가 **동일 clock snapshot**을 본다
  - 즉 Context A에서 `pair()`는 false를 받지만 catch 분기 isExpired()가 true를 받는 race가 **존재할 수 없어야 함**
  - 검증 방법: Context A에서 paired 결과 + Context B에서 expired 결과 + 두 context 모두 N회 반복 시 동일 결과가 유지되는지

- **A-7 버그 트리거 명세 (codex r2 §1.3 추가 발견 박제)**:
  - 현재 구현(embedded clock) 가설적 race: PAIRED 상태에서 catch 분기 진입 후 isExpired() true 반환 → `aggregate.expire()` 호출(PS L77) → SA L143 `status !== 'CREATED'` 조건으로 `InvalidStatusTransitionError` **새로** throw → AppError(401)이 아닌 raw transition error가 PS 외부로 새어나갈 가능성
  - **Then 강화 명세**: Context C — FixedClock at `T - 1ms`, status=PAIRED(이미 PAIRED)로 seed → 결과는 Scenario 3 (AppError 400 + 영속 PAIRED 불변)이어야 함. `InvalidStatusTransitionError`가 외부로 새어나오지 않음을 검증

- **Non-goal**:
  - 실제 `Clock` 포트 구현 (§4.3 후속 PR)
  - 내부 `Date.now()` 호출 횟수
  - `pair()`와 catch 분기가 동일 변수 vs 동일 함수 재호출인지 (implementation detail)
  - SA.aggregate.ts L122 `this._pairedAt = new Date()`의 clock 정합 (별도 후속 — 시나리오 1의 pairedAt observable만 검증, 정확한 값 일치는 시나리오 5에서 강화)

### 2.5 Scenario 5 — Single observed now (선택, observable 강화)

> 시나리오 4의 within-call observable invariant를 직접 명세화. Clock seam 도입 시 "한 번의 execute()는 한 번의 시간 관찰"이라는 결정성을 인터페이스 수준에서 보장.

- **가정**:
  - PS는 `execute()` 시작 시점에 clock을 1회 관찰하여 그 snapshot T0를 흐름 전체에 사용 (구현 방법은 자유 — 포트 호출 1회 vs 첫 관찰 결과 캐싱 vs 다른 방식. 검증 대상은 결과의 결정성)

- **Given**:
  - SessionRepository stub seeded: `pairingToken = "TOK-SON-S5"`, `status = 'CREATED'`, `expiresAt = T0 + δ` (δ는 매우 작은 양수 — boundary 직전)
  - FixedClock at `T0` 주입
  - 실제 wall-clock이 execute() 호출 중에 `T0 + 2δ`로 진행됨 (실제 시간 흐름과 주입 clock 분리)

- **When**:
  - `service.execute({ pairingToken: "TOK-SON-S5", userId: <24hex> })`

- **Then (observable invariant)**:
  1. 결과는 **주입된 FixedClock의 T0**가 expiresAt 미만이므로 **paired** (Scenario 1 outcome)
  2. wall-clock이 execute() 종료 시점에 `T0 + 100ms`이든 `T0 + 5초`이든 결과는 **동일**
  3. 동일 FixedClock + 동일 seed로 N회 반복 시 N개 결과 모두 paired

- **상대 시나리오 (boundary 반대)**:
  - 같은 seed에 FixedClock at `T0 + 2δ`(boundary 직후) 주입 시 → expired (Scenario 2 outcome). 두 경계 사이의 차이가 결정적임을 보장

- **Non-goal**:
  - Clock port API 형태(`now(): Date` vs `nowMs(): number` 등 design decision) — 후속 PR
  - 내부 clock 관찰 횟수 — 결과의 결정성만 검증

---

## 3. 보류 후보 (Step 5 비포함 — 후속 PR)

> 본 §은 HANDOFF rev.4 §0 표 "Step 5 포함 / 보류 결정" 정합. A-5 / A-6 / A-8은 각각 별도 PR 후보로 보류. 본 spec scope(§1) / Pass 기준(§5) / adapter 권고(§4)에 포함 0건.

### 3.1 A-5 — `SessionAggregate.cancel(_reason: CancelReason)` Interface that lies

- **위치**: `session.aggregate.ts:150-159`
- **현 구현**: 메서드 시그니처는 `reason: CancelReason`을 받지만 implementation은 `_reason` (underscore prefix)으로 폐기. 상태 전이만 수행
- **원리 위반**: LANGUAGE.md L11-13 §Interface — "Everything a caller must know to use the module correctly. Includes the type signature, but also invariants, ordering constraints, error modes, ..." → 시그니처가 caller에게 `reason`이 의미 있는 입력이라는 신호를 보내지만 실제로는 폐기. **거짓 인터페이스**
- **codex r2 §1.1 인정 강도**: 부분 — "shallow module"보다 **거짓 interface / 미완성 domain invariant**에 가까움
- **Step 5 비포함 사유**:
  - 본 PoC scope는 페어링 흐름(CREATED → PAIRED) 1줄 — `cancel()`은 별도 hot path
  - cancel 의미론 결정(reason 보존 vs 폐기 vs cancellation event 발화)은 도메인 차원 의사결정 필요
- **후속 PR 후보**:
  - **PR-A5-cleanup-interface**: reason을 도메인 의도에 맞게 처리 (3 옵션 중 택일 — aggregate state 보존 / cancellation event payload / 인터페이스에서 제거)
  - 영향 범위: SA L150-159 + `CancelReason` type + 잠재 `cancel()` caller(현재 importers_of=0 추정, 별도 검증 필요)

### 3.2 A-6 — `PairSubjectService` constructor `repo?: SessionRepository` soft seam

- **위치**: `pair-subject.service.ts:47-49`
- **현 구현**: `constructor(repo?: SessionRepository) { this.repo = repo ?? new SessionRepository(); }` — Repository 미주입 시 concrete `SessionRepository`를 직접 생성
- **원리 위반**: DEEPENING.md §Seam discipline (L27-32) — composition root 부재. caller가 `new PairSubjectService()` 만으로 동작한다고 신호 받음 → adapter at seam이 "soft seam"(defaultable)으로 약화
- **codex r2 §1.2 인정 강도**: 부분 — A-1 repository seam 정리 시 함께 다룰 부속 후보
- **Step 5 비포함 사유**:
  - 시나리오 1~5는 모두 명시 주입(`new PairSubjectService(stubRepo)`)을 사용하므로 본 명세 자체는 default fallback 동작을 호출하지 않음. 즉 보류해도 시나리오 검증 가능
  - A-1 (PS importers_of=0 → real seam 승격)이 controller wiring PR에서 해결될 때 함께 default 제거가 자연스러움
- **후속 PR 후보**:
  - **PR-A6-required-injection**: A-1 controller wiring PR에 포함. `constructor(repo: SessionRepository)` (required) + composition root에서 단일 인스턴스화
  - 영향 범위: PS L47-49 + BDD test 2건(이미 명시 주입이므로 무중단) + controller wiring PR 신규

### 3.3 A-8 — `SessionAggregate.fromDocument` invariant 부재 + `toAggregate(doc.subjectIndex ?? 0)` 우회 통로

- **위치**:
  - `session.aggregate.ts:93-106` — `fromDocument()`가 `create()` (L69-77)의 invariant 검증(`pairingToken !== ''`, `subjectIndex >= 1`)을 우회
  - `session.repository.ts:62` — `toAggregate()`가 `doc.subjectIndex ?? 0` 으로 nullable을 0으로 hydrate
  - `session.schema.ts:45-48` — schema에서 `subjectIndex` `default: null` 허용, `min: 1` 강제 없음
- **원리 위반**: LANGUAGE.md L31-32 §Locality — invariant 강제 책임이 `create()` 한 곳에 locality가 있어야 하나 `fromDocument()`가 비대칭 우회 통로. DB → aggregate hydration 시 invariant 위반 값(`subjectIndex = 0`)이 통과 가능
- **codex r2 §1.4 + Δ-9 추가 발견**: `toAggregate ?? 0`이 invariant 우회 통로의 직접 증거
- **Step 5 비포함 사유**:
  - invariant locality 설계 결정은 다음 3 옵션 중 선택 필요 — (a) `fromDocument()`에 invariant 강제 추가 / (b) schema가 invariant 일부 담당 (`min: 1`, `required: true`) / (c) repository가 hydration 시 invariant 검증
  - 어느 옵션이든 schema migration 또는 정합성 점검 스크립트가 필요할 수 있음 (legacy 도큐먼트의 `subjectIndex = null` 처리)
- **후속 PR 후보**:
  - **PR-A8-invariant-locality**: 3 옵션 중 ADR 결정 후 구현. ADR-006(Phase G)와 별도 ADR-007 후보
  - 영향 범위: SA L93-106 + SR L62 + session.schema.ts L45-48 + 잠재 legacy 데이터 보정

---

## 4. Adapter port 권고 (A-7 Clock port 한정)

> 본 §은 시나리오 4 / 5의 가설적 Clock port를 명세화. **본 spec에서 실제 구현은 0건** — 시그니처와 정당화만 박제. 구현은 후속 PR (TD-G-Clock 또는 별도 phase).

### 4.1 Clock port 시그니처 (제안 — 후속 PR에서 확정)

```
// 의사 코드 — production code 아님, 시나리오 명세의 가설 표현
interface Clock {
  now(): Date;   // 또는 nowMs(): number — Design It Twice 영역
}

class SystemClock implements Clock {
  now(): Date { return new Date(); }
}

class FixedClock implements Clock {
  constructor(private readonly fixed: Date) {}
  now(): Date { return this.fixed; }
}
```

### 4.2 Two-adapter rule 정당화 (DEEPENING.md L29)

- **Production adapter**: `SystemClock` — `new Date()` / `Date.now()` 캡슐화
- **Test adapter**: `FixedClock` — 시나리오 4/5에서 결정성 보장에 필수
- **DEEPENING.md L29 "Two adapters means a real one"**: 두 어댑터 모두 정당. test stand-in이 단순 mock이 아닌 의미 있는 substitution

### 4.3 본 spec 범위 한계 박제

- Clock port 실제 구현 / `SA.isExpired()` 시그니처 변경(현재 no-arg → `isExpired(clock: Clock)` 또는 생성자 주입) / PS의 clock 단일 관찰(시나리오 5 강화) — **모두 후속 PR** (예: TD-G-Clock-port)
- 본 spec은 "Clock seam이 어떤 결정성을 보장해야 하는가"의 observable 정의만 박제
- 후속 PR ADR 후보: ADR-008 "Clock port at SA isExpired() seam" — 시그니처 결정(method param vs constructor inject) + production 단일 SystemClock 인스턴스 위치(composition root vs SA static)

### 4.4 A-7 race trigger 후속 검증 의무

- 시나리오 4 §"A-7 버그 트리거 명세"의 Context C(PAIRED 상태 + boundary clock)가 현재 코드에서 실제로 `InvalidStatusTransitionError`를 raw 노출하는지는 후속 PR에서 **재현 test 1건 + 수정**으로 입증/반증 필요
- 본 spec에서는 "그럴 가능성이 있다 (codex r2 §1.3 박제)" + "Clock port 도입 시 결정적으로 차단" 까지만 명세

---

## 5. Pass 기준 매칭 (Step 5 한정)

| 기준 | 조건 | 결과 | 근거 |
|---|---|---|---|
| **A** | Step 4 산출물의 주요 후보(A-1 / A-2 / A-4 / A-7 confirmed)가 Step 5 명세 범위에 정확히 반영 | ✅ Pass | A-1(PS center, §1.1 3축) + A-2/A-7(Clock seam, 시나리오 4 + 5) + A-4(event recorded, 시나리오 1 Then 4) 모두 시나리오 본문 또는 spec scope에 반영 |
| **B** | 신규 박제 정보는 원문 Read 검증 또는 명확한 보류 표시 보유 | ✅ Pass | 본 spec 본문 모든 원리 인용 = §0 §10 #2 검증 통과 라인 번호. A-5/A-6/A-8 보류 후보는 §3 별도 섹션 |
| **C** | 임시 공식 / 추론 / cross-LLM 주장만으로 확정 0건 | ✅ Pass | 본 spec Pass/Fail 기준에 line ratio / threshold / count equality 0건. A-7 confirmed는 코드 read(L72-83 + L113-123 + L162-164) + r2 §1.3 + Claude rebuttal §3.3 3중 근거 |
| **D** | Step 5 산출물이 다음 구현 세션에서 바로 TDD 입력으로 사용 가능할 만큼 구체적 | ✅ Pass | 각 시나리오 Given/When/Then/observable outcome/non-goal 5요소 + AppError statusCode/message 한국어 원문 + repository seed 필드 명시 + 24-hex userId 형식 명시 |

**Step 5 완료 조건 충족** (HANDOFF rev.4 §4.1 7항목):
- [✅] `paar-2026-05-13-deep-module-poc-tdd-spec.md` 명세 작성 완료
- [✅] 5 시나리오(PS happy / PS expired / PS retry-after-paired / Clock seam race A-7 / single observed now)가 PS 중심 옵션 B에 맞게 정리
- [✅] A-7 Clock seam race가 observable outcome 기반 시나리오로 포함 (Given / When / Then / observable outcome / non-goal)
- [✅] A-5 / A-6 / A-8은 후속 후보로 보류 사유 명시 (§3)
- [✅] 명세가 LANGUAGE.md "the interface is the test surface" + DEEPENING.md "Tests assert on observable outcomes" 원칙 정합
- [✅] production code / test code / resource config 변경 0건
- [✅] 회귀 0 유지

---

## 6. 다음 단계 (Step 6 — RESULT.md + GO/NO-GO)

### 6.1 측정해야 할 항목
- A 기준 ≥ 2 구조 문제 — 확정 5건(A-1/A-2/A-4/A-7/A-8) + 부분 매칭 3건(A-3/A-5/A-6) = 잠정 충족
- B 기준 ≥ 3 adapter 후보 — D-1/D-2/D-3 확정 + D-4는 INTERFACE-DESIGN 영역 = 잠정 충족
- C 기준 ≥ 1 cross-LLM delta — 9 delta (Δ-1~Δ-9) = 잠정 충족
- D 기준 회귀 0 — src/** 수정 0 = 충족

### 6.2 산출물
- `.plans/_archive/legacy/H-deep-module-poc/RESULT.md` (DOCS-W102) (8~15줄)
- `STATE.md` Phase H 갱신 (또는 신규 생성 — 본 세션 STATE.md 미존재 확인됨)
- 메모리: `project_phase_h_done.md` 또는 `_no_go.md`
- 옵시디언 task amend (`/obsidian-record` 의무, [[feedback-use-obsidian-skill]] + [[feedback-obsidian-record-amend-too]])

### 6.3 GO 신호 (Step 6에서 최종 확정)
- A/B/C/D 4 기준 모두 잠정 충족
- 끼워맞추기 없음 ([[feedback-no-fabricated-evidence]])
- §10 검증 체크리스트 10/10 Pass
- 본 spec이 다음 구현 세션에서 TDD 입력으로 사용 가능

### 6.4 NO-GO 시 처리 (방어 절차)
- Step 6 측정에서 임의의 Pass 기준이 객관 근거 없이 충족되었다는 사실이 드러나면 RESULT.md에 `NO-GO: <항목명>` 박제
- 워크플로우 폐기 또는 도구 교체 결정 + 원인 분석
- 메모리: `project_phase_h_no_go.md`

---

## 7. 산출물 인덱스 (Step 5 완료 기준)

| 종류 | 경로 |
|---|---|
| 본 PAAR (Step 5) | `mind-signal-backend/docs/reports/paar-2026-05-13-deep-module-poc-tdd-spec.md` |
| Step 1 PAAR | `paar-2026-05-13-deep-module-poc-slice.md` |
| Step 2 PAAR | `paar-2026-05-13-deep-module-poc-depth.md` |
| Step 3 PAAR | `paar-2026-05-13-deep-module-poc-mermaid.md` |
| Step 4a PAAR (codex r1) | `paar-2026-05-13-deep-module-poc-codex-r1.md` |
| Step 4b PAAR (Claude rebuttal) | `paar-2026-05-13-deep-module-poc-claude-rebuttal.md` |
| Step 4c PAAR (codex r2) | `paar-2026-05-13-deep-module-poc-codex-r2.md` |
| mermaid source | `docs/architecture/deep-module-mermaid.mmd` |
| mermaid SVG | `docs/architecture/deep-module-mermaid.svg` |
| 본 PoC HANDOFF (rev.4) | `Team-project/.plans/_archive/legacy/H-deep-module-poc/HANDOFF.md` |
| vendor 스킬 | `mind-signal-backend/.claude/skills/improve-codebase-architecture/{SKILL,LANGUAGE,DEEPENING,INTERFACE-DESIGN}.md` + `_local-addendum.md` |

---

## 8. 회귀 0 박제

- `mind-signal-backend/src/**` 수정 0건 (본 세션 Read only)
- `mind-signal-backend/__tests__/**` 수정 0건
- resource config / package.json / tsconfig.json 수정 0건
- Phase G 11 commit (`feat/G-ddd-bdd-tdd-pilot`) untouched
- `Team-project/.claude/settings.json` hooks(PostToolUse + SessionStart) 상태 유지 — UserPromptSubmit / Stop 부재 (§10 #8 Pass 정합)
- 본 PAAR 1건만 신규 (`docs/reports/`)

---

## 9. 출처 / 참조 메모리

- LANGUAGE.md L11-13 §Interface / L18-19 §Depth / L31-32 §Locality / L37-39 §Principles / L49-53 §Rejected framings
- DEEPENING.md L27-32 §Seam discipline / L35-36 §The interface is the test surface
- SKILL.md L15-26 §Glossary + §Deletion test + §The interface is the test surface
- INTERFACE-DESIGN.md §Design It Twice (D-4 value-object 후보 영역, B 기준 제외)
- 본 PoC 박제 위반 사례 4건(§10 §"본 세션 박제 위반 사례"): REFERENCE.md 5번째 파일 / depth ratio 2.0 / SR 1:1 ratio shallow / graph count == mermaid count
- 메모리: [[reference-mattpocock-improve-codebase-architecture]] / [[feedback-no-fabricated-evidence]] / [[feedback-websearch-unverified-persist-ban]] / [[feedback-codex-model-default]] / [[feedback-obsidian-handoff-required-fields]] / [[feedback-use-obsidian-skill]] / [[feedback-obsidian-record-amend-too]] / [[feedback-external-doc-natural-language-5w1h]] / [[feedback-code-review-graph-parallel-standard-error]] / [[project-phase-h-deep-module-poc-step1]]
