/* eslint-disable camelcase */
/**
 * proxy-ingest.handler.test.ts — /proxy 네임스페이스 인그레스 핸들러 단위 테스트
 *
 * 검증 항목 (PLAN T1-BE-G, ADR §F):
 *   - 핸드셰이크 인증 미들웨어 — 잘못된 engineSecret → next(Error('unauthorized'))
 *   - 핸드셰이크 인증 미들웨어 — 올바른 engineSecret → next() 에러 없음
 *   - Zod 검증 실패 프레임 → ack {ok:false, error:'invalid_frame', retryable:false}
 *   - MEASURING 세션 미조회 → ack {ok:false, error:'session_not_measuring', retryable:false}
 *   - fail-closed 게이트 발동 → ack {ok:false, error:'fail_closed', retryable:false}
 *   - fail-closed 게이트 미발동(undefined) → 정상 진행
 *   - E11000 중복 → ack {ok:true, duplicate:true}, ingest 미호출, getOrCreate 미호출
 *   - 정상 경로 → getOrCreate + ingest 정확한 4인자 + ack {ok:true} + Session.findOne 필터 검증
 *   - 비-E11000 저장 오류 → ack {ok:false, error:'internal_error', retryable:true}, ingest 미호출
 */

// SocketService 모킹 — /proxy 네임스페이스 팩토리 패턴
jest.mock('@07-shared/lib/socket', () => ({
  SocketService: {
    getIO: jest.fn(),
  },
}));

// Session 모킹 — MEASURING 상태 조회
jest.mock('@06-entities/sessions', () => ({
  Session: {
    findOne: jest.fn(),
  },
}));

// measurementSampleRepository 모킹 — create 메서드
jest.mock('@06-entities/measurement-samples', () => ({
  measurementSampleRepository: {
    create: jest.fn(),
  },
}));

// engineRegistryService 모킹 — getFailClosedNs 조회
jest.mock('@02-processes/engine/services/engine-registry.service', () => ({
  engineRegistryService: {
    getFailClosedNs: jest.fn(),
  },
}));

// timestampAlignerRegistry 모킹 — getOrCreate + ingest
jest.mock('./timestamp-aligner.service', () => ({
  timestampAlignerRegistry: {
    getOrCreate: jest.fn(),
    ingest: jest.fn(),
  },
}));

import { SocketService } from '@07-shared/lib/socket';
import { Session } from '@06-entities/sessions';
import { measurementSampleRepository } from '@06-entities/measurement-samples';
import { engineRegistryService } from '@02-processes/engine/services/engine-registry.service';
import { timestampAlignerRegistry } from './timestamp-aligner.service';
import { config } from '@07-shared/config/config';

// ============================================================
// 테스트 픽스처
// ============================================================

/** 유효한 SampleEnvelope 픽스처 */
const VALID_ENVELOPE = {
  group_id: 'grp-test-01',
  subject_idx: 1,
  de_ts_ns: '1700000000000000000',
  proxy_ingress_ts_ns: '1700000000100000000',
  seq: 42,
  payload: {
    delta: 0.1,
    theta: 0.2,
    alpha: 0.3,
    beta: 0.4,
    gamma: 0.5,
  },
  sync_meta: {},
};

// ============================================================
// 소켓 네임스페이스 팩토리 헬퍼
// ============================================================

/**
 * 가짜 /proxy 네임스페이스 빌더 반환함.
 * use(middleware) + on('connection', handler) 캡처하여
 * 테스트에서 핸드셰이크 검증 및 proxy:sample 이벤트 구동 가능하게 함.
 */
function buildFakeNamespace() {
  let capturedMiddleware:
    | ((socket: unknown, next: (err?: Error) => void) => void)
    | null = null;
  let capturedConnectionHandler: ((socket: unknown) => void) | null = null;

  const fakeNs = {
    use: jest.fn(
      (fn: (socket: unknown, next: (err?: Error) => void) => void) => {
        capturedMiddleware = fn;
      }
    ),
    on: jest.fn((event: string, handler: (socket: unknown) => void) => {
      if (event === 'connection') {
        capturedConnectionHandler = handler;
      }
    }),
  };

  const fakeIO = {
    of: jest.fn(() => fakeNs),
  };

  (SocketService.getIO as jest.Mock).mockReturnValue(fakeIO);

  /**
   * 핸드셰이크 미들웨어를 직접 실행하여 next 콜백 반환값 검증함.
   */
  function runMiddleware(
    engineSecret: string | undefined
  ): Promise<Error | undefined> {
    return new Promise((resolve) => {
      const fakeSocket = { handshake: { auth: { engineSecret } } };
      capturedMiddleware!(fakeSocket, (err?: Error) => resolve(err));
    });
  }

  /**
   * 가짜 socket을 connection 핸들러로 넘겨 proxy:sample 이벤트 구동함.
   */
  function driveProxySample(
    frame: unknown,
    ack: (r: {
      ok: boolean;
      error?: string;
      retryable?: boolean;
      duplicate?: boolean;
    }) => void
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let eventHandler: ((frame: unknown, ack: unknown) => void) | null = null;

      const fakeSocket = {
        on: jest.fn(
          (event: string, handler: (frame: unknown, ack: unknown) => void) => {
            if (event === 'proxy:sample') {
              eventHandler = handler;
            }
          }
        ),
      };

      capturedConnectionHandler!(fakeSocket);

      // async 핸들러가 끝난 후 resolve하기 위해 Promise로 래핑함
      Promise.resolve(eventHandler!(frame, ack)).then(() => resolve());
    });
  }

  return { fakeNs, runMiddleware, driveProxySample };
}

