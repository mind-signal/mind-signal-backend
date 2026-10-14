# ADR-012: 연구 동의는 종이로 받고 Consent 문서는 측정 후 자동 생성함

---

- **Status**: Accepted
- **Date**: 2026-09-03
- **Applies to**: BE
- **Deciders**: @KWONSEOK02
- **Related**: 없음

## Context

2026-09-02에 연구 동의서와 심리 설문을 **종이로 받기로 결정**했다. 측정 당일 피험자가
현장에서 종이 동의서를 작성하고, 그 원본이 연구 윤리상 정본이 된다.

그런데 백엔드의 웹 동의 경로는 그대로 살아 있다. `POST /api/sessions/:sessionId/consents`
(`src/05-features/sessions/api/session.controller.ts:256`)가 `submitConsentProcess`
(`src/05-features/sessions/services/submit-consent.service.ts:10`)를 호출해 `Consent`
문서를 만드는데, 종이로 받으면 **이 경로를 아무도 타지 않는다.**

측정 후 파이프라인은 그 문서를 참조한다.

- `src/02-processes/post-measurement/services/post-measurement.service.ts:115` (2인 DUAL)
- `src/02-processes/post-measurement/services/bti-analysis.service.ts:47` (1인 BTI)

둘 다 `Consent.findOne({ userId })`로 조회해 `EegRecord.consentId`를 채웠다. 문서가 없으면
`if (consent1?._id)` 가드에 걸려 조용히 건너뛰므로 **런타임에 터지지는 않지만
`consentId`가 영구히 `null`로 남는다.** `eeg-record.schema.ts:28`이 `default: null`이라
스키마 검증도 통과한다.

즉 측정 데이터와 동의 기록 사이의 참조가 DB 안에서 끊긴다. 조용히 끊기므로 나중에
"동의 없이 수집된 데이터"와 "동의는 받았는데 참조만 빠진 데이터"를 DB만 보고 구별할 수 없다.

## Decision

**웹 동의 화면을 거치지 않은 유저의 `Consent` 문서를 측정 후 파이프라인에서 자동으로 생성한다.**
`versionId`는 종이 동의서를 가리키는 고정값 `PAPER-v1`이고 `isResearchAgreed`는 `true`다.
DB의 `Consent` 문서는 **정본이 아니라 종이 원본을 가리키는 참조 기록**이다.

이 결정의 전제는 **측정 당일 종이 동의서를 미리 받는다**는 운영 절차다. 그 절차가 지켜지지
않으면 이 자동 생성은 받지 않은 동의를 받았다고 기록하는 것이 된다.

## Alternatives considered

### Option A: 받아들인다 — `consentId`가 비는 것을 그대로 둠

종이 원본이 정본이고 DB 참조는 포기한다.

**Trade-offs**: 코드 변경 0. 대신 DB에서 동의 여부를 확인할 수단이 사라진다.

**Rejected because**: 스키마에 `consentId` 필드와 `ref: 'Consent'`를 남겨둔 채 항상 비게
두면, 그 필드를 읽는 후속 코드가 "동의 없음"으로 오해한다. 필드를 지우지 않을 거라면
채워야 한다.

### Option B: 운영자가 종이 접수분을 입력하는 최소 화면을 만든다

측정 전 또는 후에 운영자가 동의 접수를 수동 입력한다.

**Trade-offs**: 접수 시각과 담당자가 남아 감사 추적이 가장 정확하다. 대신 화면과 API와
권한 검사를 새로 만들어야 하고, 측정 현장에 입력 단계가 하나 늘어난다.

**Rejected because**: 남은 기간에 화면 하나를 더 만들 여유가 없고, 종이 원본이 이미
정본이라 DB 입력이 추가로 보증하는 것이 적다. **입력값이 종이와 어긋날 위험만 새로 생긴다.**

### Option C: 백엔드에서 동의 연결을 걷어낸다

`EegRecord.consentId`와 `Consent` 엔티티와 `submitConsent` 라우트를 제거한다.

**Trade-offs**: 죽은 코드가 사라진다. 대신 스키마 변경이라 마이그레이션 판단이 붙고,
나중에 웹 동의로 돌아갈 때 전부 되살려야 한다.

**Rejected because**: 되돌릴 가능성이 남아 있다. 이 프로젝트는 연구 플랫폼이고 IRB
요건이 바뀌면 웹 동의가 다시 필요해질 수 있다. **되돌릴 여지가 있는 결정에 파괴적
변경을 먼저 두지 않는다.**

### Option D (status quo): 현재 구현 유지

**Rejected because**: 현재 구현은 "웹 동의를 받는다"를 전제로 하는데 그 전제가
2026-09-02에 깨졌다. 전제가 깨진 코드를 그대로 두는 것은 선택이 아니라 방치다.

## Consequences

