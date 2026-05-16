# ADR-010: Stage-1 정렬권위 = proxy_ingress_ts_ns — core aligner 행위 변경 (wrap 아님)

<!-- Append-only after Accepted — documentation.md §Append-only rule 참조. -->
<!-- 승격 출처: .plans/18-engine-proxy-sync/ADR-phase18-001-alignment-authority-core-change.md (plan-review-deep CONVERGED rev.6, 양 모델 Critical 0). 본문 §A-§F는 plan-review-deep 산물 — 변경 시 superseding ADR 신규. -->

---

- **Status**: Accepted
- **Date**: 2026-05-16
- **Phase**: 18 engine-proxy-sync
- **Applies to**: BE (dev-only, prod v66 데모 전 미병합 — handoff R6)
- **Deciders**: @gs07103
- **Related**: ADR-004 (engine URL abstraction), ADR-006 (Session Aggregate DDD), ADR-007 (Clock Port), ADR-008 (Controller Wiring), ADR-009 (Invariant Locality). DISCUSS `019df409` (D1-D14 LOCK), plan-review-deep CONVERGED rev.6 (Codex thread `019e2f9b`, escalation `019e2fc3`)
- **구현 범위**: 본 결정은 Phase 18 execute Wave 1-3에 걸쳐 구현됨. Wave 1(S2)에서 seam(IAlignmentStrategy)·schema·proxy scaffold 완료, §A core ns aligner(T1-BE-H)·§B MEASURING(T1-BE-I)·§C 단일 emit(T1-BE-G)·§D failClosed Map(T1-BE-F)는 Wave 2-3. ADR "Accepted" = 결정 비준(plan-review CONVERGED), 구현 진행도는 RTM `DR-Phase18` Status 추적.

---

## Context

D3 (DISCUSS LOCKED, Codex thread `019df409` R1-R4): **`proxy_ingress_ts_ns`가 canonical 정렬권위**. 그러나 기존 core Phase-16 `timestamp-aligner.service.ts`는 BE 서버 ingest `Date.now()` 밀리초로 정렬한다(`subscribeWithAligner`가 `const serverTimestamp = Date.now()` ingest, `flush()`가 `entry.ts` delta 매칭). plan-review-deep Round 3에서 Claude Opus 검토자 + Codex gpt-5.5가 **독립적으로 동일 결론**: PLAN의 "BeLocalAligner가 기존 registry를 wrap, 무행위변경" 전제는 locked D3와 양립 불가. 부차 결함 동시 확인: ① DUAL_2PC start(`startDualMeasurement`)가 fire-and-forget이라 session을 `MEASURING`으로 전이하지 않음 → BE inbound gate가 proxy sample 100% 거부(타이밍 복구 불가, 구조적) ② `flush()`가 이미 `SocketService.emitToGroup(groupId,'aligned_pair',...)` 호출 → handler가 또 emit 시 FE 이중발신 ③ rev.3 `session.sync_meta.failClosedAtNs`는 Session 인터페이스에 sync_meta 부재라 영구 미발화.

## Decision

### §A 정렬 key 변경 (core 행위 변경 — wrap 아님)

`timestamp-aligner.service.ts` (실측 경로: `mind-signal-backend/src/02-processes/measurements/services/timestamp-aligner.service.ts`):
- **클래스 `TimestampAligner.ingest()` 시그니처 변경 (실측: L76-L85)**: `serverTimestamp: number` 제거 → `proxyIngressTsNs: string` 추가. `BufferEntry.ts: number` → `BufferEntry.proxyIngressTsNs: string` (밀리초 대체, 매칭은 ns 기준).
- **레지스트리 wrapper `timestampAlignerRegistry.ingest()` 시그니처 변경 (실측: L195-L203)**: `serverTimestamp: number` → `proxyIngressTsNs: string` (R4-1 LOCK). 클래스와 wrapper 양 레벨 모두 변경 의무.
- **`flush()` 페어링 윈도우 — BigInt ns 직접 비교 (CX4-4 LOCK)**:
  ```typescript
  // 금지: Number(BigInt(a)-BigInt(b))/1e6  — Number 변환 시 >2^53 정밀도 손실
  // 의무: BigInt 직접 비교
  const absDelta = (() => { const a = BigInt(e1.proxyIngressTsNs); const b = BigInt(e2.proxyIngressTsNs); return a >= b ? a-b : b-a; })();
  if (absDelta <= BigInt(this.toleranceMs) * 1_000_000n) { /* 매칭 */ }
  ```
