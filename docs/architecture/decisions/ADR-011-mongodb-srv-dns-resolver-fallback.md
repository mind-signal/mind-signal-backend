# ADR-011: MongoDB Atlas SRV DNS resolver fallback policy

---

- **Status**: Accepted
- **Date**: 2026-05-26
- **Applies to**: BE
- **Deciders**: @KWONSEOK02
- **Related**: ADR-010 (Stage 1 alignment authority + proxy ingress ns), Phase 18.1 D-0 시연 함정 4 박제 (옵시디언 [[2026-05-26-phase-18.1-d-0-hotspot-pivot-postponed]])

## Context

2026-05-26 Phase 18.1 D-0 시연 setup 진행 도중 BE 기동 시 MongoDB Atlas SRV 조회가 다음 시퀀스로 실패함.

1. `querySrv ECONNREFUSED _mongodb._tcp.todo-dev-cluster.1eldpej.mongodb.net`
2. Wi-Fi 어댑터 DNS를 8.8.8.8/8.8.4.4로 변경 + `ipconfig /flushdns` 실행
3. `Resolve-DnsName -Type SRV` 시스템 기본 DNS 응답 정상, `nslookup -type=SRV ... 8.8.8.8` 명시 응답 정상
4. BE 재기동 결과 여전히 ECONNREFUSED

근본 원인은 Node DNS API의 두 경로 분기임. `dns.lookup()`은 OS facility (getaddrinfo) 계열이고, `dns.resolveSrv()`와 `dns.resolveTxt()`는 DNS protocol 질의를 직접 수행함. MongoDB Node driver는 `mongodb+srv` 파싱 시 내부에서 `dns.promises.resolveSrv()`와 `resolveTxt()`를 호출함. 즉 `nslookup` 또는 `Resolve-DnsName`이 정상이어도 driver의 SRV path가 다른 resolver 상태를 타면 실패함. 이 구조는 Windows 특정 문제 아니고 Node 공통임.

5/26 D-0 임시 patch로 `src/01-app/app.ts` L1-L3에 `import dns from 'dns'` + `dns.setServers(['8.8.8.8','8.8.4.4'])` 2줄을 unconditional로 박았으나, codex 5.5 자문(thread `019e64ac`)에서 production 환경 (사내 DNS 또는 split-horizon DNS 또는 audit 정책 또는 8.8.8.8 outbound 차단망)에서 BE 기동 실패 risk 발견됨. 따라서 unconditional patch는 부적절하며 conditional override가 필요함.

본 ADR은 5/26 D-0 함정 영구 해소 + production 안전성 + Atlas best practice (SRV 권장) 정합 트레이드오프를 박제함.

## Decision

`config.mongoSrvDnsServers`를 신설하고 환경변수 `MONGODB_SRV_DNS_SERVERS` (콤마 구분 IP 리스트)로 제어함. 본 env가 비어 있으면 OS 기본 DNS 경로를 유지하고, 값이 있으면 `mongoose.connect` 직전에 `dns.setServers(...)`를 호출함. production default off 정합으로 사내 DNS 정책 우회 risk를 제거함.

구현 위치:

- `src/07-shared/config/config.ts` — `mongoSrvDnsServers: string[] | undefined` 신설, env 파싱 + trim + 빈 항목 제외함
- `src/01-app/app.ts` `connectDB()` — `mongoose.connect()` 직전에 conditional `dns.setServers` 호출 + 로그 박제함
- `.env.example` — Database 섹션 직후 신규 키 + 주석 박제함

## Alternatives considered

### Option A: unconditional `dns.setServers(['8.8.8.8','8.8.4.4'])` 영구 박제

`src/01-app/app.ts` L1-L3에 박힌 5/26 D-0 임시 patch를 그대로 유지함.

**Trade-offs**: 5/26 D-0 setup 함정 4 즉시 해소함. dev 재현성 강함.

**Rejected because**: production 환경에서 사내 DNS 또는 Private DNS 또는 split-horizon DNS 또는 audit 정책 우회 risk 발생함. 회사 또는 학교 또는 병원 또는 공공망에서 8.8.8.8 outbound 차단 시 오히려 BE 기동 실패 원인이 됨. Codex 5.5 자문 thread `019e64ac` 권장 거부 사유 정합.

### Option B-3: MongoDB Atlas standard URI 전환

`mongodb+srv://...` 대신 `mongodb://host1,host2,host3/...`로 변경하여 SRV resolver path 자체 우회함.

**Trade-offs**: DNS resolver 분기 함정 자체 차단함. Google DNS 차단망 시나리오도 무관해짐.

