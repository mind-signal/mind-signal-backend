# PAAR — Phase G slice (deep-module PoC Step 2 — depth + adapter 후보)

> 날짜: 2026-05-13
> 단계: H-deep-module-poc Step 2 (정성 depth 평가 + dependency 분류)
> 선행: `paar-2026-05-13-deep-module-poc-slice.md` (Step 1 그래프 baseline 35 노드)
> 측정 도구: vendored `mattpocock/improve-codebase-architecture` skill (byte-identical SHA256, `_local-addendum.md` 임시 공식 폐기 박제)

---

## 0. 측정 도구 변경 — HANDOFF 임시 공식 폐기 박제

`.plans/_archive/legacy/H-deep-module-poc/HANDOFF.md` (DOCS-W102) §5 Step 2 잠정 공식
`depth = behavior_size / public_interface_size, 임계값 2.0`은 **본 PoC에서 사용하지 않음**.

근거: `mind-signal-backend/.claude/skills/improve-codebase-architecture/LANGUAGE.md` §"Rejected framings" 1번 — Matt Pocock이 명시적으로 거부 ("Depth as ratio of implementation-lines to interface-lines — rewards padding the implementation"). 끼워맞추기 방지(`feedback_no_fabricated_evidence`)에도 부합하므로 정성 평가 3축으로 변경:

1. **Deletion test** — 삭제 시 complexity 분산 여부 (SKILL.md §Glossary)
2. **Interface ≈ Implementation 정성 비교** (LANGUAGE.md §Depth)
3. **Dependency 4 categories + Two-adapter rule** (DEEPENING.md §1~4, §Seam discipline)

벤더링 검증 (SHA256 byte-identical):
| 파일 | sha256 |
|---|---|
| SKILL.md | `9e9b617b1c70d390e37dbfd1c031c11b3de850e2e3d01c4a2c2888bdb386a247` |
| LANGUAGE.md | `6feca2140439c54a774749e8367f18350899ff69c777144ed2248cd4407949fa` |
| DEEPENING.md | `9577485f4fc32c0267639a9151bb41c8af0f8f6086e4bf8b84d5b236e30604e9` |
| INTERFACE-DESIGN.md | `678c3e34f1339015053212b3316bf0b676c70aa251050a0613667d4e755fb35e` |

HANDOFF §8 박제된 5번째 문서 `REFERENCE.md`는 실재 안 함 (2026-05-13 GitHub API 확인 — repo에 4 파일만 존재). 메모리 `reference_mattpocock_improve_codebase_architecture.md`의 "5 URL" 박제도 4 URL로 정정 필요.

## 1. Slice scope 재확인 (Step 1 baseline 유지)

| 클래스 | 파일 | LOC | public 메서드 | private 메서드 |
|---|---|---|---|---|
| SessionAggregate | `src/06-entities/sessions/domain/session.aggregate.ts` | 197 | create / fromDocument / pair / markMeasuring / complete / expire / cancel / isExpired + 10 getters | constructor |
| SessionRepository | `src/06-entities/sessions/repository/session.repository.ts` | 101 | findById / findByPairingToken / save / saveNew | toAggregate / toDocumentFields / toObjectId |
| PairSubjectService | `src/05-features/sessions/services/pair-subject.service.ts` | 117 | execute / drainRecordedEvents | (없음) |

graph slice (Step 1) 35 노드 baseline 유지. 회귀 0 (read-only).

## 2. 추가 graph 호출 결과 (sequential, detail_level=minimal)

| # | pattern | target | result_count | 핵심 발견 |
|---|---|---|---|---|
| 1 | callers_of | SessionAggregate | ambiguous (5 candidates) | Class node 직접 매칭 부재 — 호출은 SessionRepository.findById/findByPairingToken/save 3건이 주 |
| 2 | file_summary | session.aggregate.ts | 21 | 본문 Class 1 + Function 4 + 16 추가 노드 (테스트 가능성) |
| 3 | imports_of | pair-subject.service.ts | **4** | 본문 read와 일치 (`Types`, `SessionRepository/Aggregate/InvalidStatusTransitionError`, `SessionPairedEvent`, `AppError`) |
| 4 | importers_of | pair-subject.service.ts | **0** | 🔴 **dead path** — 어떤 src 파일도 PairSubjectService를 import 하지 않음 |
| 5 | tests_for | pair-subject.service.ts | 0 | graph indexing 한계 (실제 test 파일 2개 존재: `pair-subject.service.test.ts` + `__tests__/pair-subject.bdd.test.ts`) |

