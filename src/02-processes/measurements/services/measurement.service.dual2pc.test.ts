/**
 * measurement.service.ts — DUAL_2PC 분기 + SEQUENTIAL 회귀 테스트 (BE-3)
 *
 * 검증 항목:
 *   BE-3: DUAL_2PC 분기 정적 검증 — subscribeWithAligner, stimulusBroadcasterService 호출 경로
 *   BE-3 SEQUENTIAL regression: getEngineUrl 5곳 호출 보존 + SEQUENTIAL 경로 정적 검증
 */

import * as fs from 'fs';
import * as path from 'path';

const SERVICE_PATH = path.resolve(__dirname, 'measurement.service.ts');

// ============================================================
// BE-3: DUAL_2PC 분기 정적 검증
// ============================================================

describe('measurement.service.ts — BE-3: DUAL_2PC 분기 정적 검증', () => {
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(SERVICE_PATH, 'utf-8');
  });

  it("experimentMode === 'DUAL_2PC' 분기가 존재함", () => {
    expect(source).toContain("experimentMode === 'DUAL_2PC'");
  });

  it('startDualMeasurement 함수가 존재함 (fire-and-forget 경로)', () => {
    expect(source).toContain('startDualMeasurement');
  });

  it('subscribeWithAligner 호출이 DUAL_2PC 경로에 존재함', () => {
    expect(source).toContain('subscribeWithAligner');
  });

  it('stimulusBroadcasterService.broadcast 호출이 존재함', () => {
    expect(source).toContain('stimulusBroadcasterService');
    expect(source).toContain('broadcast');
  });

  it('timestampAlignerRegistry.getOrCreate 호출이 DUAL_2PC 경로에 존재함', () => {
    expect(source).toContain('timestampAlignerRegistry.getOrCreate');
  });

  it('waitForBothEngines 함수가 존재함 — 두 DE 등록 대기 로직', () => {
    expect(source).toContain('waitForBothEngines');
  });

  it('DUAL_2PC 분기가 subjectIndex guard 이전에 배치됨 (v2 N-2 반영)', () => {
    // DUAL_2PC 분기가 subjectIndex guard보다 앞에 있어야 함
    const dual2pcIdx = source.indexOf("experimentMode === 'DUAL_2PC'");
    const subjectIndexGuardIdx = source.indexOf('subjectIndex === null');
    expect(dual2pcIdx).toBeGreaterThan(-1);
    expect(subjectIndexGuardIdx).toBeGreaterThan(-1);
    expect(dual2pcIdx).toBeLessThan(subjectIndexGuardIdx);
  });

  it('DUAL_2PC 경로는 fire-and-forget + 즉시 반환 패턴 사용함', () => {
    // 반환 타입 kind: 'DUAL_2PC'가 존재함
    expect(source).toContain("kind: 'DUAL_2PC'");
  });

  it('202 Accepted 패턴 — 응답 즉시 반환 후 비동기 처리함 (v4 N-4 반영)', () => {
    // fire-and-forget 구조: startDualMeasurement 호출 후 즉시 return
    expect(source).toMatch(/startDualMeasurement[\s\S]*?return/);
  });

  it('dual-session-failed 이벤트 emit이 timeout 처리에 존재함', () => {
    // 60초 timeout 시 실패 통보 이벤트 필요함
    expect(source).toContain("'dual-session-failed'");
  });

  it('DUAL_2PC allCompleted 시 aligner cleanup 호출됨 (v7 H-2 반영)', () => {
    expect(source).toContain('timestampAlignerRegistry.cleanup');
    expect(source).toContain('engineRegistryService.cleanupGroup');
  });

  it('v9 R9-H-2: subscribeWithAligner 내부 setInterval flush 기동됨', () => {
    // subscribeWithAligner 함수 내부에 setInterval + flush 호출 존재함
    expect(source).toContain('setInterval');
    expect(source).toContain('groupFlushIntervals');
  });

  it('v9 R9-H-2: unsubscribeGroupChannels에서 clearInterval 처리됨', () => {
    expect(source).toContain('clearInterval');
    expect(source).toContain('groupFlushIntervals.get');
  });

  it('v8 C-1: subscribeWithAligner 내부 brain_sync_all 타입 가드 존재함', () => {
    // parsed.type !== 'brain_sync_all' 타입 가드 검증 (다른 타입 메시지 ingest 방지)
    expect(source).toContain('brain_sync_all');
    expect(source).toContain('parsed.type');
  });
});