// ============================================================
// 테스트 스위트 진입점
// ============================================================

import { registerProxyIngestNamespace } from './proxy-ingest.handler';

describe('registerProxyIngestNamespace — /proxy 인그레스 핸들러', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================
  // 핸드셰이크 인증 미들웨어
  // ============================================================

  describe('핸드셰이크 인증 미들웨어', () => {
    it('잘못된 engineSecret → next(Error("unauthorized")) 전달함', async () => {
      const { runMiddleware } = buildFakeNamespace();
      registerProxyIngestNamespace();

      const err = await runMiddleware('wrong-secret');
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toBe('unauthorized');
    });

    it('올바른 engineSecret → next() 에러 없이 호출함', async () => {
      const { runMiddleware } = buildFakeNamespace();
      registerProxyIngestNamespace();

      const err = await runMiddleware(config.dataEngine.secretKey);
      expect(err).toBeUndefined();
    });
  });

  // ============================================================
  // proxy:sample 이벤트 핸들러
  // ============================================================

  describe('proxy:sample 이벤트 핸들러', () => {
    it('Zod 검증 실패 프레임 → ack {ok:false, error:"invalid_frame", retryable:false} 반환함', async () => {
      const { driveProxySample } = buildFakeNamespace();
      registerProxyIngestNamespace();

      const ack = jest.fn();
      // group_id 누락으로 Zod 검증 실패 유발함
      await driveProxySample({ subject_idx: 1 }, ack);

      expect(ack).toHaveBeenCalledWith({
        ok: false,
        error: 'invalid_frame',
        retryable: false,
      });
    });

    it('MEASURING 세션 미조회 → ack {ok:false, error:"session_not_measuring", retryable:false} 반환함', async () => {
      (Session.findOne as jest.Mock).mockResolvedValue(null);
      (engineRegistryService.getFailClosedNs as jest.Mock).mockReturnValue(
        undefined
      );

      const { driveProxySample } = buildFakeNamespace();
      registerProxyIngestNamespace();

      const ack = jest.fn();
      await driveProxySample(VALID_ENVELOPE, ack);

      expect(ack).toHaveBeenCalledWith({
        ok: false,
        error: 'session_not_measuring',
        retryable: false,
      });
    });

    it('fail-closed 게이트 발동 → ack {ok:false, error:"fail_closed", retryable:false} 반환함', async () => {
      // proxy_ingress_ts_ns >= failClosedNs 조건 충족 — 게이트 발동함
      const failClosedNs = BigInt(VALID_ENVELOPE.proxy_ingress_ts_ns) - 1n;
      (engineRegistryService.getFailClosedNs as jest.Mock).mockReturnValue(
        failClosedNs
      );
      (Session.findOne as jest.Mock).mockResolvedValue({ status: 'MEASURING' });

      const { driveProxySample } = buildFakeNamespace();
      registerProxyIngestNamespace();

      const ack = jest.fn();
      await driveProxySample(VALID_ENVELOPE, ack);

      expect(ack).toHaveBeenCalledWith({
        ok: false,
        error: 'fail_closed',
        retryable: false,
      });
    });

    it('fail-closed 게이트 미발동(undefined) → 정상 경로 진행함', async () => {
      // getFailClosedNs undefined → 게이트 미발동 → 정상 저장 경로 진행함
      (engineRegistryService.getFailClosedNs as jest.Mock).mockReturnValue(
        undefined
      );
      (Session.findOne as jest.Mock).mockResolvedValue({ status: 'MEASURING' });
      (measurementSampleRepository.create as jest.Mock).mockResolvedValue({});
      const fakeAligner = {};
      (timestampAlignerRegistry.getOrCreate as jest.Mock).mockReturnValue(
        fakeAligner
      );
      (timestampAlignerRegistry.ingest as jest.Mock).mockReturnValue(undefined);

      const { driveProxySample } = buildFakeNamespace();
      registerProxyIngestNamespace();

      const ack = jest.fn();
      await driveProxySample(VALID_ENVELOPE, ack);

      // create 호출 + ack ok:true 반환 — 정상 경로 확인함
      expect(
        measurementSampleRepository.create as jest.Mock
      ).toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith({ ok: true });
    });

    it('E11000 중복 오류 → ack {ok:true, duplicate:true} + ingest 미호출 확인함', async () => {
      (engineRegistryService.getFailClosedNs as jest.Mock).mockReturnValue(
        undefined
      );
      (Session.findOne as jest.Mock).mockResolvedValue({ status: 'MEASURING' });
      // E11000 중복 키 오류 시뮬레이션함
      const dupError = Object.assign(new Error('E11000'), { code: 11000 });
      (measurementSampleRepository.create as jest.Mock).mockRejectedValue(
        dupError
      );

      const { driveProxySample } = buildFakeNamespace();
      registerProxyIngestNamespace();

      const ack = jest.fn();
      await driveProxySample(VALID_ENVELOPE, ack);

      expect(ack).toHaveBeenCalledWith({ ok: true, duplicate: true });
      // 중복 케이스 — ingest 호출 금지 검증함
      expect(
        timestampAlignerRegistry.ingest as jest.Mock
      ).not.toHaveBeenCalled();
      // 중복 케이스 — getOrCreate 호출 금지 검증함 (저장 전 catch 분기이므로)
      expect(
        timestampAlignerRegistry.getOrCreate as jest.Mock
      ).not.toHaveBeenCalled();
    });

    it('정상 경로 → getOrCreate + ingest 정확한 4인자 + ack {ok:true} 반환함', async () => {
      (engineRegistryService.getFailClosedNs as jest.Mock).mockReturnValue(
        undefined
      );
      (Session.findOne as jest.Mock).mockResolvedValue({ status: 'MEASURING' });
      (measurementSampleRepository.create as jest.Mock).mockResolvedValue({});
      const fakeAligner = {};
      (timestampAlignerRegistry.getOrCreate as jest.Mock).mockReturnValue(
        fakeAligner
      );
      (timestampAlignerRegistry.ingest as jest.Mock).mockReturnValue(undefined);

      const { driveProxySample } = buildFakeNamespace();
      registerProxyIngestNamespace();

      const ack = jest.fn();
      await driveProxySample(VALID_ENVELOPE, ack);

      // getOrCreate 호출 인자 검증 — groupId + config.dualPc.timestampToleranceMs
      expect(
        timestampAlignerRegistry.getOrCreate as jest.Mock
      ).toHaveBeenCalledWith(
        VALID_ENVELOPE.group_id,
        config.dualPc.timestampToleranceMs
      );

      // ingest 4인자 정확한 검증 (ADR §C, Wave1 Critical — subject_idx 변환 금지)
      // 4번째 인자 = proxy_ingress_ts_ns 문자열 그대로 전달 확인함
      expect(timestampAlignerRegistry.ingest as jest.Mock).toHaveBeenCalledWith(
        VALID_ENVELOPE.group_id, // arg1: group_id
        VALID_ENVELOPE.subject_idx, // arg2: subject_idx (1-based, +1/-1 변환 금지)
        VALID_ENVELOPE.payload, // arg3: payload
        VALID_ENVELOPE.proxy_ingress_ts_ns // arg4: proxy_ingress_ts_ns 문자열 그대로
      );

      // 4번째 인자 정확한 문자열 값 단독 검증함
      const ingestCall = (timestampAlignerRegistry.ingest as jest.Mock).mock
        .calls[0];
      expect(ingestCall[3]).toBe(VALID_ENVELOPE.proxy_ingress_ts_ns);

      // subject_idx 1-based passthrough — +1/-1 변환 금지 검증함
      expect(ingestCall[1]).toBe(1);

      // Session.findOne 필터 — subject_idx(snake) → subjectIndex(camel) 매핑 검증함
      expect(Session.findOne as jest.Mock).toHaveBeenCalledWith({
        groupId: VALID_ENVELOPE.group_id,
        subjectIndex: VALID_ENVELOPE.subject_idx,
        status: 'MEASURING',
      });

      expect(ack).toHaveBeenCalledWith({ ok: true });
    });

    it('비-E11000 저장 오류 → ack {ok:false, error:"internal_error", retryable:true} + ingest 미호출함', async () => {
      (engineRegistryService.getFailClosedNs as jest.Mock).mockReturnValue(
        undefined
      );
      (Session.findOne as jest.Mock).mockResolvedValue({ status: 'MEASURING' });
      // code 없는 일반 오류 (비-11000) 시뮬레이션함
      (measurementSampleRepository.create as jest.Mock).mockRejectedValue(
        new Error('network error')
      );

      const { driveProxySample } = buildFakeNamespace();
      registerProxyIngestNamespace();

      const ack = jest.fn();
      await driveProxySample(VALID_ENVELOPE, ack);

      expect(ack).toHaveBeenCalledWith({
        ok: false,
        error: 'internal_error',
        retryable: true,
      });
      expect(
        timestampAlignerRegistry.ingest as jest.Mock
      ).not.toHaveBeenCalled();
    });
  });
});