도구 안정성: 5회 순차 호출 전부 정상 응답 (Step 1 noted 병렬+standard internal error 없음).

## 3. Deletion test + dependency category — 클래스별 정성 평가

### 3.1 SessionAggregate

| 항목 | 결과 |
|---|---|
| Deletion test | "complexity reappears across N callers" — 5 status transition rule + 6 invariant error가 caller(Repository, Service, 잠재 controller)로 흩어짐 → **DEEP** |
| Interface ≈ Implementation | Interface가 비대 (7-arg factory, 10 getters, 6 transition methods, 5 status enum, 4 cancel reason). Implementation은 transition rule + invariant 강제. 정성적으로 interface 표면이 implementation 깊이를 상회 — "the interface is the test surface" 원칙상 caller가 너무 많이 알아야 함. **Depth는 있으나 interface 슬림화 여지 있음** |
| Dependency category | 1 (In-process) — Mongoose/Redis/Socket.io 의존 0건 (file header 박제). 단 `Date.now()` (L163) + 암묵 `new Date()` (L122) **clock embed** 존재 |
| 결론 | DEEP (5 transition + 6 invariant locality) 단 **clock seam 미존재** + **interface 표면 비대** 2건 friction |

### 3.2 SessionRepository

| 항목 | 결과 |
|---|---|
| Deletion test | "complexity reappears" — 삭제 시 Mongoose 호출 + Aggregate↔Document 변환이 PairSubjectService + 향후 controller로 흩어짐 → **DEEP (adapter seam 정합)** |
| Interface ≈ Implementation | Interface 4 method, plain types. Implementation = 변환 3 private helper + Mongoose 호출. 정성 비교 적절 비율. **Step 1 의심 "1:1 비율 shallow"는 정정 — 본 정성 평가에서는 shallow 아님** |
| Dependency category | **2 (Local-substitutable)** — Mongoose `Session` Model. test stand-in: `mongodb-memory-server` 도입 가능 (TD-G-2 후속). 현재 prod = Atlas/Heroku, test = `jest.mock` |
| 결론 | DEEP — strangler 패턴 adapter at seam 정상 동작 |

### 3.3 PairSubjectService

