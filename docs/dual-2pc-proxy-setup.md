# dual-2pc-proxy 운영자 PC 셋업 가이드

이 문서는 Phase 18 engine-proxy-sync 의 DUAL_2PC + Proxy 시스템을 운영자 PC 에서
재현하기 위한 단계별 설정 가이드다. DISCUSS LOCK 에서 확정된 RULE-1 ~ RULE-7 체크리스트와
IP 고정 절차, 포트 점유 확인, 3 레포 환경변수 표, SECRET rotation 절차를 모두 포함한다.

---

## RULE-1 ~ RULE-7 체크리스트

아래 7개 규칙은 DISCUSS LOCK 원문을 그대로 박제한 것이다. 각 항목에 "왜 필요한가" 를 함께 명시한다.

**RULE-1 — wired Ethernet**

노트북 B 에서 운영자 PC 로만 유선 연결을 사용한다. DE_A 와 Proxy 는 loopback 이므로 네트워크 jitter 가 0 이다.

왜 필요한가: 유선 연결은 WiFi 대비 패킷 지연 편차(jitter)를 수 ms 에서 수십 마이크로초 수준으로 낮춘다.
timestamp-aligner 의 200ms ns window 기준 매칭(ADR §A)이 jitter 영향을 최소화하려면 LAN 유선이 필요하다.

**RULE-2 — dedicated LAN segment**

운영자 PC 와 노트북 B 간에 1개 유선 link 만 사용한다(스위치 또는 직접 LAN 케이블).

왜 필요한가: 다른 디바이스가 같은 스위치를 공유하면 broadcast 트래픽이 늘어 지연이 불규칙해진다.
1:1 혹은 단순 스위치 구성이 실험 재현성을 보장한다.

**RULE-3 — fixed IP + KnownPeers 박제**

노트북 B 의 IP 를 고정한다(discovery jitter 회피). DE 의 `.env.local` 에서
`PROXY_URL=http://operator-pc-ip:5050` 이 이 고정 IP 를 가리켜야 한다.

왜 필요한가: DHCP 환경에서는 재기동 시마다 IP 가 바뀔 수 있다. DE 가 proxy 에 등록할 때
`PROXY_URL` 이 잘못된 IP 를 가리키면 등록이 즉시 실패하고 실험을 시작할 수 없다.

**RULE-4 — WiFi 5-GHz 사용 시 Bluetooth 간섭 회피**

대안 환경으로 WiFi 를 사용해야 한다면 5-GHz 대역을 선택하고 Bluetooth 를 끄거나 최소화한다.

왜 필요한가: Cortex SDK 는 Emotiv 헤드셋과 Bluetooth 로 연결한다. 2.4-GHz WiFi 와 Bluetooth 가
동일 대역에서 충돌하면 EEG 스트림이 끊기거나 지연된다. 5-GHz 는 이 충돌을 줄인다.

**RULE-5 — effective_srate 0.01% 이하 편차 모니터**

Mongo schema 에 `effective_srate` 필드를 의무로 저장하고 0.01% 초과 편차 발생 시 alert 를 발송한다.

왜 필요한가: EEG 샘플링 레이트가 흔들리면 timestamp 정렬과 주파수 분석 모두 오염된다.
0.01% 기준은 128 Hz 기준 약 0.013 Hz 편차로, 분석 결과 재현성을 보장하기 위한 최소 기준이다.

**RULE-6 — chunk size 5에서 30ms sweet spot, 100ms 초과 금지**

DE 에서 Proxy 로 전송하는 EEG chunk size 는 5ms 에서 30ms 사이를 sweet spot 으로 유지하고
100ms 를 초과하지 않는다(LSL 권고 기준).

왜 필요한가: chunk size 가 너무 작으면 소켓 오버헤드가 증가하고, 100ms 를 초과하면 LSL 버퍼가
쌓여 실시간 정렬 실패 확률이 높아진다. 5 ~ 30ms 는 LSL 권고 범위이며 실기기 테스트에서도
jitter 없이 안정적으로 확인된 구간이다.

**RULE-7 — stimulus broadcast LAN-internal fan-out**

Proxy 가 DE_A(loopback) 와 DE_B(유선 LAN) 에 동시 송신하여 네트워크 jitter 를 최소화한다.

왜 필요한가: 두 DE 에 자극 신호가 시간 차로 도달하면 timestamp 정렬 기준이 흔들린다.
Proxy 단에서 fan-out 하면 OS 네트워크 스택이 두 패킷을 거의 동시에 발송하므로 jitter 가 최소화된다.

---

## IP 고정 및 wired Ethernet 설정 절차

### 운영자 PC (Windows 기준)

1. 설정 앱에서 "네트워크 및 인터넷" 을 연다.
2. 사용 중인 이더넷 어댑터를 선택하고 "IP 할당" 에서 "수동" 으로 변경한다.
3. IPv4 주소를 고정값으로 입력한다. 예시: `192.168.100.1`
4. 서브넷 마스크: `255.255.255.0`
5. 게이트웨이: 공유기가 없는 직접 연결이라면 비워 두거나 동일 대역 IP 를 입력한다.
6. 적용 후 이더넷 케이블을 노트북 B 에 연결한다.
7. 명령 프롬프트에서 `ipconfig` 를 실행하여 고정 IP 가 적용됐는지 확인한다.

### 노트북 B (Windows 기준)

