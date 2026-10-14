# 5분씩 두 번 측정하고 노트북 A에 CSV 4개 모으기

2026-09-03, SESSION-W007. 분석은 클라이언트가 수행한다.
기존 CSV 전송 경로를 사용하며 새 API나 화면을 추가하지 않는다.

## 준비

- A와 B의 DE `.env.local`: `EXPERIMENT_DURATION_MINUTES=5`.
- A는 `DUAL_2PC_SUBJECT_INDEX=1`, B는 2. 같은 참여자가 같은 역할을 유지한다.
- B의 `BACKEND_URL`은 **B에서 접근 가능한 A의 백엔드 주소**여야 한다.
  B에서 `localhost:5000`은 A를 가리키지 않는다.
- 양쪽 DE의 `ENGINE_SECRET_KEY`가 A BE의 설정과 일치해야 한다.
- 설정을 바꾼 뒤 측정 전에 DE를 재시작한다. 각 PC에서 `http://localhost:5002/health` 확인.
- A BE는 백엔드 저장소를 작업 디렉터리로 실행한다. 기본 수집 위치는 저장소 상위
  `csv/`이고 `CSV_STORAGE_DIR` override가 있으면 그 위치를 사용한다.

## 연결 기준: Tailscale (2026-09-03 2차 보완)

**이 프로젝트의 cross-machine 통신 기준은 Tailscale이다. 같은 Wi-Fi 연결이나 Wi-Fi LAN IP 고정을 요구하지 않는다.** 판정 기준은 "같은 Wi-Fi인가"가 아니라 "실제 사용하는 기기 사이의 Tailscale 연결과 필요한 포트 접근이 성공하는가"다.

- A의 실제 Tailscale IP(실측): `100.117.42.107`. MagicDNS 이름을 쓰면 그것도 가능하다. (`tailscale ip -4`로 확인함)
- 실제 측정에 사용하는 A/B의 Tailscale 연결과 필요한 포트 접근을 확인한다. 참여자 휴대폰은 요구하지 않는다.

**방향별 경로(코드로 확인, Tailscale 기준으로 검증):**
- **데이터 평면(EEG 샘플): proxy 경유.** B DE `PROXY_URL` → A proxy `http://100.117.42.107:5050`. B→A proxy(5050) 도달 필요.
- **제어 평면(측정 시작/종료): BE→DE 직접(proxy 미경유).** BE `streamStartDual`이 registry에 저장된 **B DE advertise URL**로 `POST /api/stream/start`를 직접 친다(engine-proxy.service.ts). 그 URL은 assign-group 때 B DE가 `register_to_backend_dual(public_url,...)`로 등록한 값이고, `public_url`은 `_resolve_advertise_ip`(app.py) 결과다. A BE→B DE(5002) 도달 필요.
- **CSV 업로드: B→A BE 직접.** B DE `BACKEND_URL` → `http://100.117.42.107:5000` `POST /api/engine/csv-upload`. B→A BE(5000) 도달 필요.

**advertise URL은 로그가 정본:** `_resolve_advertise_ip`는 명시 `LAN_IP`가 Tailscale 대역(100.64.0.0/10) **밖이면 무시**하고 Tailscale 자동탐지→socket 폴백으로 내려간다. 그래서 B `.env`의 LAN_IP 문자열이 아니라 **B 기동 로그의 실제 advertise URL**을 확인하고, A에서 `curl http://<B advertise>:5002/health`가 성공하는지로 판정한다. B의 `localhost:5002/health` 성공(B 자신)과 A→B advertise 접근 성공은 별개다.

## 운영자 모드와 강제 페어링

A의 기존 운영자 화면에서 관리자 강제 페어링을 사용한다. 참여자 휴대폰·QR 스캔은 요구하지 않는다.
A에서만 프론트를 열므로 기존 FE의 localhost API·Socket 설정을 유지한다.
기존 관리자 계정과 실제 준비된 참여자 계정을 사용하며 인증 우회나 DB 직접 수정은 하지 않는다.
## 회차별 진행

1. A 운영자 모드의 기존 UI에서 새 그룹을 생성한다. 관리자 강제 페어링으로 subject 1 사용자부터, 2 사용자를 다음에 연결한다.
   operator 합류와 기존 실험 시작 절차를 따른다. groupId와 참여자·PC 대응을 메모한다.
