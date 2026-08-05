# mind-signal-backend

## 1. 프로젝트 개요 (Project Overview)

**Mind Signal Backend**는 EEG(뇌파) 기반 2인 심리 동기화 측정 · 분석 서비스의 **백엔드 서버**입니다.
Operator의 세션 생성 → Subject QR 페어링 → 실시간 EEG 스트리밍 → 사후 분석 파이프라인을 오케스트레이션합니다. Python Data Engine을 세션별로 spawn하고, Redis Pub/Sub으로 수집된 데이터를 Socket.io로 프론트엔드에 브릿지합니다.
졸업 프로젝트로 실제 협업 경험과 실시간 데이터 파이프라인 운영을 핵심 목표로 합니다.

### 핵심 파이프라인

```text
Emotiv 헤드셋 → Emotiv App → Python Data Engine (spawn)
              → Redis Pub/Sub → Backend SUBSCRIBE
              → Socket.io → Frontend 실시간 차트
```

---

## 2. Tech Stack

| 구분 | 기술 |
| :--- | :--- |
| **Runtime** | `Node.js 20+`, `TypeScript strict` |
| **Framework** | `Express 4.x`, `Socket.io` |
| **Architecture** | `Feature-Sliced Design` (커스텀 번호 체계) |
| **DB / Infra** | `MongoDB Atlas` (Mongoose), `Redis` (Docker Compose) |
| **Auth** | `JWT` (HS256), `Google OAuth`, `Kakao OAuth` |
| **Validation** | `Zod` DTO |
| **Test** | `Jest`, `Supertest` |
| **Quality** | `ESLint`, `Prettier`, `tsc-alias` |
| **External Services** | Python Data Engine (`FastAPI` via HTTP proxy), `Google Gemini` |
| **DevOps** | `Heroku` |

---

## 3. 프로젝트 클론 및 각종 명령어

### 저장소 복제

```bash
git clone https://github.com/KWONSEOK02/mind-signal-backend.git
```

### 의존성 설치

```bash
npm install
```

### 환경 변수 설정

`.env.example`을 복사해서 `.env.local` (로컬) / `.env.test` (테스트) 파일을 생성합니다.

```bash
cp .env.example .env.local
```

### 로컬 인프라 (Redis) 기동 / 정리

```bash
npm run infra:up      # Docker Compose로 Redis 컨테이너 기동
npm run infra:down    # 컨테이너 정리
npm run test:redis    # Redis 연결 헬스체크
```

### 개발 서버 실행

```bash
npm run dev
```

### 테스트

```bash
npm run test
```

### 포맷 자동 수정 / 검증

```bash
npm run format                        # Prettier --write
npx prettier --check "src/**/*.ts"    # CI와 동일 검증
```

### 린트

```bash
npm run lint
npm run lint:fix
```

### 빌드

```bash
npm run build
```

---

## 4. API 엔드포인트

| Method | Endpoint | 설명 |
| :--- | :--- | :--- |
| **POST** | `/auth/signup` | 회원가입 |
| **POST** | `/auth/login` | 로그인 |
| **GET** | `/user/me` | 내 정보 조회 |
| **POST** | `/sessions` | 페어링 세션 생성 (Phase 1) |
| **POST** | `/sessions/:pairingToken/pair` | 모바일 기기 페어링 연결 (Phase 1.5-A) |
| **POST** | `/sessions/:sessionId/consents` | 동의서 제출 및 스냅샷 생성 (Phase 1.5-B) |
| **POST** | `/measurements/sessions/:sessionId/eeg/stream:start` | 실시간 뇌파 스트리밍 시작 및 외부 엔진 트리거 (Phase 2) |
| **GET** | `/surveys/questions` | 사용자에게 보여줄 모든 설문 문항 목록 조회 |
| **POST** | `/surveys/responses` | 사용자가 작성한 설문 응답들을 일괄 저장 |
| **GET** | `/surveys/responses` | 로그인한 사용자가 제출한 설문 응답 목록 조회 |
| **GET** | `/analyzer` | 현재 접속되어있는 계정 정보로 데이터 엔진에 데이터 요청 |

---

## 5. 프로젝트 구조

