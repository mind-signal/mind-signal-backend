# Local Addendum — Mind Signal H-deep-module-poc 적용 노트

> 작성일: 2026-05-13
> 대상: `improve-codebase-architecture` skill의 Mind Signal 컨텍스트 변형 박제
> 원본 4 파일 (SKILL/LANGUAGE/DEEPENING/INTERFACE-DESIGN.md)은 byte-identical 유지 — 본 addendum은 PoC 적용 변형만 다룸

---

## 1. HANDOFF tentative 임계값 폐기 — "depth = behavior / interface lines, threshold 2.0"

`.plans/_archive/legacy/H-deep-module-poc/HANDOFF.md` (DOCS-W102) §5 Step 2와 §7 미결 사항에 박제된 잠정 공식:

```
depth = behavior_size / public_interface_size — 임계값 2.0 잠정
```

**이 공식은 본 PoC에서 사용하지 않음.** 근거: `LANGUAGE.md` §"Rejected framings" 1번 항목.

> "Depth as ratio of implementation-lines to interface-lines (Ousterhout): rewards padding the implementation. We use depth-as-leverage instead."

Matt Pocock 본인이 명시적으로 거부한 측정. 임계값 2.0을 적용하면 PoC가 끼워맞추기 위험(`feedback_no_fabricated_evidence` 위반)에 노출됨.

## 2. 대체 측정 — 정성 평가 3축

원문 SKILL.md + LANGUAGE.md + DEEPENING.md에서 직접 인용 가능한 측정 도구:

### 2.1 Deletion test (SKILL.md §Glossary, LANGUAGE.md §Principles)
> "Imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep."

3 클래스 각각에 대해 적용:
- 결과 = "complexity vanishes" → shallow
- 결과 = "complexity reappears across N callers" → deep

### 2.2 Interface complexity ≈ implementation complexity (LANGUAGE.md §Depth)
> "Shallow when the interface is nearly as complex as the implementation."

정량 ratio 대신 정성 비교 — public method 수 / invariant 수 / error mode 수와 implementation 분기 수 / 외부 호출 수의 대략적 정합 평가.

### 2.3 Dependency 4 categories (DEEPENING.md §Dependency categories)
1. **In-process** — pure computation, in-memory state, no I/O
2. **Local-substitutable** — PGLite, in-memory FS 등 local stand-in 보유
3. **Remote but owned** — Ports & Adapters, port + 2 adapter
4. **True external** — Stripe/Twilio 같은 third-party

각 클래스의 외부 의존을 4 카테고리로 분류 → adapter 후보 판별.

## 3. Seam discipline (DEEPENING.md + LANGUAGE.md)

> "One adapter means a hypothetical seam. Two adapters means a real one."

PoC Pass 기준 B (adapter 후보 ≥ 3)는 본 원칙과 정합:
- 후보 = 2 adapter 이상 정당화 가능한 seam만 카운트
- 단일 adapter 인디렉션은 후보에서 제외

## 4. CONTEXT.md 부재 처리

SKILL.md §2는 CONTEXT.md vocabulary 사용을 요구. mind-signal-backend는 별도 CONTEXT.md 미보유.

**대체**:
- 도메인 어휘는 `mind-signal-backend/CLAUDE.md` §8 Domain Terms (Operator/Subject/Phase 1/Group/EmotivMetrics 등) 사용
- ADR 영역은 `docs/architecture/decisions/ADR-006` (Phase G) 참조

## 5. Pass 기준 매핑

| Pass 기준 | 적용 측정 도구 (원문 위치) |
|---|---|
| A ≥ 2 구조 문제 | Deletion test (SKILL §Glossary) + interface≈impl 정성 비교 (LANGUAGE §Depth) |
| B ≥ 3 adapter 후보 | Dependency 4 categories (DEEPENING §1~4) + Two-adapter rule (DEEPENING §Seam discipline) |
| C ≥ 1 cross-LLM delta | 두 LLM이 동일 LANGUAGE.md 7 terms grounding |
| D 회귀 0 | read-only 유지 (src/** 수정 0) |

## 6. 다음 단계 ↔ 원문 매핑

| 본 PoC 단계 | 원문 SKILL.md Process |
|---|---|
| Step 2 depth + adapter 후보 | Process §1 Explore |
| Step 3 mermaid + 후보 정리 | Process §2 Present candidates |
| Step 4a-c cross-LLM 검토 | Process §3 Grilling loop |
| Step 5 TDD 명세 | INTERFACE-DESIGN §2 "design twice" (3+ alt interface) — PoC에서는 1 후보만, 별도 PR로 다중 alt 작성 |

## 7. 출처

- 원본 4 파일 (`SKILL.md`, `LANGUAGE.md`, `DEEPENING.md`, `INTERFACE-DESIGN.md`) — `mattpocock/skills@main:skills/engineering/improve-codebase-architecture/`
- HANDOFF 박제된 5번째 파일 REFERENCE.md는 실재하지 않음 (2026-05-13 확인 — repo에는 4 파일만 존재)
- SHA256 byte-identical 검증 결과는 `.plans/_archive/legacy/H-deep-module-poc/HANDOFF.md` 후속 박제 예정