- **만료 판정 (R4-8)**: `e.ts(Date.now())` 대신 `e.proxyIngressTsNs` BigInt ns 기반:
  ```typescript
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const expireNs = 500n * 1_000_000n;
  const fresh = buf.filter(e => nowNs - BigInt(e.proxyIngressTsNs) <= expireNs);
  ```
- **`flush()` 반환 타입 LOCK (R4-3 + CX4-3)**: `AlignedSample[]` 유지. `AlignedPair` persistence 타입 완전 제거 — 별도 persistence artifact 없음. 저장 모델 = raw `SampleEnvelope`를 `measurement-samples`에 저장 (D4 provenance, T1-BE-G). FE delivery = 기존 `flush()` 내부 `emitToGroup('aligned_pair', AlignedSample)` 유지.
- **flush() 레벨 구분 (R4-4)**:
  - 클래스 내부 (실측 L97): `flush(): AlignedSample[]` — zero-param, groupId는 constructor에 있음
  - 레지스트리 wrapper (실측 L213): `flush(groupId: string): AlignedSample[]` — groupId param
  - `IAlignmentStrategy.flush(groupId: string): AlignedSample[]` — registry-wrapper 레벨 계약
- **`subscribeWithAligner`의 `serverTimestamp = Date.now()` → T1-BE-J에서 superseded**: DUAL_2PC는 proxy 경유 — Redis aligner-ingest 경로(실측 L67-L72) 제거. proxy 경로는 T1-BE-G handler가 `envelope.proxy_ingress_ts_ns` 전달.
- **이것은 의도된 dev-only core 행위 변경이다. behavior-preserving wrap 아님.** execute agent는 "파라미터 추가"로 오해 금지.
- **Fence test (의무, R4-2 — behavioral split-truth 차단)**: `__lastMatchField` probe 계측 불필요. 대신 behavioral 2-케이스 split-truth fence:
  - **Fence A**: nsA와 nsA+50ms(window 내) 두 샘플 ingest → `flush()`가 1쌍 반환 (ns 기준 매칭 성공)
  - **Fence B**: nsA와 nsA+300ms(window 초과) 두 샘플 ingest → `flush()`가 0쌍 반환 (Date.now()로 매칭했다면 delta≈0이라 1쌍 통과 → 0쌍이어야 split-truth 차단 증명)
  - 두 케이스 모두 BE-arrival(Date.now())은 동일 ms 내 → Date.now() 기준 delta ≈ 0ms → ns 기반 구현에서만 B가 0쌍 산출됨
- **`WavePower` Zod sub-schema (R4-5)**: `SampleEnvelopeSchema.payload` → `WavePowerSchema` 명시 (실측 필드: delta/theta/alpha/beta/gamma: number). `z.record(z.unknown())` 대체. `as` cast 금지.
- **ns 문자열 Zod gate (CX4-4)**: `de_ts_ns`/`proxy_ingress_ts_ns` regex = `/^\d{1,21}$/` (길이+범위 gate).

### §B DUAL_2PC → MEASURING 전이 (구조적 차단 수정)

`startDualMeasurement`(measurement.service.ts DUAL_2PC 분기 inner fn): `subscribeWithAligner` 호출 **전** 두 subject session을 `status='MEASURING'` + `measuredAt` 전이. `dual2pc.runtime.test.ts`에 트리거 후 MEASURING 단언 추가. 경계조건 아니라 blocking 정확성 수정.

### §C 단일 emit owner

`ALIGNMENT_LOCATION=be`(Stage-1): `timestamp-aligner.service.ts`의 `flush()`가 `aligned_pair` **유일 emitter**. BE `/proxy` inbound handler(T1-BE-G)는 **ingest-only**: 저장 + fail-closed gate + `timestampAlignerRegistry.ingest(...)`만. inline `strategy.align()` 호출·handler emit **금지**. `/* paired envelope from registry */` placeholder + pairwise `align(a,b)` 제거. **IAlignmentStrategy 계약 = streaming**: `ingest(envelope): void` / `flush(groupId): AlignedSample[]` (실측 registry-wrapper 레벨 shape, R4-3 LOCK). ProxyForwardAligner(Stage-2)는 throw "not implemented" 유지.

