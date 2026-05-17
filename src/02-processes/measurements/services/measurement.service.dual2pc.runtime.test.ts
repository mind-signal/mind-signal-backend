/**
 * measurement.service.ts — DUAL_2PC startDualMeasurement 런타임 검증
 *
 * 검증 항목:
 *   - startDualMeasurement 실행 후 engineProxyService.streamStartDual이
 *     (groupId, 1), (groupId, 2) 각 1회씩 총 2회 호출됨
 *   - 한쪽 streamStartDual 실패 시 SocketService.emitToGroup이
 *     'dual-session-failed' 이벤트로 호출됨
 *
 * 주의: 기존 정적 테스트 파일(measurement.service.dual2pc.test.ts)은 수정하지 않음.
 * 이 파일은 런타임 mock assertion 보강 목적으로 별도 추가됨.
 */

const GROUP_ID = 'grp_runtime_test';
const ENGINE_SECRET = 'correct-engine-secret';

// ---------------------------------------------------------------------------
// config 모킹 — dataEngine.secretKey + dualPc timeout 고정
// ---------------------------------------------------------------------------
jest.mock('@07-shared/config/config', () => ({
  config: {
    env: 'test',
    port: 5000,
    mongoUri: 'mongodb://localhost:27017/test',
    jwtSecret: { secret: 'test-secret', expiresIn: '5m' },
    isProduction: false,
    redis: { url: 'redis://localhost:6379' },
    dataEngine: {
      path: '/tmp/engine',
      baseUrl: 'http://localhost:5002',
      pythonBin: 'python',
      secretKey: ENGINE_SECRET,
    },
    dualPc: {
      timestampToleranceMs: 200,
      // 짧은 timeout — 테스트 중 의도적 미등록 시나리오에서 빠르게 reject
      registrationTimeoutMs: 5000,
      // CX4-1: pairedWindowMs mock — 작은 값으로 flush interval 빠르게 발화
      pairedWindowMs: 50,
    },
  },
}));

