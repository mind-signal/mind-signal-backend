# Architecture Overview — System Context (C4 Level 1)

> **BE 관점의 시스템 컨텍스트 다이어그램.** 누가 시스템을 사용하고,
> 어떤 외부 시스템과 통신하는지를 보여줌. 프레임워크 명이나 DB 스키마
> 이름이 아닌 비즈니스 언어(`Operator`, `Subject`)로 기술함.

## One-line description

Mind Signal은 Emotiv EEG 헤드셋으로 피실험자의 뇌파를 실시간 수집·분석하여
연구자(Operator)에게 라이브 시각화 및 AI 분석 결과를 제공하는 뇌-컴퓨터 인터페이스 연구 플랫폼임.

## System context diagram

```mermaid
%% C4 Level 1 — System Context (BE perspective)
flowchart TB
    subgraph LocalPC["Operator PC (로컬)"]
        Headset(["Emotiv 헤드셋\n(BLE/USB)"])
        EmotivApp["Emotiv App\n(로컬 실행 필수)"]
        PythonEngine["Python core.main\n(세션별 on-demand spawn)"]
        Headset -->|"BLE / USB"| EmotivApp
        EmotivApp -->|"Cortex WebSocket"| PythonEngine
    end

    Redis[("Redis\n(Docker 6379)")]
    BE[["Mind Signal Backend\n(Node.js / Express + TS)\nHeroku 배포"]]
    FE["Mind Signal Frontend\n(Next.js App Router)\nVercel 배포"]
    MongoDB[("MongoDB\n(Atlas)")]

    Operator(["Operator\n(연구원)"])
    Subject(["Subject\n(피실험자)"])
    GoogleOAuth["Google OAuth 2.0"]
    KakaoOAuth["Kakao OAuth 2.0"]
    EmotivCortex["EMOTIV Cortex API"]

    PythonEngine -->|"Redis publish\nmind-signal:{groupId}:subject:{subjectIndex}"| Redis
    Redis -->|"subscribe"| BE
    BE -->|"HTTP/WS\n(engineRegistryService)"| PythonEngine
    BE -->|"Socket.io\n실시간 EEG 스트림"| FE
    BE -->|"read / write"| MongoDB
    FE -->|"HTTPS REST"| BE

    Operator -->|"세션 생성·모니터링"| FE
    Subject -->|"QR 스캔·동의서 제출"| FE
    BE -->|"OAuth 토큰 검증"| GoogleOAuth
    BE -->|"OAuth 토큰 검증"| KakaoOAuth
    PythonEngine -->|"EEG 스트림 구독"| EmotivCortex

    classDef person fill:#08427B,stroke:#052E56,color:#fff
    classDef system fill:#1168BD,stroke:#0B4884,color:#fff
    classDef external fill:#666,stroke:#444,color:#fff
    classDef infra fill:#2D6A4F,stroke:#1B4332,color:#fff
    classDef local fill:#E8F5E9,stroke:#2D6A4F,color:#222

    class Operator,Subject person
    class BE system
    class FE,Redis,MongoDB infra
    class GoogleOAuth,KakaoOAuth,EmotivCortex,EmotivApp external
    class PythonEngine external
```

## Actors

| Actor | Type | 역할 |
|---|---|---|
| `Operator` | Person | PC에서 실험을 관리하는 연구원. QR 생성, EEG 라이브 차트 모니터링, 분석 결과 확인함 |
| `Subject` | Person | 모바일로 QR 스캔하여 참여하는 피실험자. EEG 측정 대상임 |

## External systems

| System | Direction | Purpose |
|---|---|---|
| `Emotiv App` | outbound (local) | Emotiv 헤드셋 BLE/USB 연결을 수신하여 Cortex WebSocket으로 스트림 제공함 |
| `EMOTIV Cortex API` | outbound | Python 엔진이 EEG 원시 데이터를 구독하는 Emotiv 공식 SDK WebSocket API |
| `Redis (Docker 6379)` | bidirectional | Python 엔진 → BE pub/sub 채널. 채널 키: `mind-signal:{groupId}:subject:{subjectIndex}` |
| `MongoDB Atlas` | outbound | 사용자, 세션, 설문, EEG 레코드, 분석 결과 영속 저장함 |
| `Google OAuth 2.0` | outbound | Operator / Subject 소셜 로그인 토큰 검증함 |
| `Kakao OAuth 2.0` | outbound | Operator / Subject 소셜 로그인 토큰 검증함 |
| `Vercel (FE 배포)` | inbound | Next.js App Router 프론트엔드 호스팅. BE에 HTTPS REST 요청 전송함 |
| `Heroku (BE 배포)` | — | Node.js/Express 백엔드 호스팅 플랫폼 |