```text
mind-signal-backend/
├── node_modules/           # Node.js 모듈
│
├── src/                    # 애플리케이션 소스 코드
│   ├── 01-app/             # 애플리케이션의 엔트리 포인트, 전역 설정, 라우터 정의
│   │   ├── app.router.ts
│   │   ├── app.ts
│   │   ├── diag.controller.ts     # 진단용 엔드포인트
│   │   ├── health.controller.ts   # 헬스체크 엔드포인트
│   │   ├── startup-listeners.ts   # 프로세스 시작 이벤트 리스너
│   │   └── static.ts              # 정적 파일 서빙
│   │
│   ├── 02-processes/       # 비즈니스 프로세스 및 워크플로우 (복잡한 여러 features를 조합)
│   │   └── measurements/   # 실시간 스트리밍 프로세스 및 외부 엔진 오케스트레이션
│   │
│   ├── 03-pages/           # 페이지 수준의 로직 (현재는 백엔드이므로 비어있음)
│   │
│   ├── 04-widgets/         # 위젯 (재사용 가능한 UI 컴포넌트, 백엔드에서는 드물게 사용)
│   │
│   ├── 05-features/        # 특정 기능 구현 (예: 인증, 사용자 관리)
│   │   ├── auth/           # 인증 유스케이스(로그인/가입/토큰 발급·갱신/로그아웃 등) + 라우트 단위 로직
│   │   ├── analyzer/       # 데이터분석 결과 요청 및 응답
│   │   ├── sessions/       # PC-모바일 간 기기 페어링 연동 및 측정 전 동의 제출 프로세스 관리
│   │   ├── surveys/        # 사용자 성향 분석용 설문 문항 및 응답 데이터
│   │   └── users/          # 사용자 관리 기능
│   │
│   ├── 06-entities/        # 도메인 엔티티 (데이터 모델, 스키마, CRUD 로직)
│   │   ├── analysis-results/    # 뇌파 및 설문 기반 AI 매칭 분석 결과 기록
│   │   ├── consents/            # 개인정보 활용 및 연구 참여 동의 이력 관리
│   │   ├── eeg-records/         # 측정된 뇌파 원천 데이터 및 로그 정보
│   │   ├── matching-pools/      # 분석 점수 기반의 사용자 간 매칭 데이터
│   │   ├── neuro-chats/         # AI 상담원 '뉴로'와의 상호작용 대화 로그
│   │   ├── sessions/            # 기기 페어링 토큰 발급 및 세션 생명주기(Status Machine) 관리
│   │   ├── surveys/             # 사용자 성향 분석용 설문 문항 및 응답 데이터
│   │   └── users/               # 사용자 계정 정보 및 뇌파 유형/멤버십 프로필
│   │
│   └── 07-shared/          # 범용 유틸리티, 설정, 상수 (어디서든 사용 가능)
│       ├── api/            # 공통 API 클라이언트 또는 유틸리티
│       ├── config/         # 환경 설정 (예: 데이터베이스 연결 정보)
│       │   ├── config.ts
│       │   └── swagger.ts
│       ├── errors/         # 애플리케이션 공통 에러 정의
│       ├── lib/            # 공통 라이브러리, 헬퍼 함수
│       ├── middlewares/    # 공통 미들웨어
│       └── types/          # 공통 타입 정의
│
├── .env.example            # 환경 변수 템플릿 (Git 추적)
├── .env.local              # 로컬 환경 변수 (Git 추적 제외)
├── .env.test               # 테스트 환경 변수 (Git 추적 제외)
├── .eslint.config.mjs      # ESLint 설정 파일
├── .gitattributes          # Git 속성 설정 파일
├── .gitignore              # Git이 무시할 파일 및 폴더 목록
├── .prettierignore         # Prettier가 무시할 파일 및 폴더 목록
├── .prettierrc             # Prettier 설정 파일
├── docker-compose.yml      # 로컬 개발 인프라(Redis 등) 컨테이너 설정 및 구동 명세서
├── jest.config.js          # Jest 테스트 설정 파일
├── package-lock.json       # 패키지 의존성 잠금 파일
├── package.json            # 프로젝트 메타데이터 및 스크립트
├── README.md               # 프로젝트 설명 파일
└── tsconfig.json           # TypeScript 컴파일러 설정 파일
```

### 폴더 구조 표현 원칙

이 프로젝트의 FSD (Feature-Sliced Design) 폴더 구조는 다음과 같은 원칙에 따라 README.md에 표현됩니다:

- **`01-app/` 및 `07-shared/`**: 애플리케이션의 엔트리/전역 규약(예: app wiring, 전역 미들웨어, 공통 에러/설정 등)을 담는 계층입니다. **이 계층 내에서는 `01-app/`의 모든 내부 파일과 `07-shared/config/config.ts` 파일의 존재를 상세히 표기합니다.** 온보딩에 중요한 진입점이 있는 경우, README에 내부 구조를 상대적으로 상세히 표기합니다.
- **`02-processes/` ~ `06-entities/`**: 비즈니스 도메인/기능 단위로 확장되는 계층입니다. README에는 최상위 폴더(도메인)만 노출하고, **그 하위 계층(예: `05-features/auth/` 또는 `06-entities/users/`)은 1단계 하위 폴더까지만 표시합니다.** 내부 파일 및 더 깊은 하위 폴더 구조는 원칙적으로 각 도메인의 `index.ts` (Public API)를 통해 접근하도록 합니다. 이를 통해 계층 간 결합도를 낮추고 내부 변경의 영향을 최소화합니다.
- **세분화 기준**: 한 폴더에 파일이 증가해 가독성이 떨어지면(예: 6~8개 이상) `api/`, `model/`, `lib/` 등 하위 폴더로 점진적으로 분리하는 것을 원칙으로 합니다.