// ---------------------------------------------------------------------------
// engineProxyService 모킹 — streamStartDual jest.fn()
// ---------------------------------------------------------------------------
jest.mock('@02-processes/engine/services/engine-proxy.service', () => ({
  engineProxyService: {
    streamStartDual: jest.fn().mockResolvedValue({ status: 'started' }),
    streamStart: jest.fn().mockResolvedValue({ status: 'started' }),
    analyzePipeline: jest.fn(),
    analyzeDual2pcPipeline: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// SocketService 모킹 — emitToGroup, emitLiveEvent jest.fn()
// ---------------------------------------------------------------------------
jest.mock('@07-shared/lib/socket', () => ({
  SocketService: {
    emitToGroup: jest.fn(),
    emitLiveEvent: jest.fn(),
    init: jest.fn(),
    getIO: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// redisService 모킹 — Redis 연결 없이 동작
// ---------------------------------------------------------------------------
jest.mock('@07-shared/lib/redis', () => ({
  redisService: {
    client: {
      duplicate: jest.fn().mockReturnValue({
        connect: jest.fn().mockResolvedValue(undefined),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
        quit: jest.fn().mockResolvedValue(undefined),
        isOpen: false,
      }),
      isOpen: false,
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockResolvedValue(undefined),
    },
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// stimulusBroadcasterService 모킹
// ---------------------------------------------------------------------------
jest.mock(
  '@02-processes/measurements/services/stimulus-broadcaster.service',
  () => ({
    stimulusBroadcasterService: {
      broadcast: jest.fn().mockResolvedValue(undefined),
    },
  })
);

// ---------------------------------------------------------------------------
// timestampAlignerRegistry 모킹
// ---------------------------------------------------------------------------
jest.mock(
  '@02-processes/measurements/services/timestamp-aligner.service',
  () => ({
    timestampAlignerRegistry: {
      getOrCreate: jest.fn(),
      ingest: jest.fn(),
      flush: jest.fn(),
      cleanup: jest.fn(),
    },
  })
);

// ---------------------------------------------------------------------------
// Session 모킹 — MongoDB 의존 제거
// ---------------------------------------------------------------------------
jest.mock('@06-entities/sessions', () => ({
  Session: {
    findById: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
  },
}));

// ---------------------------------------------------------------------------
// imports (mock 선언 후)
// ---------------------------------------------------------------------------
import { engineRegistryService } from '@02-processes/engine/services/engine-registry.service';
import { startMeasurementService } from './measurement.service';
import { SocketService } from '@07-shared/lib/socket';
import { Session } from '@06-entities/sessions';

/** DUAL_2PC 세션 도큐먼트 목 생성 헬퍼 */
function makeDualSession(groupId: string) {
  return {
    _id: 'session-id-001',
    groupId,
    subjectIndex: null,
    experimentMode: 'DUAL_2PC',
    status: 'PAIRED',
    canTransitionTo: jest.fn().mockReturnValue(true),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

describe('startDualMeasurement 런타임 streamStart 호출 검증', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // engineRegistryService 정리 — 이전 테스트 등록 상태 초기화
    engineRegistryService.cleanupGroup(GROUP_ID);
  });

  it('streamStartDual이 subject 1, 2에 대해 각각 정확히 1번씩 호출됨', async () => {
    // Arrange — Session.findById mock 설정
    (Session.findById as jest.Mock).mockResolvedValue(
      makeDualSession(GROUP_ID)
    );

    // Arrange — waitForBothEngines 즉시 resolve 유도: 2개 DE pre-register
    engineRegistryService.registerDual(
      GROUP_ID,
      1,
      'http://de1:5002',
      ENGINE_SECRET
    );
    engineRegistryService.registerDual(
      GROUP_ID,
      2,
      'http://de2:5002',
      ENGINE_SECRET
    );

    // Act — fire-and-forget 비동기 진입
    await startMeasurementService('session-id-001');

    // fire-and-forget 내부 async IIFE 완료 대기
    await new Promise<void>((r) => setTimeout(r, 200));

    // Assert — streamStartDual 정확히 2회 호출됨
    const { engineProxyService } = jest.requireMock(
      '@02-processes/engine/services/engine-proxy.service'
    );
    expect(engineProxyService.streamStartDual).toHaveBeenCalledTimes(2);
    expect(engineProxyService.streamStartDual).toHaveBeenCalledWith(
      GROUP_ID,
      1
    );
    expect(engineProxyService.streamStartDual).toHaveBeenCalledWith(
      GROUP_ID,
      2
    );
  });

  it('startDualMeasurement 성공 경로에서 PAIRED 세션을 MEASURING 전이함 (ADR §B)', async () => {
    // Arrange — happy-path 테스트와 동일 셋업 (registerDual 양쪽 + findById mock + streamStart 성공)
    (Session.findById as jest.Mock).mockResolvedValue(
      makeDualSession(GROUP_ID)
    );

    engineRegistryService.registerDual(
      GROUP_ID,
      1,
      'http://de1:5002',
      ENGINE_SECRET
    );
    engineRegistryService.registerDual(
      GROUP_ID,
      2,
      'http://de2:5002',
      ENGINE_SECRET
    );

    // Act — fire-and-forget 비동기 진입
    await startMeasurementService('session-id-001');

    // fire-and-forget 내부 async IIFE 완료 대기
    await new Promise<void>((r) => setTimeout(r, 200));

    // Assert — R4-6: filter는 PAIRED ONLY, update는 MEASURING + measuredAt
    expect(Session.updateMany as jest.Mock).toHaveBeenCalledWith(
      { groupId: GROUP_ID, status: 'PAIRED' },
      { status: 'MEASURING', measuredAt: expect.any(Date) }
    );
  });

  it('getOrCreate 직후 startAlignerFlushLoop이 기동되어 flush가 호출됨 (CX4-1)', async () => {
    // Arrange — happy-path 셋업
    (Session.findById as jest.Mock).mockResolvedValue(
      makeDualSession(GROUP_ID)
    );

    engineRegistryService.registerDual(
      GROUP_ID,
      1,
      'http://de1:5002',
      ENGINE_SECRET
    );
    engineRegistryService.registerDual(
      GROUP_ID,
      2,
      'http://de2:5002',
      ENGINE_SECRET
    );

    // Act — fire-and-forget 비동기 진입
    await startMeasurementService('session-id-001');

    // flush interval이 pairedWindowMs(50ms) 이상 발화할 시간 확보 (200ms 대기)
    await new Promise<void>((r) => setTimeout(r, 200));

    // Assert — flush가 GROUP_ID로 최소 1회 호출됨
    // 인터벌이 startAlignerFlushLoop에서 기동되지 않으면 flush 호출 0 → 실패
    // 존재 여부만 검증(toHaveBeenCalledWith) — 인터벌 leakage로 인한 호출 횟수 변동에 비종속적임
    const alignerMock = jest.requireMock(
      '@02-processes/measurements/services/timestamp-aligner.service'
    );
    expect(alignerMock.timestampAlignerRegistry.flush).toHaveBeenCalledWith(
      GROUP_ID
    );
  });

  it('streamStartDual 한쪽 실패 시 dual-session-failed 이벤트 emit됨', async () => {
    // Arrange — Session.findById mock 설정
    (Session.findById as jest.Mock).mockResolvedValue(
      makeDualSession(GROUP_ID)
    );

    // Arrange — 2개 DE pre-register
    engineRegistryService.registerDual(
      GROUP_ID,
      1,
      'http://de1:5002',
      ENGINE_SECRET
    );
    engineRegistryService.registerDual(
      GROUP_ID,
      2,
      'http://de2:5002',
      ENGINE_SECRET
    );

    // Arrange — 두 번째 streamStartDual 호출 시 reject
    const { engineProxyService } = jest.requireMock(
      '@02-processes/engine/services/engine-proxy.service'
    );
    (engineProxyService.streamStartDual as jest.Mock)
      .mockResolvedValueOnce({ status: 'started' })
      .mockRejectedValueOnce(new Error('DE 2 unreachable'));

    // Act
    await startMeasurementService('session-id-001');

    // fire-and-forget 내부 async IIFE + catch 완료 대기
    await new Promise<void>((r) => setTimeout(r, 200));

    // Assert — dual-session-failed 이벤트 emit 확인
    expect(SocketService.emitToGroup).toHaveBeenCalledWith(
      GROUP_ID,
      'dual-session-failed',
      expect.objectContaining({
        error: expect.stringContaining('DE 2'),
      })
    );
  });
});