이 결정 이후 **더 쉬워지는** 것:

- `EegRecord.consentId`가 항상 채워진다. 그 필드를 읽는 후속 코드가 분기를 갖지 않아도 된다.
- 웹 동의로 되돌릴 때 코드 변경이 필요 없다. `submitConsentProcess`가 만든 문서가 있으면
  자동 생성이 일어나지 않고 그대로 쓰인다.
- `versionId`가 `PAPER-v1`인지 아닌지로 **종이 접수분과 웹 동의분을 DB에서 구별**할 수 있다.

이 결정 이후 **더 어려워지는** 것:

- **DB의 동의 기록이 실제 서명 여부를 보증하지 않는다.** 종이를 안 받았는데 측정하면
  DB에는 동의 기록이 생긴다. 보증하는 것은 운영 절차이지 코드가 아니다.
- 동의 시각이 서명 시각이 아니라 **측정 후 파이프라인 실행 시각**이다. `createdAt`을
  서명 시각으로 읽으면 틀린다.

새로 발생하는 **기술 부채**:

- `PAPER-v1`에 대응하는 `ConsentVersion` 문서가 DB에 없다. `Consent.versionId`가
  ObjectId 참조가 아니라 String이라 동작에는 지장이 없지만, `ConsentVersion`을 조인하는
  코드가 생기면 이 행이 미아가 된다.
- `withdrawnAt`(동의 철회) 경로가 종이 접수분에 대해 정의되지 않았다. 철회 요청이
  들어오면 어디에 기록할지 정해져 있지 않다.
- `submitConsent` 라우트와 화면이 살아 있지만 아무도 호출하지 않는다. 죽은 경로를
  남겨두는 것이 이 결정의 대가다.

## Contract change rule — 이 ADR을 고치지 말 것

**동의 취득 방식이 바뀌면 이 ADR을 수정하지 말고 새 ADR을 만든다.** 아래 중 하나라도
해당하면 새 ADR 대상이다.

1. 동의를 종이가 아닌 방식(웹 화면, 전자서명, 구두)으로 받기로 하는 변경
2. `PAPER_CONSENT_VERSION_ID` 값이나 그것이 가리키는 종이 동의서 내용의 변경
3. `Consent` 문서를 자동 생성하지 않기로 하는 변경 (Option A 또는 C로의 전환)
4. 자동 생성 시점의 변경 (측정 후 파이프라인이 아닌 다른 지점으로 옮기는 것)
5. `isResearchAgreed` 기본값을 `true`가 아닌 값으로 바꾸는 변경
6. `withdrawnAt`(철회) 처리 경로의 신설

새 ADR을 쓸 때 이 파일의 Status를 `Superseded by ADR-NNN`으로 바꾸고 Decision 본문은
건드리지 않는다. `documentation.md`의 append-only 규칙 그대로다.

**이 규칙이 있는 이유**: 동의 취득은 연구 윤리 요건이라 "언제 무엇을 근거로 그렇게 했는가"가
사후에 반드시 질문된다. Decision 본문을 덮어쓰면 그 질문에 답할 기록이 사라진다.
IRB나 지도교수 질의에 답해야 할 때 필요한 것은 현재 상태가 아니라 **결정의 연쇄**다.

## Implementation notes

- 진입점: `src/06-entities/consents/repository/consent.repository.ts`의 `ensureConsent`
- 상수: 같은 파일의 `PAPER_CONSENT_VERSION_ID = 'PAPER-v1'` (env가 아니라 코드 상수 —
  값이 바뀌면 위 규칙 2번에 따라 새 ADR 대상이므로 배포 설정으로 바꿀 수 있으면 안 된다)
- 호출부 2곳:
  - `src/02-processes/post-measurement/services/post-measurement.service.ts:115` (2인분)
  - `src/02-processes/post-measurement/services/bti-analysis.service.ts:47` (1인분)
- 구현은 `findOneAndUpdate` + `$setOnInsert` + `upsert`다. `$set`이 아닌 이유는
  **기존 웹 동의 문서를 덮어쓰지 않기 위해서**다. 재시도 경로에서 중복이 쌓이지도 않는다.
- 테스트: `src/06-entities/consents/repository/consent.repository.test.ts`
- 마이그레이션: **없다.** 이미 `consentId`가 비어 있는 과거 `EegRecord`는 소급해 채우지
  않는다. 그 측정들이 종이 동의를 받았는지 코드가 알 수 없기 때문이다.

## References

- 관련 스키마: `src/06-entities/consents/model/consent.schema.ts`,
  `src/06-entities/eeg-records/model/eeg-record.schema.ts:28`
- 미사용 웹 경로: `src/05-features/sessions/services/submit-consent.service.ts`
- 결정 경위: `mind-signal/.plans/HANDOFF.md` 4.2절 (A13 백엔드 잔여)
