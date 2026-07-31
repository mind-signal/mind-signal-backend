# 🚧 SCAFFOLD — Phase G 교수 면담 시연 PAAR (2026-05-26)

> **이 파일은 D-10(2026-05-16) 사전 생성 스캐폴드.** 시연 당일·직후(24h내) `[[TODO ...]]` 빈칸을 실측으로 채운 뒤 본 배너 줄 삭제.
> **미작성 상태로 git 커밋 금지** (docs/reports README WIP 정합). 작성 완료 후 커밋.
> 트랙 1 완료 조건 = 본 paar 박제 → P-3 prerequisite 해소 → Phase G CRITIQUE 자동 재평가 trigger ([[project_phase_g_done]]).

> 작성일: 2026-05-26 (시연 수행일 기준)
> Phase: I 완결 후 / Phase G 시연 (5/26 교수 면담)
> 형식: PAAR (문제·행동·분석·결과) — 시연 결과 스냅샷 동결

---

## 0. Baseline (시연 시점 — D-10 박제, 변경 시 갱신)

- **production**: Heroku `v66 = Deploy 3769cde0` = `origin/main`(PR #62). PR-A1+PR-A8+redact+config 마스킹.
- **branch 동기**: `origin/dev` == `origin/main` == `3769cde`. ADR-001~009 Accepted.
- **DB**: Heroku == dev == test 단일 `mind_signal_dev` (todo-dev-cluster). 회전된 새 자격증명, config 마스킹 live.
- **시연 안전 경로 2종 (production live, D-10 실측 GREEN)**:
  - 경로 A — 일반 페어링 (QR 스캔 → `PAIRED`)
  - 경로 B — admin 5-tap force-pair (모바일 실패 fallback, ADMIN_EMAILS allowlist 경유)
- **D-10 재점검 근거**: `.plans/_archive/demo-2026-05-26-run-sheet.md` §0 (Heroku v66 up / FE canonical 200×2 / 마스킹 live).

---

## 1. 문제 (Problem) — 시연 목표·prerequisite

- Phase G(DDD/BDD/TDD pilot) 교수 면담 시연. P-3 prerequisite = 시연 성공 + 본 paar 24h내 박제 시 해소.
- 시연으로 입증할 것: `[[TODO 시연으로 보여줄 핵심 — 예: QR 페어링 정상 동선 + admin fallback 안전망]]`

## 2. 행동 (Action) — 실제 수행한 시연 동선

> 런시트 §2 경로 A / 경로 B 기준. 실제 수행 경로·순서를 사실대로 박제.

- 경로 A (일반 페어링): `[[TODO 수행/미수행 + 관찰 결과]]`
- 경로 B (admin 5-tap force-pair): `[[TODO 수행/미수행 + HTTP 응답 코드 + 세션 전이]]`
- 측정(Phase 2) 데모 여부: `[[TODO]]`

## 3. 분석 (Analysis) — 관찰·이슈·원인

- audit log (`heroku logs --tail`) 관찰: `[[TODO [admin-force-pair] outcome=success prefix 라인 유무 / 일반 페어링 로그]]`
- 발생 이슈: `[[TODO 없음 / 있으면 증상·원인·즉시대응(런시트 §4 표 참조)]]`
- 함정 재발 여부 (런시트 §6 4건 중): `[[TODO]]`

## 4. 결과 (Result) — 시연 성패·후속

- 시연 성패: `[[TODO 성공 / 부분 / 실패]]`
- 교수 피드백 요지: `[[TODO]]`
- **P-3 prerequisite**: `[[TODO 해소 / 미해소 — 해소 시 Phase G CRITIQUE 자동 재평가 대상]]`
- 후속 액션:
  - [ ] `/obsidian-record` — history + CHANGELOG 박제 (직접 write 금지)
  - [ ] `/pf status` — STATE.md / DONE.md 갱신
  - [ ] (해소 시) Phase G CRITIQUE Revision 재평가 — 6/16 사후측정 트랙 2와 연계
  - [ ] 시연 이후 Phase L 진입 가능: `/pf discuss L-pairing-service-removal` (핸드오프 §2 LOCK 해제 시점)

---

## 5. Cross-link

- 런시트(동선·체크리스트·실패대응): `.plans/_archive/demo-2026-05-26-run-sheet.md`
- 다음작업 HANDOFF: `.plans/_next-session-handoff.md` (트랙 1 완료 조건)
- 6/16 사후측정 paar(트랙 2): `mind-signal-backend/docs/reports/paar-2026-06-16-phase-g-post-mortem.md` (미생성)
- 메모리: [[project_phase_g_done]] (5/26·6/16 의무) / [[feedback_no_fabricated_evidence]] (시연 결과 날조 금지 — 실패도 사실대로)

---

**END (SCAFFOLD)** — 시연 당일 `[[TODO]]` 채우고 §0 배너 삭제 후 커밋. 회귀/결과 날조 0 ([[feedback_no_fabricated_evidence]]).
