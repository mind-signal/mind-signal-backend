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
    find: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
  },
}));

// ---------------------------------------------------------------------------
// imports (mock 선언 후)
// ---------------------------------------------------------------------------
import { engineRegistryService } from '@02-processes/engine/services/engine-registry.service';
import {
  startMeasurementService,
  startDualMeasurementByGroup,
} from './measurement.service';
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

// ===========================================================================
// 회귀 재현 — DUAL_2PC 측정 라이프사이클 fix (감사 fix_needed #1, #2)
// ===========================================================================

describe('DUAL_2PC 측정 라이프사이클 회귀 재현', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    engineRegistryService.cleanupGroup(GROUP_ID);
    (Session.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 2 });
  });

  // fix #1: startDualMeasurement 성공 시 세션 MEASURING 전이 누락 회귀
  // fix 전: 성공 경로에 updateMany(MEASURING) 없음 → 세션 PAIRED 잔류 →
  //         이후 stop이 PAIRED→COMPLETED 불가로 실패. 본 테스트는 fix 전 RED.
  it('streamStartDual 성공 후 세션을 MEASURING으로 전이함', async () => {
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

    await startMeasurementService('session-id-001');
    await new Promise<void>((r) => setTimeout(r, 200));

    // 성공 경로에서 MEASURING 전이가 DB에 반영되어야 함
    expect(Session.updateMany).toHaveBeenCalledWith(
      { groupId: GROUP_ID },
      expect.objectContaining({ status: 'MEASURING' })
    );
  });

  // fix #2: startDualMeasurementByGroup canTransitionTo 가드 부재 회귀
  // fix 전: experimentMode만 보고 상태 전이 가드 없음 → 측정 불가 상태에서도
  //         start 진행. 본 테스트는 fix 전 RED(throw 기대인데 resolve됨).
  it('전이 불가 상태에서 startDualMeasurementByGroup이 400 throw함', async () => {
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
    (Session.find as jest.Mock).mockResolvedValue([
      {
        groupId: GROUP_ID,
        experimentMode: 'DUAL_2PC',
        status: 'MEASURING',
        canTransitionTo: jest.fn().mockReturnValue(false),
      },
    ]);

    await expect(startDualMeasurementByGroup(GROUP_ID)).rejects.toThrow(
      /측정을 시작할 수 없습니다/
    );
  });
});
