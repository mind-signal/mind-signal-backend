# AGENTS.md — Mind Signal Backend

모든 에이전트(Claude Code / Codex CLI / 기타 모델)가 이 저장소에서 작업할 때 따르는 공통 지시. Claude 전용 메타는 `CLAUDE.md`에 있다.

> 자가완결 — 외부 import 없이 본문만 읽고도 동작 가능해야 함. 상세는 `.agents/rules/*.md` — 이 파일이 1차 소스이고 rules 파일은 단방향 확장.

> **제품 문서와 작업 상태**: 4레포 공통 문서는 `../docs/`(구조·데이터 계약은 `docs/architecture/`, 요구사항·RTM은 `docs/requirements/`)에 있고, 현재 작업 상태 정본은 `../.plans/DASHBOARD.md`(2026-07-30 DOCS-W001)다. 둘 다 이 레포 클론 밖 경로라 §11에 링크 없이도 판단 가능한 요약을 남겨둔다.

## 1. 개요

EEG 실험 플랫폼 백엔드. Express + TypeScript + MongoDB. Operator(PC 연구원)가 QR 페어링 세션을 만들고, Subject(모바일 참여자)가 스캔해 참여한다. 측정 시작 시 백엔드가 `engineProxyService`를 통해 Python 엔진(`core.main`)을 spawn하고, Redis pub/sub으로 EEG 데이터를 받아 Socket.io로 프론트에 브로드캐스트한다.

데이터 흐름: Emotiv 헤드셋 → Emotiv App → `core.main`(백엔드가 spawn) → Redis pub/sub(`mind-signal:{groupId}:subject:{subjectIndex}`) → `02-processes/measurements` → Socket.io → Frontend.

## 2. 로컬 개발 (Windows)

```bash
npm run infra:up     # Docker로 Redis 기동
npm run dev           # dev 서버 + Swagger UI (localhost:5000/api-docs)
npm run test:redis    # Redis 구독 확인 (선택)
```

Python 엔진은 수동 실행 불필요 — 측정 시작 API 호출 시 `measurement.service.ts`가 `core.main`을 spawn한다. 실행 파일 경로는 `DATA_ENGINE_PYTHON`으로 지정.

## 3. 명령어

| 명령 | 용도 |
|---|---|
| `npm run dev` | dev 서버 + Swagger UI |
| `npm run build` | TypeScript 빌드 (`dist/`) |
| `npm start` | 프로덕션 서버 |
| `npm test` | Jest |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run format` / `format:check` | Prettier |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run depcruise` | FSD 경계 검사 |
| `npm run verify` | format:check && typecheck && depcruise && lint && test && build |
| `npm run seed` | DB 시드 |
| `npm run infra:up` / `infra:down` | Docker Redis |

Swagger(`/api-docs`)는 갱신되지 않음 — 실제 라우트 파일을 직접 확인할 것.

## 4. 아키텍처 — FSD

```
src/
├── 07-shared/      인프라: Redis, Socket.io, config, errors, types, middlewares
├── 06-entities/    DB 스키마 & CRUD (Session/User/EegRecord/AnalysisResult)
├── 05-features/    단일 도메인 (auth, users, surveys, sessions QR)
├── 02-processes/   오케스트레이션 (measurements, engine)
└── 01-app/         엔트리, 전역 라우터, 미들웨어
```

Import 방향: `01-app → 02-processes → 05-features → 06-entities → 07-shared`. 번호가 작은 레이어는 번호가 큰 레이어를 import 가능, 역방향은 금지. `07-shared`는 어떤 레이어도 import 금지. `05-features` 간 cross-slice import는 슬라이스의 `index.ts` 경유가 아니면 금지. 레이어 경계를 넘는 import는 반드시 `@0N-layer` path alias 사용, 상대 경로 금지.

금지 사항:
- `dotenv` 직접 사용 → `config.ts` 경유
- `05-features`에서 `mongoose`/`mongodb` 직접 import → `06-entities` 경유
- 서비스 코드에서 `child_process.spawn` 직접 호출 → `measurementService` 내부에만 캡슐화([ADR-004] — 원격 PC 엔진을 `DATA_ENGINE_URL` + `engineRegistryService`로 수용할 여지를 남기기 위함)

세션 상태머신: `CREATED → PAIRED → MEASURING → COMPLETED`, `EXPIRED`/`CANCELLED` 분기 존재. 페어링 타임아웃 5분, 표준 측정 10분, 10초 무응답 시 `CANCELLED`.

Redis 채널 키: `mind-signal:{groupId}:subject:{subjectIndex}` (PC/host 정보 포함 금지, 고정 채널명 금지).

Timestamp: 서버측 ingest timestamp가 단일 진실이고, client-local clock은 intra-batch ordering에만 사용.

전체 alias 목록, `AppError`/Zod/Socket 사용법, FSD 경계 표: `.agents/rules/architecture.md`, `.agents/rules/shared-utils.md`.

## 5. 코딩 컨벤션

들여쓰기 2 spaces, 라인 80자, trailing comma es5, LF, UTF-8. Prettier가 모든 포맷 결정 소유; ESLint 9 flat config, `--max-warnings 0`. TypeScript strict — 근거 없는 `as`/`@ts-ignore` 금지; type-only는 `import type`. 네이밍: 타입/클래스/Enum PascalCase, 함수/변수 camelCase, 모듈 상수 SCREAMING_SNAKE_CASE. 파일: `kebab-case` + dot-role suffix(`session.schema.ts`, `auth.controller.ts`); 테스트는 source 옆 colocate(`src/**/*.test.ts`).