1. 설정 앱에서 "네트워크 및 인터넷" 을 연다.
2. 이더넷 어댑터를 선택하고 "IP 할당" 에서 "수동" 으로 변경한다.
3. IPv4 주소: `192.168.100.2` (운영자 PC 와 같은 서브넷, 다른 호스트 번호)
4. 서브넷 마스크: `255.255.255.0`
5. 적용 후 `ping 192.168.100.1` 로 운영자 PC 와 통신 가능한지 확인한다.
6. DE 의 `.env.local` 에서 `PROXY_URL=http://192.168.100.1:5050` 으로 설정한다.

---

## 포트 점유 확인 (운영자 PC)

Proxy 는 port 5050 을 사용한다(`PROXY_PORT=5050`). Proxy 기동 전 아래 명령으로 점유 여부를 확인한다.

```
netstat -ano | findstr :5050
```

출력이 없으면 5050 이 사용 가능한 상태다. 출력이 있으면 해당 PID 를 종료한 뒤 Proxy 를 기동한다.

`start-e2e-dual-2pc.bat` 은 비-git 루트 파일이며 포트 점유 확인 루프(`for %%P in (...)`)를 포함한다.
이 bat 파일의 포트 목록에 `5050` 이 반드시 포함되어야 한다. 해당 bat 파일은 본 문서 범위 밖이나
5050 누락 시 Proxy 기동 충돌이 감지되지 않으므로 포함 여부를 운영 전 확인할 것.

---

## 3 레포 환경변수 표

| 항목 | BE `.env` | DE `.env.local` | Proxy `.env` |
|---|---|---|---|
| ALIGNMENT_LOCATION | `be` (Stage1 default, Heroku 동일) | `proxy` (Stage1 포함 항상 proxy forward) | 해당 없음 |
| PROXY_URL | 비워 둠 (Stage1 비활성, Stage2 에서 설정) | `http://operator-pc-ip:5050` (RULE-3 고정 IP) | 해당 없음 |
| BACKEND_URL | 해당 없음 | 기존 값 유지 | `https://mind-signal-backend-74ab2db9e087.herokuapp.com` |
| ENGINE_SECRET_KEY | 해당 없음 | 기존 값 유지 | BE/DE 와 동일 값 (D14 — 3-way 동기화) |
| PROXY_HEALTH_POLL_INTERVAL_MS | `1000` | 해당 없음 | 해당 없음 |
| PROXY_HEALTH_FAIL_COUNT | `3` | 해당 없음 | 해당 없음 |
| MAX_PROXY_POST_RETRIES | 해당 없음 | `2` | 해당 없음 |
| PROXY_PORT | 해당 없음 | 해당 없음 | `5050` |
| FAIL_CLOSED_THRESHOLD_MS | 해당 없음 | 해당 없음 | `3000` |
| HEARTBEAT_INTERVAL_MS | 해당 없음 | 해당 없음 | `1000` (startup assertion: FAIL_CLOSED_THRESHOLD_MS 가 반드시 크다) |
| PAIR_BUFFER_SIZE | 해당 없음 | 해당 없음 | `1024` |
| PAIRED_WINDOW_MS | 해당 없음 | 해당 없음 | `100` |
| BE_FORWARD_QUEUE_MAX | 해당 없음 | 해당 없음 | `512` |
| PENDING_REGISTRY_TTL_MS | 해당 없음 | 해당 없음 | `600000` |

참고: Stage2 escalation 시에만 BE 의 `PROXY_URL` 을 Proxy 주소로 설정한다.
Stage1 golden path 에서는 BE 의 `ALIGNMENT_LOCATION=be` 로 Proxy 를 거치지 않는다.

---

## SECRET rotation 절차 (R10 — ENGINE_SECRET_KEY 3-way 동기화)

ENGINE_SECRET_KEY 는 BE(Heroku Config Vars) / DE `.env.local` / Proxy `.env` 세 곳에서
반드시 동일 값을 가져야 한다. 불일치 시 DE 와 Proxy 간 handshake 또는 Proxy 와 BE 간
handshake 가 즉시 실패한다.

### rotation 순서

1. 새 secret 값을 안전한 방법으로 생성한다(예: `openssl rand -hex 32`).
2. Proxy `.env` 를 먼저 업데이트한 뒤 Proxy 를 재시작한다. Proxy 가 먼저 새 값을 받아야
   DE 와 BE 의 handshake 실패 시간을 최소화한다.
3. DE `.env.local` 을 업데이트한 뒤 DE 를 재시작한다.
4. Heroku Config Vars 에서 `ENGINE_SECRET_KEY` 를 업데이트한다.
   운영자가 직접 `heroku config:set ENGINE_SECRET_KEY=<new-value> --app mind-signal-backend-74ab2db9e087` 를 실행한다.
   (자동화 차단 대상: `heroku config:get` 은 prod 값 읽기이므로 운영자가 직접 실행)
5. Heroku 가 자동 재시작되면 `/health` 엔드포인트를 확인하여 BE 가 정상 기동됐는지 검증한다.
6. DE 에서 로그를 확인하여 Proxy 등록이 성공했는지 확인한다.

### 검증

세 컴포넌트가 모두 재시작된 뒤 아래를 확인한다.

- DE 기동 로그: `proxy registration attempt` 실패 없이 정상 완료
- Proxy 로그: BE 와 heartbeat 정상 교환
- BE 로그: Proxy 로부터 오는 sample 인그레스에서 `invalid_signature` 없음

불일치가 의심될 때는 각 컴포넌트를 재시작하여 handshake 로그를 비교한다.
자동화 스크립트로 secret 일치 여부를 검증하는 것은 prod 값 읽기가 차단되므로 운영자가 직접 확인한다.