---

## 6. 02-processes 계층과 05-features 계층 중에 controller를 배치하는 기준

Phase 1: PC(Web) 페어링 페이지 → QR 띄우기
Phase 1.5: 모바일 QR 스캔 & 동의
Phase 2: EEG 측정 및 데이터 저장
Phase 3: 분석 & 피드백

-02-processes 계층에 controller를 배치하는 경우
기준: 여러 도메인 엔티티가 섞이거나, 외부 인프라(Redis, Data-Engine)와의 복잡한 오케스트레이션이 필요한 경우.

사례:
Phase 1.5 ~ 2 (Pairing & Streaming): QR 스캔, 세션 상태 전환, 외부 엔진 실행, 실시간 데이터 브릿징이 유기적으로 연결되어야 함.
Phase 3 (Analysis): 측정 데이터 수집 완료 후 AI 모델 호출 및 결과 가공 등 복합적인 비즈니스 로직 수행.

-05-features 계층에 controller를 배치하는 경우
기준: 단일 도메인에 국한된 독립적인 기능이거나, 상위 계층(Processes)의 로직을 호출할 필요가 없는 단순 CRUD 기능인 경우.

사례:
Auth, Users, Surveys: 다른 복잡한 프로세스와의 결합 없이 독립적으로 동작 가능.
Sessions: **QR 코드를 보여주기 위한 세션 생성/조회 기능만** 05-features 계층에 배치, **측정을 시작하는 POST 요청**은 02-processes/measurement에서 처리