모든 코드 주석(inline/block/JSDoc)은 한국어 명사형으로 종결: `~함, ~완료, ~처리, ~반환, ~생성, ~사용, ~임` (예: `// 사용자 인증 처리함` ○, `// 사용자 인증을 처리합니다` ×). 전체 규칙과 JSDoc 컨벤션: `.agents/rules/code-style.md`.

보안: 사용자 입력은 Zod로 검증 후 저장, raw string 직접 저장 금지(백엔드가 실제 XSS 방어 지점). JWT는 프론트 `localStorage`에 유지 — httpOnly 쿠키 전환은 신규 ADR 필요.

## 6. 검증 — 커밋 전 의무

`npm run verify` (= format:check && typecheck && depcruise && lint && test && build). 한 단계라도 실패하면 커밋·push 금지. `--no-verify` 금지, 근거 없는 `// eslint-disable` 금지, 실패 테스트 삭제로 통과시키기 금지. 동일 단계 3회 연속 실패 시 사람에게 에스컬레이션. CI는 MongoDB/Redis에 연결하지 않으므로 integration 테스트는 mock 격리 또는 `it.skip` 처리. 상세: `.agents/rules/verification-loop.md`.

## 7. 커밋과 브랜치

Conventional Commits: `{type}({scope}): {description}` — type은 `feat fix docs chore refactor test ci revert perf style`, scope는 소문자 kebab-case, description은 소문자 시작·마침표 없음.

브랜치 네이밍(Work ID 스타일 — Work ID 정의는 §11 참조): `{type}/{domain-wNNN}-{slug}`, 예: `feat/auth-w001-realtime-channel-auth`, `fix/session-w102-pairing-timeout`, `docs/docs-w010-agent-docs-restructure`. `refactor/`, `chore/`도 동일 패턴.

태스크 1개 = 커밋 1개. `main` 직접 커밋 금지 — `feat/... → PR → dev → PR → main`.

모든 커밋은 마지막에 아래를 붙인다:
```
Co-authored-by: KWONSEOK02 <gwonseok02@gmail.com>
```
이 주소 고정(`noreply` 금지), Claude `Co-Authored-By` 라인 금지. 클론당 최초 1회: `git config core.hooksPath .githooks` (pre-push gate 활성화).

전체 type 표, pre-push gate 상세, commitlint advisory 상태, merge 전략: `.agents/rules/git-workflow.md`.

## 8. 테스트

Jest + supertest 사용(Vitest 금지). 신규 기능: 최소 unit 1(happy path) + edge case 1; API route는 supertest로 happy path + 400 + 401 추가. 동작 변경 없는 리팩토링은 test assertion을 바꾸지 않는다. 이 레포 밖 파일(예: `mind-signal-data-engine`)에 의존하는 테스트는 `fs.existsSync` + `it.skip`으로 가드 — CI는 이 레포만 체크아웃한다. 상세: `.agents/rules/test-modification.md`.

## 9. 환경변수 파일

`.env.example`(추적) → `.env.local`(로컬)/`.env.test`(테스트)로 복사. Python 엔진은 자체 `.env.local`에 `CLIENT_ID`/`CLIENT_SECRET` 보관.

## 10. 도메인 용어

Operator/Subject = PC 연구원/모바일 참여자. Phase 1 세션 생성, 1.5-A 모바일 페어링, 1.5-B 동의, Phase 2 EEG 측정(Python spawn + Redis + Socket.io), Phase 3 AI 분석 오케스트레이션(`02-processes/engine`). Group = 실험 단위(`groupId`, 최대 2 Subject). EmotivMetrics = focus/engagement/interest/excitement/stress/relaxation.

## 11. 문서화 & Work ID

FR 구현: `docs/requirements/FR-XX-<slug>.md` + 동일 PR에 RTM row. 기술 결정: `docs/architecture/decisions/ADR-NNN-<slug>.md`(Accepted 후 append-only). Spike/벤치마크: `docs/reports/`. 전체 결정 트리: `.agents/rules/documentation.md`.

제품 전체 계획 폴더는 이 레포 밖 `Team-project/mind-signal/.plans/`에 있다(`Team-project/.plans/`는 크로스 프로젝트 메타 전용이라 다름). Work ID는 `{DOMAIN}-W{NNN}[-slug]` 형태이고, 도메인(`ANALYSIS`, `EEG`, `SESSION`, `OPS`, `DOCS`)별로 독립 채번한다. 신규 작업은 W001부터, 2026-07-30 마이그레이션 시점에 소급 부여한 것은 W101부터 시작한다(그래서 `SESSION-W114`는 전체 114번째가 아니라 Session 소급 14번째다). 번호는 영구 식별자 — 재번호화·재사용 없음, 시간순은 번호가 아니라 레지스트리의 "시기" 열로 읽는다. 규칙 정본: `mind-signal/.plans/README.md`; 소급 매핑: `mind-signal/.plans/LEGACY-REGISTRY.md`.

## 12. 트러블슈팅

Redis 연결 안 됨: `docker ps` → `npm run infra:down && npm run infra:up`. Python 엔진 실행 안 됨: `conda activate mind-signal`, Emotiv App과 헤드셋 연결 확인. 포트 5000 충돌(Windows): `netstat -ano | findstr :5000` → `taskkill /PID <id> /F`. 추가 사례: `.agents/rules/troubleshooting.md`.