### §D failClosed 상태 위치 재정의

`session.sync_meta` 사용 금지(Session 인터페이스에 없음). group-level 런타임 상태 = `engine-registry.service`에 `failClosedAtNsByGroup: Map<groupId, bigint>` (inbound handler와 동일 프로세스, 기존 `pendingRegistry` 패턴 미러) + getter. T1-BE-G gate는 이 map 조회 (session doc 아님). sample `sync_meta`의 failClosed 기록은 감사용으로만.

### §E 회귀 보존 (Codex 최대 리스크 대응)

기존 Phase16/17 DUAL_2PC 테스트(`timestamp-aligner.service.test.ts`, `dual2pc.runtime.test.ts`)는 proxy 경로 추가 후에도 **통과 유지 의무**. Stage-1이 모든 DUAL_2PC를 proxy 경유로 라우팅하면 server-ts 경로가 proxy-fed로 바뀌므로 baseline 테스트는 ns 입력으로 갱신하되 **DUAL_2PC end-to-end 관측 행위(페어링 산출·FE aligned_pair)는 보존**. 비-proxy(Redis 직결) 경로 잔존 시 그 테스트는 무변경.

### §F 잔여 정정 (R3/CX3)

- `config.engineSecretKey` → **`config.dataEngine.secretKey`** (실측 config.ts L73).
- ack 스키마에 `retryable: boolean`: `invalid_frame`/`session_not_measuring`/`fail_closed` = non-retryable drop; transport timeout만 retry/replay (CX3-5).
- `measurementSampleRepository.create`는 E11000 wrap 금지(원형 보존) → handler catch → `ack {ok:true,duplicate:true}` (CX3-6).
- `dualTrigger` 핸들러 라인번호 단정 제거(이름으로 지시; 실측 L208).

## Consequences

**Positive**: D3 진본 충족(정렬 진실 단일소스 = proxy ingress ns) · FE 이중발신 제거 · MEASURING gate 구조적 정상화 · fail-closed fence 실동작.
**Negative**: core Phase-16 aligner로 회귀면적 확대(단 dev-only, prod v66 데모 전 미접촉으로 격리) · execute 작업·테스트 증가 · plan-review +2 라운드(Round 4/5).

## Alternatives Considered

- **Wrap-only(rev.1~3 전제)**: 기각 — D3 충족 불가, R3/CX3 양 모델 실측 확증.
- **ADR + 즉시 루프 종료(0라운드, Opus 권고)**: 미채택 — 사용자가 Codex 2라운드 실검증 경로 선택(Critical-0 ADR 단정보다 실측 수렴 우선).
- **DISCUSS 재오픈**: 기각(양 모델) — D3 내용 문제 아님, PLAN의 D3 under-scope 문제.

## References

- 승격 출처(plan-stage 원본, immutable): `.plans/18-engine-proxy-sync/ADR-phase18-001-alignment-authority-core-change.md`
- plan-review-deep Round 1-5 (`.plans/18-engine-proxy-sync/PLAN.md` §검토 결과 반영 이력, rev.6 CONVERGED)
- Codex threads: `019e2f9b`(plan-review 교차 R1-R5) · `019e2fc3`(escalation 자문, 본 ADR 경로 권고) · DISCUSS `019df409`(D1-D14 LOCK)
- Opus code-architect escalation 분석(fence test 비협상 조건 + framing 오류 2건 정정: MEASURING=구조적, streaming transport 재설계 불요·인터페이스 shape만)
- 실측 근거: `timestamp-aligner.service.ts` L76-L85(class ingest), L97(flush zero-param), L195-L203(wrapper ingest), L213(wrapper flush), L21-L27(WavePower 필드); `session.schema.ts` L141-L148(canTransitionTo PAIRED→MEASURING only); `engine-registry.service.ts` L165-L169(cleanupGroup); `measurement.service.ts` L83-L88(flush loop 현재 위치), L67-L72(Redis aligner-ingest), L172(startDualMeasurement)
- RTM: `DR-Phase18` (docs/requirements/RTM.md) — 구현 진행도(Wave 1-3) 추적