2. 양쪽 스트리머의 5분 자연 종료를 기다린다. FE 경과 시간이 5분이라는 사실만으로
   양쪽 종료를 판단하지 않는다. 로그의 자동 종료와 파일 닫힘을 확인한다.
3. B 로그의 `[csv-upload] ... 업로드 완료`와 A 폴더의 subject 2 수신 파일을 확인한다.
   A의 subject 1 파일도 확인한다. 종료는 업로드 실패 때도 진행되므로 로그만 믿지 않는다.
4. 양쪽 자연 종료 뒤 기존 `실험 중지` 버튼으로 BE 세션을 완료 처리한다.
   이 버튼은 `ManualEarly`를 기록하므로 실제 자연 종료 후 정리한 사실을 메모한다.
   분석 화면의 성공 여부는 CSV 확보 판정에 사용하지 않는다.
5. 헤드셋을 유지한 채 휴식하고 접촉 품질을 확인한다. 새 `/lab`에서 다른 groupId로
   같은 계정·순서로 다시 강제 페어링한다. 두 번째 5분 기록과 수신 확인을 반복한다.

## A에서 확인할 파일

| 회차 | A에서 기록 | B에서 받아야 할 파일 |
|---|---|---|
| 1, groupId G1 | subject_1_G1_날짜_시각.csv | subject_2_G1_날짜_시각.csv |
| 2, groupId G2 | subject_1_G2_날짜_시각.csv | subject_2_G2_날짜_시각.csv |

G1/G2와 날짜/시각은 설명용 표기다. 실제 파일은 기존 이름을 그대로 둔다.
파일마다 데이터 행 수와 처음/마지막 timestamp를 확인한다. 5분 측정은 통상 약 300행이지만
누락 가능성이 있으므로 행 수가 300이라고 가정하지 않는다. 헤더만 있는 파일은 실패다.
B의 원본 두 개와 A의 같은 이름 사본에 `Get-FileHash -LiteralPath <파일경로> -Algorithm SHA256`
을 실행해 해시가 같은지 비교한다. 파일이 모두 닫힌 뒤 확인한다.

## B에서 자동 전송에 실패했을 때

먼저 B에 원본 CSV가 있는지 확인한다. 원본을 개명하거나 삭제하지 않는다.
네트워크·대상 주소·시크릿 설정을 바로잡은 뒤 B의 DE 저장소에서 기존 Python 환경으로
아래 명령을 실행한다. 파일을 대화형 입력으로 받아 기존 업로드 함수를 그대로 사용한다.
기존 백엔드 인증을 사용하며 시크릿을 출력하지 않는다.

```powershell
python -c "from server.config import settings; from server.services.webhook import upload_csv_to_backend; p = input('CSV absolute path: ').strip(); ok = upload_csv_to_backend(settings.backend_url, p, settings.engine_secret_key); raise SystemExit(0 if ok else 1)"
```

업로드 실패는 false를 반환하므로 exit 1이면 실패다. 성공 후에도 A 파일의 크기와
SHA256을 B 원본과 비교한다. 같은 이름 재업로드는 덮어쓰기다. 여러 번 측정한 파일 중
하나를 mtime만 보고 임의로 고르지 않는다.

## 전달과 종료 기준

두 groupId × 두 subject = 파일 네 개가 A에 있고, 각 파일의 측정 구간을 확인했으며
B 사본 두 개의 해시가 원본과 같으면 수집 완료다. 별도 메모에 회차/groupId와 참여자·PC
대응, 실제 시작·종료·휴식, 누락이나 재전송 여부를 남긴다. 인증정보는 넣지 않는다.
실제 외부 전달은 별도 사용자 지시 후 수행한다.

## 확인된 구현

- DE `core/streamer.py`의 `on_close`: CSV 닫기 후 업로드.
- DE `server/services/stream.py`의 `stop_stream`: 수동 종료 뒤 업로드 보완.
- DE `server/services/webhook.py`의 `upload_csv_to_backend`: 인증된 CSV POST, 실패는 false.
- BE `src/02-processes/engine/services/csv-upload.service.ts`: 인증·파일명 검증 후 저장.

이 문서는 코드 경로를 확인한 런북이다. B→A 실기기 전송 성공을 검증했다는 기록은 아니다.
