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
    streamStop: jest.fn().mockResolvedValue({ status: 'stopped' }),
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
import { dualTriggerService } from '@02-processes/engine/services/dual-2pc-trigger.service';
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

  // 2026-09-03 회귀 방어: subject 1이 화면에서 사라졌을 때 BE가 어떤 채널을
  // 구독했는지 남기지 않아 group_id 불일치 가설을 확인도 배제도 못 했다.
  // /proxy 핸들러의 publish 채널명과 짝을 이루는 로그이므로 지우지 말 것.
  it('구독한 채널명을 subject별로 로그에 남김 — publish 채널과 대조용', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
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

    try {
      await startMeasurementService('session-id-001');

      // 고정 대기 대신 두 줄이 나올 때까지 폴링함. 구독 완료 시점은 환경마다
      // 달라 200ms 고정 대기는 느린 머신에서 깨짐 (CodeRabbit PR #102)
      const expected = [
        `DUAL_2PC subscribe mind-signal:${GROUP_ID}:subject:1`,
        `DUAL_2PC subscribe mind-signal:${GROUP_ID}:subject:2`,
      ];
      const linesSoFar = () =>
        logSpy.mock.calls.map((args) => args.map(String).join(' '));
      const deadline = Date.now() + 2000;
      while (
        Date.now() < deadline &&
        !expected.every((line) => linesSoFar().includes(line))
      ) {
        await new Promise<void>((r) => setTimeout(r, 20));
      }

      const lines = linesSoFar();
      expect(lines).toContain(expected[0]);
      expect(lines).toContain(expected[1]);
    } finally {
      // 실패해도 mock 을 되돌림 — 안 그러면 뒤 테스트의 console.log 가 먹통이 됨
      logSpy.mockRestore();
    }
  });

  // 회귀 재현: 수신 카운터 키를 첫 프레임에서 만들면 한 번도 샘플을 못 보낸
  // subject 가 요약에서 통째로 빠진다. 이 테스트의 redis mock 은 구독 콜백을
  // 한 번도 부르지 않으므로 두 subject 모두 무수신이고, 수정 전에는 요약 줄
  // 자체가 안 나온다. 침묵을 보이게 하려는 이 로그의 목적이 걸린 지점이다
  // (CodeRabbit PR #102)
  it('샘플을 한 번도 못 받은 subject도 요약에 0으로 나옴', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.useFakeTimers();
    try {
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
      // 요약 주기(10초)를 넘겨 진행시킴. 실제 대기 없이 타이머만 앞당김
      await jest.advanceTimersByTimeAsync(10_200);

      const lines = logSpy.mock.calls.map((args) => args.map(String).join(' '));
      const summary = lines.find((l) =>
        l.includes(`DUAL_2PC ${GROUP_ID} 수신 요약`)
      );
      expect(summary).toBeDefined();
      expect(summary).toContain('subject1=0');
      expect(summary).toContain('subject2=0');
    } finally {
      jest.useRealTimers();
      logSpy.mockRestore();
    }
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

// ===========================================================================
// 전체 세션 검증 — sessions.every() 가드 (RC-2 고쳐진 사항)
// ===========================================================================

describe('startDualMeasurementByGroup 전체 세션 검증', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    engineRegistryService.cleanupGroup(GROUP_ID);
  });

  it('두 세션 중 하나가 transition 불가면 400 throw함', async () => {
    // Session.find가 두 세션 반환, 두 번째가 canTransitionTo=false
    (Session.find as jest.Mock).mockResolvedValue([
      {
        groupId: GROUP_ID,
        experimentMode: 'DUAL_2PC',
        status: 'PAIRED',
        canTransitionTo: jest.fn().mockReturnValue(true),
      },
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

  it('두 세션 중 하나가 비-DUAL_2PC면 400 throw함', async () => {
    // Session.find가 두 세션 반환, 두 번째가 experimentMode != DUAL_2PC
    (Session.find as jest.Mock).mockResolvedValue([
      {
        groupId: GROUP_ID,
        experimentMode: 'DUAL_2PC',
        status: 'PAIRED',
        canTransitionTo: jest.fn().mockReturnValue(true),
      },
      {
        groupId: GROUP_ID,
        experimentMode: 'SEQUENTIAL',
        status: 'PAIRED',
        canTransitionTo: jest.fn().mockReturnValue(true),
      },
    ]);

    await expect(startDualMeasurementByGroup(GROUP_ID)).rejects.toThrow(
      /DUAL_2PC 모드만 지원합니다/
    );
  });
});

// ===========================================================================
// 중복 트리거 차단 — dualMeasurementInFlight 가드 (RC-3 고쳐진 사항)
// ===========================================================================

// ===========================================================================
// F1 회귀 재현 — 새 그룹 시작 시 stale 그룹 aligner teardown
// (차트 0건 근본원인: 이전 run의 aligner가 allCompleted stop 없이 잔존하여
//  옛 room으로 계속 aligned_pair emit. 새 그룹 시작 시 타 그룹 정리되어야 함.)
// ===========================================================================

describe('F1 — 새 그룹 시작 시 stale 그룹 aligner teardown', () => {
  const OLD = 'grp_f1_old';
  const NEW = 'grp_f1_new';

  beforeEach(() => {
    jest.clearAllMocks();
    engineRegistryService.cleanupGroup(OLD);
    engineRegistryService.cleanupGroup(NEW);
    (Session.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 2 });
  });

  it('OLD 그룹 측정 중 NEW 그룹 시작 시 OLD aligner를 cleanup하고 NEW는 보존함', async () => {
    const { timestampAlignerRegistry } = jest.requireMock(
      '@02-processes/measurements/services/timestamp-aligner.service'
    );

    // OLD 측정 시작 — subscribeWithAligner(OLD)까지 진행되어 활성 그룹 등록됨
    (Session.find as jest.Mock).mockResolvedValue([
      makeDualSession(OLD),
      makeDualSession(OLD),
    ]);
    engineRegistryService.registerDual(
      OLD,
      1,
      'http://de1:5002',
      ENGINE_SECRET
    );
    engineRegistryService.registerDual(
      OLD,
      2,
      'http://de2:5002',
      ENGINE_SECRET
    );
    await startDualMeasurementByGroup(OLD);
    await new Promise<void>((r) => setTimeout(r, 200));

    timestampAlignerRegistry.cleanup.mockClear();

    // NEW 측정 시작 — 타 그룹(OLD) teardown 발동 기대
    (Session.find as jest.Mock).mockResolvedValue([
      makeDualSession(NEW),
      makeDualSession(NEW),
    ]);
    engineRegistryService.registerDual(
      NEW,
      1,
      'http://de3:5002',
      ENGINE_SECRET
    );
    engineRegistryService.registerDual(
      NEW,
      2,
      'http://de4:5002',
      ENGINE_SECRET
    );
    await startDualMeasurementByGroup(NEW);
    await new Promise<void>((r) => setTimeout(r, 200));

    // OLD aligner는 정리, NEW(현재 그룹)는 정리 대상 아님
    expect(timestampAlignerRegistry.cleanup).toHaveBeenCalledWith(OLD);
    expect(timestampAlignerRegistry.cleanup).not.toHaveBeenCalledWith(NEW);
  });
});

// ===========================================================================
// F1b 회귀 재현 — startup in-flight 그룹 supersede (CodeRabbit #68)
// teardownStaleGroups는 구독 완료 그룹만 보므로, OLD가 아직 waitForBothEngines
// 단계면 정리 대상에서 빠짐. NEW 시작 후 OLD가 뒤늦게 resolve되면 두 번째 aligner를
// 붙여 "단일 활성" 보장이 깨짐. supersede 가드로 차단되어야 함.
// ===========================================================================

describe('F1b — startup in-flight 그룹 supersede', () => {
  const OLD = 'grp_f1b_old';
  const NEW = 'grp_f1b_new';

  beforeEach(() => {
    jest.clearAllMocks();
    engineRegistryService.cleanupGroup(OLD);
    engineRegistryService.cleanupGroup(NEW);
    (Session.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 2 });
  });

  it('OLD가 DE 대기 중일 때 NEW 시작 시 OLD는 superseded되어 aligner 미생성', async () => {
    const { timestampAlignerRegistry } = jest.requireMock(
      '@02-processes/measurements/services/timestamp-aligner.service'
    );

    // OLD: DE 미등록 → waitForBothEngines에서 대기 상태로 진입
    (Session.find as jest.Mock).mockResolvedValue([
      makeDualSession(OLD),
      makeDualSession(OLD),
    ]);
    await startDualMeasurementByGroup(OLD);

    // NEW: DE 등록 → 정상 완료 (activeDualGroup=NEW)
    engineRegistryService.registerDual(
      NEW,
      1,
      'http://de3:5002',
      ENGINE_SECRET
    );
    engineRegistryService.registerDual(
      NEW,
      2,
      'http://de4:5002',
      ENGINE_SECRET
    );
    (Session.find as jest.Mock).mockResolvedValue([
      makeDualSession(NEW),
      makeDualSession(NEW),
    ]);
    await startDualMeasurementByGroup(NEW);
    await new Promise<void>((r) => setTimeout(r, 150));

    // 뒤늦게 OLD DE 등록 → OLD waitForBothEngines resolve → supersede 가드 진입
    engineRegistryService.registerDual(
      OLD,
      1,
      'http://de1:5002',
      ENGINE_SECRET
    );
    engineRegistryService.registerDual(
      OLD,
      2,
      'http://de2:5002',
      ENGINE_SECRET
    );
    await new Promise<void>((r) => setTimeout(r, 300));

    // NEW만 aligner 생성, OLD는 supersede되어 미생성
    expect(timestampAlignerRegistry.getOrCreate).toHaveBeenCalledWith(
      NEW,
      expect.anything()
    );
    expect(timestampAlignerRegistry.getOrCreate).not.toHaveBeenCalledWith(
      OLD,
      expect.anything()
    );
    // superseded OLD 세션은 terminal cleanup(CANCELLED)으로 정리됨 (CodeRabbit #70)
    expect(Session.updateMany).toHaveBeenCalledWith(
      { groupId: OLD },
      expect.objectContaining({ status: 'CANCELLED' })
    );
  });
});