| 항목 | 결과 |
|---|---|
| Deletion test | **현 시점 "complexity vanishes"** — importers_of=0이므로 삭제 시 src/** 영향 0건. 단 BDD 테스트(__tests__/pair-subject.bdd.test.ts)에서만 호출 → 테스트가 유일 caller. 즉 "tests-only module" 상태 |
| Interface ≈ Implementation | Interface 2 method (execute + drainRecordedEvents). Implementation 5-step flow + 3 AppError 분기 + 1 listener 통합 보류 NOTE. 정성 비교 깊이 있음. **Interface 자체는 슬림** |
| Dependency category | 1 (In-process, validation) + Repository 간접 (DB는 Repository가 흡수) + clock embed (L101 `new Date().toISOString()`) |
| 결론 | **🟠 currently hypothetical seam, not yet real seam** — controller wiring (TD-G-3) 미완. 본 단계에서 deep 단정 불가. 일단 "deepenable 후보"로 분류 |

## 4. 외부 의존 식별 (Pass 기준 B 사전 인벤토리)

| # | 의존 | 위치 | category (DEEPENING.md) | 현재 처리 | 잠재 adapter |
|---|---|---|---|---|---|
| D-1 | MongoDB (Mongoose Session Model) | session.repository.ts L11-14, L22, L32, L42, L48 | 2 Local-substitutable | Repository 어댑터 (single) | + mongodb-memory-server in-memory (TD-G-2) → real seam ✅ |
| D-2 | Clock (Date.now / new Date) | session.aggregate.ts L122, L163 / pair-subject.service.ts L101 | 1 In-process embedded | 직접 호출 (테스트 시 `jest.useFakeTimers`로 우회) | + injected clock port (production = systemClock, test = fixedClock) ✅ |
| D-3 | Event listener fire | (현재 미존재 — `drainRecordedEvents` buffer만, pairingListeners 통합 보류) | 3 Remote but owned (잠재 Redis/Socket.io 향한 port) | recordedEvents 메모리 buffer | + production = pairingListeners fire (TD-G-1), test = buffer drain → real seam ✅ |
| D-4 | Mongoose Types.ObjectId.isValid | pair-subject.service.ts L60 | 1 In-process | 정적 함수 (pure) | 별도 port 불필요 |

**adapter 후보 ≥ 3건 잠정 충족** (D-1 / D-2 / D-3). Pass 기준 B는 codex 2라운드에서 cross-LLM이 동일 결론에 도달하면 정식 통과.

## 5. 구조 문제 사전 인벤토리 (Pass 기준 A 사전 후보)

| # | 문제 유형 | 위치 | 원리 위반 | 적용 측정 도구 |
|---|---|---|---|---|
| A-1 | hypothetical seam not real | pair-subject.service.ts (importers_of=0) | LANGUAGE.md §Principles "Two adapters means a real one" — 현재 0 adapter caller | importers_of graph |
| A-2 | clock seam 부재 | session.aggregate.ts L163, pair-subject.service.ts L101 | DEEPENING.md §1 "In-process" 카테고리지만 testability 저해 — embedded clock | source read |
| A-3 | interface 표면 비대 | session.aggregate.ts (10 getters + 6 transitions + 7-arg factory) | LANGUAGE.md §Depth "interface is the test surface" — caller가 학습해야 할 양이 많음 | source read |
| A-4 | event 처리 경로 분기 | pair-subject.service.ts L96-106 vs 기존 pairingListeners (TD-G-1 보류) | LANGUAGE.md §Locality "change concentrates at one place" — 2 경로 공존 | source read + file header 박제 |

**구조 문제 ≥ 2건 잠정 충족** (4건 후보). Pass 기준 A는 Step 4a codex 1차에서 mermaid만 보고 동일 결론에 도달할 수 있는지 검증.

## 6. Step 1 가설 정정

- Step 1 박제 "SessionRepository shallow 후보 (interface 3 : behaviour 3 = 1:1 비율)" → **정정**. LANGUAGE.md "Rejected framings"에서 line-ratio depth 거부 → 본 클래스는 정성 평가상 deep (변환 책임 locality 충족). 단 Step 1 의심 자체는 "ratio 추론은 끼워맞추기 위험"이라는 메타 교훈.

## 7. Step 3 사전 결정 — mermaid 색상/모양 규약

HANDOFF §7 미결 사항 해소:

| 노드 종류 | 모양 | 색상 | 의미 |
|---|---|---|---|
| Class (deep) | 사각형 + 두꺼운 실선 | 파랑 | locality 충족 |
| Class (shallow/hypothetical) | 사각형 + 점선 | 회색 | importer 미연결 또는 interface≈impl |
| Adapter (real) | 마름모 + 실선 | 초록 | 2 adapter 정당화 |
| Adapter (hypothetical) | 마름모 + 점선 | 노랑 | 1 adapter (잠재 seam) |
| External dep | 원 | 빨강 | clock/DB/network/event |
| Test-only path | 화살표 점선 | 회색 | importers_of=0인 path |

## 8. Pass 기준 현재 진행

| 기준 | 사전 인벤토리 | 정식 통과 조건 | 현재 상태 |
|---|---|---|---|
| A ≥ 2 구조 문제 (cross-LLM이 mermaid만 보고 발견) | 4 후보 (A-1~A-4) | Step 4a-c codex 응답 + Claude 반박 | 🟡 사전 충족, codex 검증 대기 |
| B ≥ 3 adapter 후보 | 3 (D-1/D-2/D-3) | Step 4c codex 2라운드 동일 결론 | 🟡 사전 충족, codex 검증 대기 |
| C ≥ 1 cross-LLM delta | 측정 불가 | Step 4b/4c 비교 | ⏳ 대기 |
| D 회귀 0 | src/** 수정 0 | 본 단계까지 유지 | ✅ 충족 |

## 9. 다음 단계 (Step 3)

1. `docs/architecture/deep-module-mermaid.mmd` 작성 — §7 규약 적용
2. mermaid-svg-renderer 스킬로 SVG
3. 자가검증 1줄 — `graph_node_count (Step 1 baseline 35) == mermaid_node_count`
4. 산출물: `docs/architecture/deep-module-mermaid.{mmd, svg}`

## 10. 도구 사용 누적

| 도구 | 호출 수 | 결과 |
|---|---|---|
| Bash (gh api) | 3 | repo tree + skills/ + engineering/ 디렉토리 확인 |
| Bash (curl raw.githubusercontent) | 1 | 4 파일 byte-identical download |
| Read (skill 원본) | 4 | SKILL/LANGUAGE/DEEPENING/INTERFACE-DESIGN 직접 분석 |
| Read (mind-signal src) | 3 | SessionAggregate/Repository/PairSubjectService 본문 |
| query_graph_tool (sequential minimal) | 5 | callers/file_summary/imports/importers/tests |
| 총 graph 호출 | 5 (Step 1의 3개 + Step 2의 5개 합계 8) | internal error 0건 (도구 안정성 규칙 준수 입증) |
