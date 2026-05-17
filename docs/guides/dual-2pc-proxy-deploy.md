# dual-2pc-proxy 3-way 브랜치 전략과 Heroku 재배포 가이드

이 문서는 Phase 18 engine-proxy-sync 의 3 레포 브랜치 전략, 머지 타이밍 결정, Heroku BE 재배포
절차, 롤백 경로를 운영자 관점에서 정리한 것이다.

---

## 3-way 브랜치 전략 현황

| 레포 | 브랜치 | base | HEAD | 상태 |
|---|---|---|---|---|
| `mind-signal-backend` | `feat/18-engine-proxy-sync` | dev `9d4c20e` | `e57f716` | 미push, dev-only |
| `mind-signal-data-engine` | `feat/18-engine-proxy-sync` | dev `d33ba0f` | `e2942d0` | 미push, dev-only |
| `mind-signal-proxy` | `main` | genesis (신규 repo) | Wave 1-3 커밋들 | 미push, dev-only |

세 레포 모두 현재 미push 상태다. push 및 PR 은 Wave 1-3 전체와 verify(S4) 완료 후
별도 handoff 워크플로우에서 진행한다. 지금 push 하지 않는다.

---

## 머지 hold 정책 (R6)

본 Phase 18 는 5/26 교수 면담 직전 회귀 리스크가 Critical 로 평가됐다. 따라서:

- 면담 후 머지 권고: 면담 전에는 세 레포 모두 dev-only 브랜치를 유지한다.
- prod Heroku v66 `3769cde0` 미접촉: 현재 prod 는 Phase 18 변경사항 없이 동작 중이며
  Stage1 golden path(ALIGNMENT_LOCATION=be) 로만 서빙 중이다.
- Stage1 에서 prod 영향 없음: dev-only 브랜치이므로 prod Heroku 앱에 아무런 영향을 주지 않는다.

---

## Heroku BE 재배포 절차

BE 앱 URL: `https://mind-signal-backend-74ab2db9e087.herokuapp.com`

### Stage1 재배포 (ALIGNMENT_LOCATION=be, golden path)

Stage1 설정에서 BE 는 직접 alignment 를 수행한다. Proxy 를 거치지 않는다.

Heroku Config Vars 에서 설정해야 할 값:
- `ALIGNMENT_LOCATION` 을 `be` 로 설정한다(Stage1 golden path, Heroku 동일).
- `PROXY_URL` 은 비워 둔다(Stage1 에서 Proxy 비활성).
- `PROXY_HEALTH_POLL_INTERVAL_MS` = `1000`
- `PROXY_HEALTH_FAIL_COUNT` = `3`

Config Vars 갱신은 운영자가 직접 `heroku config:set` 으로 실행한다.
(`heroku config:get` 은 prod 값 읽기로 자동화 차단 대상이므로 운영자 직접 실행)

재배포 후 검증 단계:
1. `heroku releases --app mind-signal-backend-74ab2db9e087` 로 새 release 가 등록됐는지 확인한다.
2. `https://mind-signal-backend-74ab2db9e087.herokuapp.com/health` 에 GET 요청을 보내
   200 OK 와 정상 응답을 확인한다.
3. BE 로그(`heroku logs --tail`)에서 startup 에러가 없는지 확인한다.

### Stage2 escalation (ALIGNMENT_LOCATION=proxy 로 전환)

Proxy/LAN 환경이 준비된 뒤 BE 를 Proxy 경유 모드로 전환하는 경우에만 적용한다.

추가로 설정할 값:
- `PROXY_URL` 을 Proxy 서버 주소(예: `http://operator-pc-ip:5050`)로 설정한다.
- `ALIGNMENT_LOCATION` 을 `proxy` 로 변경한다.

Stage2 전환 전에는 반드시 Proxy 가 먼저 기동되고 BE 와 heartbeat 교환이 정상임을 확인해야 한다.
순서를 지키지 않으면 BE 가 Proxy health 실패로 fail-closed 모드에 진입한다.

---

## 롤백

prod 에 영향이 발생했을 때 1순위 복구 수단은 앱 롤백이다.

```
heroku rollback --app mind-signal-backend-74ab2db9e087
```

특정 release 로 롤백이 필요하면:
```
heroku rollback vN --app mind-signal-backend-74ab2db9e087
```

현재 dev-only 브랜치이므로 Stage1 golden path 에서는 prod 무영향이다. 롤백 시나리오는
Stage2 escalation 이후 prod 재배포를 진행한 경우에만 해당한다.

---

## Wave 1-3 전체 완료 후 push/PR 진행 절차 (참고)

Wave 1-3 + verify(S4) 완료 후 별도 handoff 에서 아래 순서로 진행한다.

1. 세 레포에서 `git push origin feat/18-engine-proxy-sync` 를 각각 실행한다.
   (mind-signal-proxy 는 `git push origin main`)
2. BE 와 DE 에서 `feat/18-engine-proxy-sync` to `dev` PR 을 각각 생성한다.
3. CI green 확인 후 merge commit(`--no-ff`) 으로 머지한다.
4. 머지 후 `dev` to `main` PR 을 거쳐 prod 재배포를 진행한다.

지금 이 절차를 실행하지 않는다. 이 항목은 handoff 입력 자료다.