[draw.io v1.1 스키마 + 프로그램 동작](https://drive.google.com/file/d/1M-I8KD0ooohrz1stDZWki-oXhXVrb3eM/view?usp=drive_link)

---

## 7. 협업 가이드라인 (Contribution Guidelines)

### Git Workflow

- `main` (Production): 최종 배포 브랜치 — 직접 push 금지. `dev`에서만 PR 올림
- `dev` (Staging): 개발 통합 브랜치 — 모든 `feat/*` 기능 브랜치의 PR 대상
- `feat/{도메인-wNNN}-{작업명}`: 기능 브랜치 (Work ID 필수, §10 참조)
- `fix/{작업명}`: 버그 수정 브랜치 (Work ID 불필요)
- `docs/{작업명}`: 문서 작업 브랜치 (Work ID 불필요)
- `refactor/{작업명}`, `chore/{작업명}`, `hotfix/{작업명}`: 그 외 목적별 브랜치 (Work ID 불필요)

### 작업 흐름 (모든 변경은 이슈 기반)

모든 코드 변경은 반드시 **GitHub Issue를 먼저 생성**한 뒤 진행합니다. **`main` 직접 commit은 금지**이며, `dev` 직접 commit도 원칙적으로 금지합니다. 오타·로컬 세팅·사소한 문서 수정도 예외 없이 이슈 → 브랜치 → PR 절차를 따릅니다.

1. **Issue 생성**: GitHub Issues → New Issue → 템플릿 선택 후 작업 내용 등록 (제목: `feat: 작업 내용`)
2. **브랜치 생성**: **base를 `dev`로 설정** → `타입/{도메인-wNNN}-{작업명}` 형식 (§10 참조, Issue 번호와 별개)
3. **개발**: 기능 구현. 커밋 전 로컬 검증(§8) 통과 필수
4. **PR**: **base를 `dev`로 설정**하여 PR 생성 (main 아님). Reviewers / Assignees / Labels 지정
5. **코드리뷰**: 팀원 1명 이상의 Approve + CodeRabbit 리뷰 확인
6. **머지**: 승인 완료 후 `feat/*` → `dev` 머지
7. **Issue Close**: 머지 직후 해당 이슈 close
8. **릴리스**: `dev`가 안정화되면 `dev` → `main` PR을 별도 생성, CI + CodeRabbit 리뷰 통과 후 머지

### 프로젝트 규칙

- **PR은 작은 단위로.** 하나의 PR은 하나의 이슈 · 하나의 기능에만 집중합니다.
- 세부 작업은 이슈 체크리스트로 관리합니다.
- 머지 직전 `dev` 최신 변경 사항을 `pull` 하여 충돌을 최소화합니다.

### 개발 가이드라인

- 코딩 스타일: **ESLint + Prettier** 기준
- 변수 / 함수 네이밍: **camelCase**
- 폴더 네이밍: **kebab-case**, 복수형 (도메인/개념 단위 명사로만 구성)
- 파일 네이밍: **단수형**, **kebab-case + dot(.)** role suffix (예: `auth.service.ts`, `sessions.route.ts`)
- TypeScript strict mode, `any` 금지 — `unknown` 또는 명시 타입
- 주석 스타일: JSDoc (Google Style), 종결 어미는 명사형 (`~함`, `~처리`, `~반환`)

---

## 8. CI 파이프라인 & AI 코드 리뷰

PR이 올라오면 아래 순서로 자동 검증됩니다.

```text
  PR 생성 / feat·fix·docs·refactor 브랜치 push
     ↓
┌─── CI 자동 검증 (6단계) ──────────────────────┐
│ 1. format:check  → Prettier 포맷 검증         │
│ 2. typecheck     → tsc --noEmit               │  ← 1·2·4·5·6
│ 3. depcruise     → FSD 경계 검사 (advisory)   │     FAIL 시 머지 차단
│ 4. lint          → ESLint 정적 분석           │     (3은 continue-on-error)
│ 5. test          → Jest 유닛 테스트           │
│ 6. build         → tsc + tsc-alias            │
└────────────────────────────────────────────────┘
     ↓ CI 통과한 코드만
┌─── CodeRabbit AI 리뷰 ────────────────────────┐
│ • FSD 레이어 위반 / any 타입                  │
│ • 비즈니스 로직 / 트랜잭션 경계 / 보안        │
│ • Zod 검증 누락 / 에러 핸들링                 │
└────────────────────────────────────────────────┘
```

`depcruise`(FSD 경계 검사)는 `continue-on-error: true`로 실행되어 현재는 advisory입니다 — 위반이 보고되지만 머지를 막지는 않습니다. `commitlint`도 PR마다 돌지만 동일하게 advisory 상태입니다.

### PR 전 로컬에서 확인하는 법

```bash
npm run verify
# = format:check && typecheck && depcruise && lint && test && build
```

한 단계라도 실패하면 멈추고 수정 후 재실행합니다. Integration 테스트가 필요하면 `npm run infra:up`으로 로컬 Redis를 먼저 기동하고, CI 대상 테스트는 mock으로 격리합니다.

---

## 9. 커밋 메시지 컨벤션

**Conventional Commits** 규칙을 따릅니다. Gitmoji 이모지는 사용하지 않습니다.

### 형식

```text
{type}({scope}): {description}
```

예시:

```text
feat(sessions): add pairing token-based session creation API
fix(auth): handle JWT expiry in refresh flow
refactor(measurement): extract engine proxy service
chore(deps): bump socket.io to 4.8.0
```

### 타입 목록

| 타입 | 용도 |
|------|------|
| feat | 새 기능 |
| fix | 버그 수정 |
| refactor | 리팩토링 (기능 변경 없는 구조 개선) |
| style | 포맷·세미콜론·공백 (로직 변경 없음) |
| docs | 문서 변경 |
| chore | 빌드·설정·패키지 |
| test | 테스트 추가·수정 |
| perf | 성능 개선 |
| ci | CI 설정 |
| revert | 이전 커밋 되돌리기 |

- 태스크 1개 = 커밋 1개
- `main` 브랜치 직접 commit 금지 — 반드시 `feat/{도메인-wNNN}-{작업명}` 브랜치에서 작업 후 `dev`로 PR

---

## 10. 브랜치 네이밍 컨벤션

```text
feat/{도메인-wNNN}-{작업명}                        # 기능 브랜치, Work ID 필수
{fix|hotfix|refactor|docs|chore}/{작업명}          # 그 외 브랜치, Work ID 불필요
```

`feat/*` 브랜치는 Work ID(`{DOMAIN}-W{NNN}`, 예: `AUTH-W001`, `SESSION-W102`) 기반으로 만듭니다. Work ID 채번 규칙은 `AGENTS.md` §11 참조. 나머지 타입(`fix`, `hotfix`, `refactor`, `docs`, `chore`)은 Work ID 없이 짧은 설명만 붙입니다.

예시:

- `feat/auth-w001-realtime-channel-auth`
- `fix/measurement-complete-handler-cleanup`
- `hotfix/session-pairing-timeout`
- `docs/agent-docs-restructure`
- `refactor/engine-proxy-extract`
- `chore/bump-socket-io`

base branch는 항상 `dev`로 설정합니다.

---

## 11. AI 에이전트 작업 규칙

이 저장소에서 AI 에이전트(Claude Code, Codex CLI 등)가 작업할 때 따라야 할 규칙은 `AGENTS.md`(공통) / `CLAUDE.md`(Claude 전용) / `.agents/rules/*.md`(상세)를 참조하세요.