**Rejected because**: Atlas best practice (SRV 권장) 위반함. Atlas cluster topology 변경 (replicaSet rotation, version 업그레이드, hostname 갱신) 시 URI 재배포 의무로 operational burden 큼. SRV는 seed list host를 자동 포함하고 server rotation을 client 재설정 없이 지원하므로 가능하면 SRV를 쓰라는 MongoDB 공식 권장과 충돌함.

### Option C: conditional patch (env flag로 활성화) — **채택**

위 Decision 절 정합.

**Trade-offs**: env flag 1개 추가, 운영자 setup 가이드 1줄 복잡화함 (.env.example 주석 박제로 완화). production default off로 사내 DNS 정책 정합함. dev 환경에서만 활성화하여 5/26 D-0 함정 즉시 해소함. Atlas SRV best practice 유지함.

**Accepted because**: A의 production risk 회피 + B-3의 operational burden 회피 + dev 시점 함정 해소를 모두 충족하는 sweet spot임. Codex 5.5 자문 thread `019e64ac` 권장 정합.

## Consequences

### Positive

- 5/26 D-0 시연 함정 4 (BE Node c-ares가 OS DNS 미적용) 영구 해소함. 운영자가 `.env.local`에 `MONGODB_SRV_DNS_SERVERS=8.8.8.8,1.1.1.1` 박제 시 자동 적용함.
- production 환경 default off로 사내 DNS 정책 정합 유지함. 회사 또는 학교 또는 병원 또는 공공망에서 8.8.8.8 outbound 차단 시 BE 기동 정상 (OS 기본 DNS 사용함).
- ADR-011로 미래 재논쟁 방지함. 같은 함정이 재발 시 본 ADR이 단일 진실원임.
- Atlas SRV best practice 유지함. cluster topology 변경 시 운영자 부담 0건.

### Negative

- env flag 1개 추가로 .env.example 변경 + 운영자 setup 가이드 1줄 복잡화함 (주석 박제로 완화함).
- production 환경에서 env flag를 잘못 활성화 시 (8.8.8.8 차단망) BE 기동 실패 가능. default off + .env.example 주석 경고 박제로 완화함.
- Google DNS 차단망 cascade 함정 발생 시 (예: 사내 DNS만 허용 + 8.8.8.8 차단) 본 ADR로 해결 안 됨. 별도 fallback runbook (B-3 standard URI 사용 + ADR-XXX-superseding-fallback 신설) 박제 의무 미래 트리거임.

## Implementation Notes

회귀 시뮬레이션 ABC (PR description 박제 정합):

- A 정상: `MONGODB_SRV_DNS_SERVERS=` 비어 있음 + SRV 정상망 → OS 기본 DNS 사용 + 기존 SRV 연결 성공함.
- B 5/26 D-0 fix 경로: `MONGODB_SRV_DNS_SERVERS=8.8.8.8,1.1.1.1` 활성화 + 함정 재현망 → `dns.getServers()`가 지정 resolver로 바뀌고 mongoose.connect 성공함.
- C 무력화 시뮬레이션: `src/01-app/app.ts` `connectDB()` 안의 `if (config.mongoSrvDnsServers...)` 분기 1줄을 false로 강제 (예: `if (false)`) → 5/26 D-0 함정 재현 가능 박제 (regression detection 검증).

5/26 D-0 임시 patch (`src/01-app/app.ts` L1-L3 unconditional `dns.setServers`)는 본 ADR 채택 시 revert 의무. 본 PR (`fix/database-srv-dns-fallback`)이 dev 머지 시 자동 적용됨.

## References

- Codex 5.5 자문 thread `019e64ac` (model: gpt-5.5, sandbox: read-only, 2026-05-26) — 본 결정의 1차 근거
- Node DNS 공식 문서: https://nodejs.org/api/dns.html — `dns.lookup` vs `dns.resolve*` 구현 차이 + `setServers()` 영향 범위
- MongoDB 공식 문서: https://www.mongodb.com/docs/manual/reference/connection-string/ — SRV vs standard URI 비교 + "가능하면 SRV 사용" 권장
- 옵시디언 [[2026-05-26-phase-18.1-d-0-hotspot-pivot-postponed]] 핵심 발견 4 — 함정 진단 과정
- 옵시디언 [[2026-05-26-hotspot-pivot-next-session-handoff]] 트랙 2 — 본 ADR 트리거
- `scripts/migrate-2026-05-16-pr-a8-subject-index.ts` L110 선례 — 일회성 마이그레이션 public DNS pin (본 ADR scope 외, 별도 정책)