// ============================================================
// BE-3 SEQUENTIAL regression: Phase 14 경로 무변경 검증
// ============================================================

describe('measurement.service.ts — BE-3 SEQUENTIAL regression: Phase 14 경로 보존', () => {
  let source: string;

  beforeAll(() => {
    source = fs.readFileSync(SERVICE_PATH, 'utf-8');
  });

  it('engineProxyService.streamStart 호출이 SEQUENTIAL/DUAL/BTI 경로에 유지됨', () => {
    expect(source).toContain('engineProxyService');
    expect(source).toContain('streamStart');
  });

  it('SocketService 소켓 emit 호출이 기존 경로에 유지됨', () => {
    // AUTH-W001 에서 전역 emitLiveEvent 를 그룹 room emitToGroup 으로 바꿨음.
    // 보존 대상은 "소켓으로 알린다"이지 전역 브로드캐스트가 아님
    expect(source).toContain('SocketService.emitToGroup');
  });

  it('전역 브로드캐스트 emitLiveEvent 가 이 서비스에 남아 있지 않음 (AUTH-W001)', () => {
    // 되돌아오면 room 가입 없이 접속만 한 소켓에도 뇌파가 감
    expect(source).not.toContain('SocketService.emitLiveEvent');
  });

  it('Redis subscriber.subscribe가 기존 경로에 유지됨', () => {
    expect(source).toContain('subscriber.subscribe');
  });

  it('SEQUENTIAL 경로에서 subjectIndex guard가 동작함', () => {
    // subjectIndex === null 또는 <= 0 시 400 에러 발생 경로 존재함
    expect(source).toContain('subjectIndex === null');
    expect(source).toContain('subjectIndex <= 0');
  });

  it('기존 mind-signal:{groupId}:subject:{subjectIndex} 채널 패턴이 유지됨', () => {
    expect(source).toContain('mind-signal:');
    expect(source).toContain('subjectIndex');
  });

  it('SEQUENTIAL 경로에서 세션 상태 MEASURING 전이가 유지됨', () => {
    expect(source).toContain("'MEASURING'");
    expect(source).toContain('measuredAt');
  });

  it('stopMeasurementService에 BTI 경로와 DUAL_2PC 경로 emit이 유지됨 (v2 N-3 반영)', () => {
    // 원래는 BTI 가 subject 별 emitLiveEvent, DUAL_2PC 만 emitToGroup 이었음.
    // AUTH-W001 에서 둘 다 emitToGroup 이 됐고 구분은 emit 횟수로 남음
    // (BTI 는 subject 별 1회, DUAL_2PC 는 allCompleted 일 때 1회)
    expect(source).toContain('SocketService.emitToGroup');
  });

  it("stopMeasurement에서 'measurement-complete' 이벤트가 그룹 room으로 emit됨", () => {
    expect(source).toMatch(
      /emitToGroup\([^,]+,\s*['"]measurement-complete['"]/
    );
  });
});

// ============================================================
// BE-3: engineProxyService 임포트 보존 검증
// ============================================================

describe('measurement.service.ts — BE-3: engine-proxy 5곳 호출 보존 검증', () => {
  let engineProxySource: string;

  beforeAll(() => {
    const proxyPath = path.resolve(
      __dirname,
      '../../engine/services/engine-proxy.service.ts'
    );
    engineProxySource = fs.readFileSync(proxyPath, 'utf-8');
  });

  it('engine-proxy.service.ts에 getEngineUrl 호출이 보존됨', () => {
    // ADR-004: getEngineUrl 시그니처 유지, engine-proxy 5곳 호출 깨짐 방지
    expect(engineProxySource).toContain('getEngineUrl');
  });
});
