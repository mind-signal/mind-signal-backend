# ADR-013: 프록시를 거친 측정 샘플은 프록시 수신 시각으로 짝을 맞춤

---

- **Status**: Proposed
- **Date**: 2026-10-17
- **Applies to**: BE
- **Deciders**: @KWONSEOK02
- **Related**: ADR-010(결번. 아래 Context 참조), EEG-W005(단독 emit 수정), EEG-W006(이 결정의 구현)

## Context

2026-05-16에 Phase 18(engine-proxy-sync)은 두 PC 샘플의 정렬 기준을 프록시 수신 시각
`proxy_ingress_ts_ns`로 바꾸기로 결정하고 ADR-010으로 채택했다(커밋 `91afef5`).
구현 커밋 `32e9781`까지 만들었으나 브랜치 `feat/18-engine-proxy-sync`가 dev에 병합되지
않은 채 삭제되었다. 그 커밋 12개는 2026-10-17에 보존 브랜치
`archive/feat-18-engine-proxy-sync`(`03c025c`)로 옮겼다. ADR-010 번호는 재사용하지 않는다.

2026-10-17 dev(`c3d8fca`)의 상태는 다음과 같다.

- 프록시는 모든 샘플에 `proxy_ingress_ts_ns`(epoch 기준 나노초 십진 문자열)를 부여한다
  (`mind-signal-proxy/src/services/ingress-clock.ts`).
- 백엔드 `/proxy` 핸들러는 이 필드를 검증하지 않고 버린 뒤 Redis로 재발행한다
  (`src/07-shared/lib/socket/socket.ts`).
- aligner는 백엔드 수신 시각 `Date.now()`로 짝을 맞춘다. 허용 오차는 200ms다.

백엔드 수신 시각은 프록시 재전송, 네트워크 지연, 이벤트 루프 지연의 영향을 받는다.
두 PC 샘플은 같은 프록시 시계로 시각이 부여되므로, 프록시 수신 시각이 두 샘플의
실제 도착 시점 차이를 더 정확하게 나타낸다.

## Decision

두 샘플 모두 `proxy_ingress_ts_ns`가 있으면 aligner는 그 값의 차를 BigInt 나노초로 비교해
짝을 맞춘다. 하나라도 없으면 백엔드 수신 시각으로 비교한다. 단독 emit 대기 판정은
백엔드 수신 시각으로 유지한다.

ADR-010과 다른 점은 다음과 같다.

- 500ms 만료 필터를 두지 않는다. EEG-W005(2026-09-07)가 그 필터가 subject 1 샘플을
  버리는 원인임을 실측으로 확인하고 제거했기 때문이다.
- 정렬 전략 인터페이스, 샘플 원본 저장 엔티티, 프록시 health 폴링과 fail-closed 차단은
  이 결정의 범위가 아니다.

## Alternatives considered

### Option A: feat/18 브랜치 전체 병합

ADR-010의 구현 12개 커밋을 그대로 병합한다.

**Trade-offs**: 원래 설계를 한 번에 반영한다. 시험 병합에서 8개 파일이 충돌했고, dev가
따로 구현한 `/proxy` 핸들러와 중복된다.

**Rejected because**: dev의 aligner 수정 13건 이상과 충돌하여 회귀 위험이 크다.

### Option B: 커밋 `32e9781`까지 4개만 cherry-pick

**Trade-offs**: 충돌 파일이 6개로 줄어든다.

**Rejected because**: `32e9781`의 나노초 경로(`BeLocalAligner`)는 호출하는 코드가 없어서,
충돌을 해소해도 실제 정렬 기준은 바뀌지 않는다.

### Option C (status quo): 백엔드 수신 시각 유지

**Rejected because**: 프록시가 이미 부여한 정렬 기준을 백엔드가 버리고 있어서, 실기기 검증 계획
(OPS-W101)의 판정 항목 "BE `proxy_ingress_ts_ns` ns 정렬"을 충족할 수 없다.

## Consequences

이 결정 이후 **더 쉬워지는** 것:

- 프록시 재전송으로 백엔드 도착 순서가 바뀌어도 짝 맞추기 결과가 바뀌지 않는다.

이 결정 이후 **더 어려워지는** 것:

- aligner의 시각 기준이 둘(프록시 수신 시각, 백엔드 수신 시각)이 되어 테스트에서 둘을
  구분해야 한다.

새로 발생하는 **기술 부채**:

- 구버전 프록시와 DE 직접 Redis 경로를 위해 백엔드 수신 시각 폴백이 남는다.
- 헤드셋 두 대 실측으로 정렬 결과를 아직 확인하지 않았다.

## Implementation notes (optional)

- 진입점: `src/02-processes/measurements/services/timestamp-aligner.service.ts`
- 필드 전달: `src/07-shared/lib/socket/socket.ts`, `src/07-shared/lib/socket/proxy-envelope.schema.ts`,
  `src/02-processes/measurements/services/measurement.service.ts`
- 검증: `timestamp-aligner.service.test.ts`의 `EEG-W006` describe 블록

## References

- 보존 브랜치: `archive/feat-18-engine-proxy-sync` (`03c025c`), ADR-010 원문은 `91afef5`
- 프록시 시각 부여: `mind-signal-proxy/src/services/ingress-clock.ts`