describe('[TS-EEG-03] startDualMeasurement 중복 트리거 차단 (in-flight 가드)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    engineRegistryService.cleanupGroup(GROUP_ID);
    // 두 DE 사전 등록 — waitForBothEngines 즉시 resolve 유도
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
      makeDualSession(GROUP_ID),
      makeDualSession(GROUP_ID),
    ]);
    (Session.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 2 });
  });

  it('같은 groupId로 연속 2회 호출 시 streamStartDual은 정확히 2회만 호출됨', async () => {
    // Act — 두 호출을 await 없이 동시에 시작해 in-flight 가드 작동 검증
    const p1 = startDualMeasurementByGroup(GROUP_ID);
    const p2 = startDualMeasurementByGroup(GROUP_ID);
    await Promise.all([p1, p2]);

    // fire-and-forget IIFE 완료 대기
    await new Promise<void>((r) => setTimeout(r, 300));

    // Assert — streamStartDual은 subject 1, 2 각 1회씩 총 2회만 호출됨
    const { engineProxyService } = jest.requireMock(
      '@02-processes/engine/services/engine-proxy.service'
    );
    expect(engineProxyService.streamStartDual).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// SESSION-W005 — 실패 경로 자원 회수
//
// 정상 종료 경로(measurement.service.ts:182-184)는 unsubscribeGroupChannels /
// timestampAlignerRegistry.cleanup / engineRegistryService.cleanupGroup 셋을
// 모두 부르는데, 실패 catch 는 마지막 하나만 부른다. 그 비대칭이 결함의 본체다.
// 실패 지점마다 남는 자원이 다르므로 세 시나리오를 따로 건다.
// ---------------------------------------------------------------------------
describe('[SESSION-W005] DUAL_2PC 실패 경로 자원 회수', () => {
  /** duplicate() 가 매번 새 subscriber 를 돌려주도록 바꾸고 그 목록을 반환함 */
  function trackSubscribers(overrides: Array<Record<string, unknown>> = []) {
    const created: Array<Record<string, jest.Mock>> = [];
    const { redisService } = jest.requireMock('@07-shared/lib/redis');
    (redisService.client.duplicate as jest.Mock).mockImplementation(() => {
      const override = overrides[created.length] ?? {};
      const sub = {
        connect: jest.fn().mockResolvedValue(undefined),
        subscribe: jest.fn().mockResolvedValue(undefined),
        unsubscribe: jest.fn().mockResolvedValue(undefined),
        quit: jest.fn().mockResolvedValue(undefined),
        isOpen: false,
        ...override,
      };
      created.push(sub as unknown as Record<string, jest.Mock>);
      return sub;
    });
    return created;
  }

  /** 두 DE 를 미리 등록해 waitForBothEngines 를 즉시 통과시킴 */
  function registerBothEngines(groupId: string) {
    engineRegistryService.registerDual(
      groupId,
      1,
      'http://de1:5002',
      ENGINE_SECRET
    );
    engineRegistryService.registerDual(
      groupId,
      2,
      'http://de2:5002',
      ENGINE_SECRET
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    engineRegistryService.cleanupGroup(GROUP_ID);
    (Session.findById as jest.Mock).mockResolvedValue(
      makeDualSession(GROUP_ID)
    );
    // startDualMeasurementByGroup 은 findById 가 아니라 find 로 그룹 세션을 모음
    (Session.find as jest.Mock).mockResolvedValue([
      makeDualSession(GROUP_ID),
      makeDualSession(GROUP_ID),
    ]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('R1 구독 완료 후 실패해도 구독자와 aligner 를 회수함', async () => {
    // Arrange — 구독까지 성공시킨 뒤 마지막 성공 emit 에서만 throw 시킴.
    // 이 지점이 subscribers / flush interval / healthTracker / aligner 가
    // 모두 등록된 뒤라서, 셋을 다 회수하는지 볼 수 있는 유일한 실패 창이다.
    const subs = trackSubscribers();
    registerBothEngines(GROUP_ID);

    (SocketService.emitToGroup as jest.Mock).mockImplementation(
      (_gid: string, event: string) => {
        if (event === 'dual-session-ready') {
          throw new Error('emit 실패 주입임');
        }
      }
    );

    // Act
    await startDualMeasurementByGroup(GROUP_ID);
    await new Promise<void>((r) => setTimeout(r, 250));

    // Assert — 구독자 2개가 모두 정리됨
    expect(subs).toHaveLength(2);
    for (const sub of subs) {
      expect(sub.unsubscribe).toHaveBeenCalled();
      expect(sub.quit).toHaveBeenCalled();
    }

    // Assert — aligner 도 정리됨
    const { timestampAlignerRegistry } = jest.requireMock(
      '@02-processes/measurements/services/timestamp-aligner.service'
    );
    expect(timestampAlignerRegistry.cleanup).toHaveBeenCalledWith(GROUP_ID);

    // Assert — 실패 통보와 최종 상태는 그대로 유지됨 (상태 정책 무변경)
    expect(SocketService.emitToGroup).toHaveBeenCalledWith(
      GROUP_ID,
      'dual-session-failed',
      expect.objectContaining({ groupId: GROUP_ID })
    );
    expect(Session.updateMany).toHaveBeenCalledWith(
      { groupId: GROUP_ID },
      expect.objectContaining({
        status: 'CANCELLED',
        stopReason: 'ProcessError',
      })
    );
  });

  it('R2 두 번째 구독자 연결 실패 시 첫 번째 구독자도 회수함', async () => {
    // Arrange — 두 번째 subscriber 의 subscribe 만 실패시킴.
    // groupSubscribers.set 은 W005 에서 루프 앞으로 옮겼다(service:73).
    // 첫 subscriber 가 어느 맵에도 없는 고아가 되던 회귀의 가드다.
    const subs = trackSubscribers([
      {},
      { subscribe: jest.fn().mockRejectedValue(new Error('구독 실패 주입임')) },
    ]);
    registerBothEngines(GROUP_ID);

    // Act
    await startDualMeasurementByGroup(GROUP_ID);
    await new Promise<void>((r) => setTimeout(r, 250));

    // Assert — 첫 subscriber 가 회수돼야 함
    expect(subs.length).toBeGreaterThanOrEqual(2);
    expect(subs[0].unsubscribe).toHaveBeenCalled();
    expect(subs[0].quit).toHaveBeenCalled();
  });

  it('R5 subscribe 에 실패한 구독자 자신도 회수함', async () => {
    // Arrange — R2 와 같은 주입이지만 단언 대상이 실패한 구독자 본인이다.
    // push 가 subscribe 뒤에 있으면 이 구독자는 connect 로 TCP 를 연 채
    // 배열에 들어가지 못해 unsubscribeGroupChannels 가 영영 회수하지 못한다.
    const subs = trackSubscribers([
      {},
      { subscribe: jest.fn().mockRejectedValue(new Error('구독 실패 주입임')) },
    ]);
    registerBothEngines(GROUP_ID);

    // Act
    await startDualMeasurementByGroup(GROUP_ID);
    await new Promise<void>((r) => setTimeout(r, 250));

    // Assert — 전제: 두 번째 구독자가 connect 를 지나 subscribe 에서 실패했다.
    // 이걸 먼저 박지 않으면 다른 초기화 오류로 정리가 돌아도 통과한다
    expect(subs.length).toBeGreaterThanOrEqual(2);
    expect(subs[1].connect).toHaveBeenCalled();
    expect(subs[1].subscribe).toHaveBeenCalledTimes(1);

    // Assert — 실패한 그 구독자도 회수돼야 하고, 이중 회수는 없어야 함
    expect(subs[1].unsubscribe).toHaveBeenCalledTimes(1);
    expect(subs[1].quit).toHaveBeenCalledTimes(1);
  });

  it('R3 실패 시 원격 엔진을 먼저 세우고 그다음 registry 를 지움', async () => {
    // Arrange — 한쪽만 stream 시작에 성공시킴. 성공한 쪽 엔진은 계속 돌고 있다.
    registerBothEngines(GROUP_ID);
    const { engineProxyService } = jest.requireMock(
      '@02-processes/engine/services/engine-proxy.service'
    );
    (engineProxyService.streamStartDual as jest.Mock)
      .mockResolvedValueOnce({ status: 'started' })
      .mockRejectedValueOnce(new Error('DE 2 unreachable'));

    const cleanupSpy = jest.spyOn(engineRegistryService, 'cleanupGroup');
    const resetStatusSpy = jest.spyOn(dualTriggerService, 'resetStatus');

    // Act
    await startDualMeasurementByGroup(GROUP_ID);
    await new Promise<void>((r) => setTimeout(r, 250));

    // Assert — 정지 시도가 있어야 함
    const stopMock = engineProxyService.streamStop as jest.Mock;
    expect(stopMock).toHaveBeenCalled();

    // Assert — registry-status 캐시도 함께 지워야 함. 남으면 ready=true 가 GC
    // 30분까지 살아 복원된 운영자 화면에 `실험 시작`이 다시 뜸 (2026-09-07)
    expect(resetStatusSpy).toHaveBeenCalledWith(GROUP_ID);

    // Assert — 순서가 핵심임. registry 를 먼저 지우면 streamStop 이 engineUrl 을
    // 찾지 못해 legacy 폴백 503 이 된다. 호출 여부만 보면 이 결함을 못 잡는다.
    const firstStop = Math.min(...stopMock.mock.invocationCallOrder);
    const firstCleanup = Math.min(...cleanupSpy.mock.invocationCallOrder);
    expect(firstStop).toBeLessThan(firstCleanup);
  });

  // registrationTimeoutMs(5000) 가 실제로 만료되어야 catch 가 타므로 여유를 둠
  it('R4 그룹 등록이 없으면 streamStop 을 아예 부르지 않음', async () => {
    // Arrange — DE 를 등록하지 않음. waitForBothEngines 가 timeout 으로 실패함.
    // 이때 streamStop 을 부르면 getByGroup 이 undefined 라 legacy 단일 슬롯
    // URL 로 폴백하고(engine-proxy.service.ts:194-199), 그 슬롯이 차 있으면
    // 무관한 1PC 측정에 종료 요청이 나간다 (engine-registry.service.ts:49-53 은
    // 슬롯이 비었을 때만 503 을 던짐)
    const { engineProxyService } = jest.requireMock(
      '@02-processes/engine/services/engine-proxy.service'
    );

    // Act — 등록 없이 시작. registrationTimeoutMs(5000) 만료 후 catch 진입함
    await startDualMeasurementByGroup(GROUP_ID);
    await new Promise<void>((r) => setTimeout(r, 6000));

    // 전제 확인 — catch 가 실제로 탔는지 먼저 본다. 안 탔으면 이 테스트는 무의미함
    expect(SocketService.emitToGroup).toHaveBeenCalledWith(
      GROUP_ID,
      'dual-session-failed',
      expect.anything()
    );

    // Assert — 등록이 없으므로 정지 대상도 없음
    expect(engineProxyService.streamStop).not.toHaveBeenCalled();
  }, 15000);
});