## Key data flows

| Flow | Description |
|---|---|
| **EEG 실시간 스트림** | Headset → Emotiv App → Python(Cortex WebSocket) → Redis publish → BE subscribe → Socket.io → FE |
| **세션 생성** | Operator FE `POST /sessions` → BE 세션 생성 → MongoDB 저장 → QR 코드 응답 |
| **Subject 페어링** | Subject FE `POST /sessions/:pairingToken/pair` → BE 상태 PAIRED → Socket.io 알림 |
| **엔진 등록** | Python on-demand spawn 후 `/engine/register`로 pyngrok URL 등록 → engineRegistryService 갱신 |
| **AI 분석** | BE 02-processes/engine → HTTP 프록시 → Python engine → 결과 MongoDB 저장 |

## 측정 종료 판정 (SESSION-W008)

엔진은 측정을 끝낼 때 CSV를 `POST /api/engine/csv-upload`로 올린다. 백엔드는 이 업로드를 측정 종료 통지로도 쓴다.

- 세션이 MEASURING이고 이 백엔드가 그 subject 측정을 진행 중일 때만 COMPLETED로 바꾼다. DUAL_2PC는 엔진 레지스트리 등록으로, 1인 경로는 구독자 레지스트리로 확인한다. 그 밖의 업로드는 CSV만 저장한다.
- 측정 시작(`measuredAt`)부터 업로드까지가 `MEASUREMENT_EXPECTED_SECONDS - 15`초 이상이면 `stopReason=Natural`, 짧으면 `ProcessError`로 기록한다. 엔진은 오류 종료에도 CSV를 올리기 때문이다.
- 운영자 수동 중지와 측정 시작 실패 정리가 진행 중인 subject의 업로드는 CSV만 저장한다.

| 환경 변수 | 기본값 | 뜻 |
|---|---|---|
| `MEASUREMENT_EXPECTED_SECONDS` | `600` | 엔진 한 회 측정의 기대 시간(초). 엔진 `EXPERIMENT_DURATION_MINUTES`(기본 10분)와 맞춘다. 양수가 아니면 경고를 남기고 기본값을 쓴다. |

운영 주의와 한계:

- 엔진의 `EXPERIMENT_DURATION_MINUTES`를 바꾸면 백엔드의 `MEASUREMENT_EXPECTED_SECONDS`도 같은 시간(분 × 60)으로 함께 바꾼다. 엔진만 줄이면 정상 종료가 `ProcessError`로 기록되고, 엔진만 늘리면 오류 종료가 `Natural`로 기록될 수 있다.
- 백엔드가 측정 중에 재시작되면 엔진 레지스트리와 구독자 레지스트리가 메모리에서 비어, 그 측정의 업로드는 CSV만 저장되고 세션은 MEASURING으로 남는다. 이때는 운영자가 `실험 중지`로 끝내야 한다.
- 엔진 시크릿은 모든 엔진이 공유한다. 시크릿을 가진 쪽은 파일 이름(`subject_{n}_{groupId}_*.csv`)만으로 이 백엔드에서 현재 측정 중인 그룹의 subject를 끝낼 수 있다. 엔진별 자격 증명은 이번 범위(SESSION-W008) 밖이다.

## 2PC 확장 경계 (ADR-004)

현재는 1PC(단일 로컬 PC) 구성임. 아래 제약을 지키면 2PC(원격 PC 엔진) 확장이
추가 코드 없이 가능함:

- 엔진 접근은 반드시 `DATA_ENGINE_URL` env(fallback) + `engineRegistryService` 경유
- Redis 채널 키에 PC/host 정보 포함 금지
- 서버측 ingest timestamp가 단일 진실

## What this diagram is NOT

- C4 Level 2 Container Diagram이 아님 (`containers.md`에서 별도 기술)
- 데이터 흐름도(DFD)가 아님 — 프로세스 간 데이터 이동은 `DFD.md`에서 기술
- 프레임워크 이름(Express, Mongoose 등)은 Level 2 이하에서 기술함
