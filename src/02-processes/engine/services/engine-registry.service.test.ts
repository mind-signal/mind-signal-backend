/**
 * engine-registry.service.ts — Unit 테스트 (BE-5 + T1-BE-F)
 *
 * 검증 항목:
 *   - 기존 getEngineUrl: 등록 전 → AppError 503, 등록 후 → URL 반환
 *   - registerDual + getEngineUrlByGroupSubject: 1-based subjectIndex
 *   - isFullyRegistered: 2개 등록 시 true, 1개만 등록 시 false
 *   - v8 M-1: getEngineUrlByGroupSubject(groupId, 1) → subject 1 URL 조회
 *   - cleanupGroup: 등록 데이터 제거 후 isFullyRegistered false
 *   - T1-BE-F: proxy /health poll fail-closed 프로듀서 검증
 */

// config 모킹 — 시크릿 키 + proxyUrl + proxyHealth 주입
jest.mock('@07-shared/config/config', () => ({
  config: {
    dataEngine: { secretKey: 'valid-secret' },
    jwtSecret: { secret: 'test-secret', expiresIn: '1d' },
    proxyUrl: '',
    proxyHealth: { pollIntervalMs: 1000, failCount: 3 },
  },
}));

// Session.updateMany 모킹 — fail-closed 시 CANCELLED 전이 검증용
jest.mock('@06-entities/sessions', () => ({
  Session: {
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  },
}));

// SocketService.emitToGroup 모킹 — fail-closed 이벤트 검증용
jest.mock('@07-shared/lib/socket', () => ({
  SocketService: {
    emitToGroup: jest.fn(),
  },
}));

// engineRegistryService는 모듈 레벨 상태를 유지하므로 각 테스트 전 상태 초기화 필요
// jest.resetModules + require() 패턴으로 독립 인스턴스 사용

describe('engineRegistryService — BE-5', () => {
  let engineRegistryService: typeof import('./engine-registry.service').engineRegistryService;

  beforeEach(() => {
    // 모듈 캐시를 초기화하여 모듈 레벨 상태(registeredEngineUrl, dualRegistry 등) 리셋함
    jest.resetModules();
    jest.useFakeTimers();
    // config 모킹을 resetModules 후 재등록
    jest.mock('@07-shared/config/config', () => ({
      config: {
        dataEngine: { secretKey: 'valid-secret' },
        jwtSecret: { secret: 'test-secret', expiresIn: '1d' },
        proxyUrl: '',
        proxyHealth: { pollIntervalMs: 1000, failCount: 3 },
      },
    }));
    jest.mock('@06-entities/sessions', () => ({
      Session: {
        updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      },
    }));
    jest.mock('@07-shared/lib/socket', () => ({
      SocketService: {
        emitToGroup: jest.fn(),
      },
    }));
    engineRegistryService =
      require('./engine-registry.service').engineRegistryService;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ============================================================
  // 기존 getEngineUrl — backward compat 검증
  // ============================================================

  describe('getEngineUrl (기존 1PC 경로 보존)', () => {
    it('등록 전 호출 시 AppError 503 발생함', () => {
      expect(() => engineRegistryService.getEngineUrl()).toThrow();
      try {
        engineRegistryService.getEngineUrl();
      } catch (err: any) {
        expect(err.statusCode).toBe(503);
      }
    });

    it('register 후 getEngineUrl이 URL 반환함', () => {
      engineRegistryService.register('http://engine-1:5002', 'valid-secret');
      expect(engineRegistryService.getEngineUrl()).toBe('http://engine-1:5002');
    });

    it('잘못된 시크릿 키로 register 시 AppError 403 발생함', () => {
      expect(() =>
        engineRegistryService.register('http://engine-1:5002', 'wrong-secret')
      ).toThrow();
      try {
        engineRegistryService.register('http://engine-1:5002', 'wrong-secret');
      } catch (err: any) {
        expect(err.statusCode).toBe(403);
      }
    });

    it('isRegistered — 등록 전 false, 등록 후 true 반환함', () => {
      expect(engineRegistryService.isRegistered()).toBe(false);
      engineRegistryService.register('http://engine-1:5002', 'valid-secret');
      expect(engineRegistryService.isRegistered()).toBe(true);
    });
  });

  // ============================================================
  // 신규 DUAL_2PC 메서드 검증
  // ============================================================

  describe('registerDual + getEngineUrlByGroupSubject (DUAL_2PC)', () => {
    it('registerDual 후 getEngineUrlByGroupSubject로 URL 조회됨', () => {
      engineRegistryService.registerDual(
        'grp-001',
        1,
        'http://engine-pc1:5002',
        'valid-secret'
      );
      const url = engineRegistryService.getEngineUrlByGroupSubject(
        'grp-001',
        1
      );
      expect(url).toBe('http://engine-pc1:5002');
    });

    it('미등록 subjectIndex 조회 시 AppError 503 발생함', () => {
      expect(() =>
        engineRegistryService.getEngineUrlByGroupSubject('grp-001', 2)
      ).toThrow();
      try {
        engineRegistryService.getEngineUrlByGroupSubject('grp-001', 2);
      } catch (err: any) {
        expect(err.statusCode).toBe(503);
      }
    });

    it('v8 M-1: subjectIndex=1 1-based indexing — 인덱스 1이 subject_1로 조회됨', () => {
      // 1-based: subjectIndex=1이 subject 1 (첫 번째 피실험자)로 매핑됨
      engineRegistryService.registerDual(
        'grp-m1',
        1,
        'http://subject-1-engine:5002',
        'valid-secret'
      );
      engineRegistryService.registerDual(
        'grp-m1',
        2,
        'http://subject-2-engine:5002',
        'valid-secret'
      );

      expect(
        engineRegistryService.getEngineUrlByGroupSubject('grp-m1', 1)
      ).toBe('http://subject-1-engine:5002');
      expect(
        engineRegistryService.getEngineUrlByGroupSubject('grp-m1', 2)
      ).toBe('http://subject-2-engine:5002');
    });

    it('v8 M-1: 경계 케이스 — subjectIndex=1이 subject_2로 매핑되지 않음', () => {
      // 1-based: getEngineUrlByGroupSubject(groupId, 1)은 subjectIndex 1을 조회해야 함
      engineRegistryService.registerDual(
        'grp-boundary',
        1,
        'http://pc1:5002',
        'valid-secret'
      );
      // subjectIndex 2는 아직 미등록
      expect(() =>
        engineRegistryService.getEngineUrlByGroupSubject('grp-boundary', 2)
      ).toThrow();
    });

    it('잘못된 시크릿으로 registerDual 시 AppError 403 발생함', () => {
      expect(() =>
        engineRegistryService.registerDual(
          'grp-001',
          1,
          'http://engine:5002',
          'wrong'
        )
      ).toThrow();
      try {
        engineRegistryService.registerDual(
          'grp-001',
          1,
          'http://engine:5002',
          'wrong'
        );
      } catch (err: any) {
        expect(err.statusCode).toBe(403);
      }
    });
  });

  // ============================================================
  // isFullyRegistered 검증
  // ============================================================

  describe('isFullyRegistered', () => {
    it('등록 없을 때 false 반환함', () => {
      expect(engineRegistryService.isFullyRegistered('grp-001')).toBe(false);
    });

    it('1개만 등록 시 false 반환함 (expectedCount=2 기본값)', () => {
      engineRegistryService.registerDual(
        'grp-001',
        1,
        'http://engine:5002',
        'valid-secret'
      );
      expect(engineRegistryService.isFullyRegistered('grp-001')).toBe(false);
    });

    it('2개 등록 시 true 반환함', () => {
      engineRegistryService.registerDual(
        'grp-001',
        1,
        'http://engine-1:5002',
        'valid-secret'
      );
      engineRegistryService.registerDual(
        'grp-001',
        2,
        'http://engine-2:5002',
        'valid-secret'
      );
      expect(engineRegistryService.isFullyRegistered('grp-001')).toBe(true);
    });

    it('expectedCount=1 시 1개 등록으로 true 반환함', () => {
      engineRegistryService.registerDual(
        'grp-001',
        1,
        'http://engine:5002',
        'valid-secret'
      );
      expect(engineRegistryService.isFullyRegistered('grp-001', 1)).toBe(true);
    });
  });

  // ============================================================
  // cleanupGroup 검증
  // ============================================================

  describe('cleanupGroup', () => {
    it('cleanup 후 isFullyRegistered false 반환함', () => {
      engineRegistryService.registerDual(
        'grp-001',
        1,
        'http://engine-1:5002',
        'valid-secret'
      );
      engineRegistryService.registerDual(
        'grp-001',
        2,
        'http://engine-2:5002',
        'valid-secret'
      );
      expect(engineRegistryService.isFullyRegistered('grp-001')).toBe(true);

      engineRegistryService.cleanupGroup('grp-001');
      expect(engineRegistryService.isFullyRegistered('grp-001')).toBe(false);
    });

    it('cleanup 후 getEngineUrlByGroupSubject → AppError 503 발생함', () => {
      engineRegistryService.registerDual(
        'grp-001',
        1,
        'http://engine:5002',
        'valid-secret'
      );
      engineRegistryService.cleanupGroup('grp-001');

      expect(() =>
        engineRegistryService.getEngineUrlByGroupSubject('grp-001', 1)
      ).toThrow();
    });
  });

  // ============================================================
  // onRegistered 콜백 검증
  // ============================================================

  describe('onRegistered 콜백', () => {
    it('registerDual 호출 시 onRegistered 콜백 invoke됨', () => {
      const callback = jest.fn();
      engineRegistryService.onRegistered('grp-cb', callback);

      engineRegistryService.registerDual(
        'grp-cb',
        1,
        'http://engine:5002',
        'valid-secret'
      );

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('unsubscribe 함수 호출 후 콜백 미호출됨', () => {
      const callback = jest.fn();
      const unsubscribe = engineRegistryService.onRegistered(
        'grp-unsub',
        callback
      );
      unsubscribe();

      engineRegistryService.registerDual(
        'grp-unsub',
        1,
        'http://engine:5002',
        'valid-secret'
      );

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // T1-BE-F: proxy /health poll fail-closed 프로듀서 검증
  // ============================================================

  describe('T1-BE-F: proxy /health poll fail-closed (ADR-010 §D)', () => {
    // proxyUrl 활성화 버전 — 테스트 A/B/C/E 공용 describe
    describe('proxyUrl 활성 (http://proxy:8080)', () => {
      let svc: typeof import('./engine-registry.service').engineRegistryService;
      let mockUpdateMany: jest.Mock;
      let mockEmitToGroup: jest.Mock;

      beforeEach(() => {
        jest.resetModules();
        jest.useFakeTimers();
        jest.mock('@07-shared/config/config', () => ({
          config: {
            dataEngine: { secretKey: 'valid-secret' },
            jwtSecret: { secret: 'test-secret', expiresIn: '1d' },
            proxyUrl: 'http://proxy:8080',
            proxyHealth: { pollIntervalMs: 1000, failCount: 3 },
          },
        }));
        mockUpdateMany = jest.fn().mockResolvedValue({ modifiedCount: 1 });
        mockEmitToGroup = jest.fn();
        jest.mock('@06-entities/sessions', () => ({
          Session: { updateMany: mockUpdateMany },
        }));
        jest.mock('@07-shared/lib/socket', () => ({
          SocketService: { emitToGroup: mockEmitToGroup },
        }));
        svc = require('./engine-registry.service').engineRegistryService;
      });

      afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
      });

      // A: failCount 연속 실패 시 fail-closed 발동 검증
      it('A: proxyUrl 설정 + failCount 연속 실패 → failClosedAtNsByGroup.set + CANCELLED + emit', async () => {
        // fetch 503 응답으로 모킹 — 연속 실패 시나리오
        const mockFetch = jest
          .fn()
          .mockResolvedValue({ ok: false, status: 503 });
        global.fetch = mockFetch;

        const groupId = 'grp-fail-a';

        svc.startProxyHealthPoll(groupId);

        // failCount=3 → 3회 폴링 후 trip
        await jest.advanceTimersByTimeAsync(3000);

        // observable 결과 검증: getFailClosedNs bigint 반환함
        expect(typeof svc.getFailClosedNs(groupId)).toBe('bigint');

        // Session.updateMany CANCELLED 전이 검증
        expect(mockUpdateMany).toHaveBeenCalledWith(
          { groupId },
          { status: 'CANCELLED', stopReason: 'ProcessError' }
        );

        // SocketService.emitToGroup dual-session-failed 발신 검증
        expect(mockEmitToGroup).toHaveBeenCalledWith(
          groupId,
          'dual-session-failed',
          expect.objectContaining({ groupId })
        );

        // one-shot 보장: updateMany/emitToGroup 각 1회 호출 검증
        expect(mockUpdateMany).toHaveBeenCalledTimes(1);
        expect(mockEmitToGroup).toHaveBeenCalledTimes(1);

        // 트립 후 추가 fetch 미발생 — 인터벌 중단 검증
        const callCountAfterTrip = mockFetch.mock.calls.length;
        await jest.advanceTimersByTimeAsync(3000);
        expect(mockFetch.mock.calls.length).toBe(callCountAfterTrip);
      });

      // B: failCount-1 연속 실패 시 미발동 검증 (임계값 미달)
      it('B: failCount-1 연속 실패 → getFailClosedNs undefined, CANCELLED 미호출', async () => {
        // 503 응답 — failCount-1(=2) 회만 실행
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });

        const groupId = 'grp-fail-b';

        svc.startProxyHealthPoll(groupId);

        // 2회 폴링 (< failCount=3) — 미발동 상태
        await jest.advanceTimersByTimeAsync(2000);

        // 미발동: getFailClosedNs undefined
        expect(svc.getFailClosedNs(groupId)).toBeUndefined();
        // Session.updateMany 미호출
        expect(mockUpdateMany).not.toHaveBeenCalled();
        // emitToGroup 미호출
        expect(mockEmitToGroup).not.toHaveBeenCalled();
      });

      // C: 200 성공이 카운터 리셋하는지 검증 (fail,fail,success(200),fail,fail → 미발동)
      it('C: fail,fail,200,fail,fail (failCount=3) → 카운터 리셋으로 미발동', async () => {
        // fail, fail, success, fail, fail 시퀀스
        global.fetch = jest
          .fn()
          .mockResolvedValueOnce({ ok: false, status: 503 }) // 1: fail
          .mockResolvedValueOnce({ ok: false, status: 503 }) // 2: fail
          .mockResolvedValueOnce({ ok: true, status: 200 }) // 3: success → 카운터 리셋
          .mockResolvedValueOnce({ ok: false, status: 503 }) // 4: fail
          .mockResolvedValueOnce({ ok: false, status: 503 }); // 5: fail

        const groupId = 'grp-fail-c';

        svc.startProxyHealthPoll(groupId);

        // 5회 폴링 실행 — 3차 성공으로 카운터 리셋, 이후 2회 실패만 (< failCount=3)
        await jest.advanceTimersByTimeAsync(5000);

        // 미발동: getFailClosedNs undefined
        expect(svc.getFailClosedNs(groupId)).toBeUndefined();
        expect(mockUpdateMany).not.toHaveBeenCalled();
        expect(mockEmitToGroup).not.toHaveBeenCalled();
      });

      // E: 중첩 triggerFailClosed 호출 시 one-shot 보장 검증 (Fix 1 idempotency guard 회귀 가드)
      // 전략: tick3(count=3 threshold 도달)이 triggerFailClosed → await updateMany 중
      //       tick4(count=4, 4>=3)가 proxyHealthFailCounts 아직 살아있는 상태에서
      //       triggerFailClosed 재진입하는 상황을 재현함.
      //       핵심: tick3 resolve → microtask 1단계(count 읽기/set/emit/await updateMany 등록)
      //             → tick4 resolve → microtask(count 읽기 = 3이 아닌 3+1=4 >= 3 → 재진입)
      //       guard 없으면: emit/updateMany 2회. guard 있으면: 1회.
      it('E: slow-fetch overlapping ticks → emit/updateMany 각 exactly 1회 호출 (idempotency guard)', async () => {
        // Arrange: 모든 fetch Promise를 수동으로 제어 — tick마다 별도 resolver 보관
        const resolvers: Array<(v: { ok: boolean; status: number }) => void> =
          [];
        global.fetch = jest.fn().mockImplementation(() => {
          return new Promise<{ ok: boolean; status: number }>((resolve) => {
            resolvers.push(resolve);
          });
        });

        const groupId = 'grp-overlap-e';
        svc.startProxyHealthPoll(groupId);

        // sync timer 전진 — tick1~tick4 IIFE 시작, 각각 fetch await 에서 대기 중
        jest.advanceTimersByTime(4000);

        // tick1,tick2 순서 resolve: count=1,2 → threshold 미달
        resolvers[0]({ ok: false, status: 503 });
        await Promise.resolve();
        await Promise.resolve();
        resolvers[1]({ ok: false, status: 503 });
        await Promise.resolve();
        await Promise.resolve();

        // tick3 resolve → count=3 → triggerFailClosed 진입 → set+emit, await updateMany 시작
        // tick4 resolve → count 읽기: proxyHealthFailCounts.get 값은 3 (stopProxyHealthPoll 아직 미실행)
        //                → count=3+1=4 → 4>=3 → guard 없으면 triggerFailClosed 재진입
        // 두 resolve를 await 없이 연속 호출 → tick3 microtask와 tick4 microtask가 모두 큐에 쌓임
        resolvers[2]({ ok: false, status: 503 });
        resolvers[3]({ ok: false, status: 503 });

        // microtask 충분히 flush — tick3/tick4 async 연쇄 완료
        for (let i = 0; i < 10; i++) {
          await Promise.resolve();
        }

        // Assert: emit, updateMany 각 exactly 1회 — idempotency guard 동작 검증함
        expect(mockEmitToGroup).toHaveBeenCalledTimes(1);
        expect(mockUpdateMany).toHaveBeenCalledTimes(1);
        // getFailClosedNs bigint 반환 확인
        expect(typeof svc.getFailClosedNs(groupId)).toBe('bigint');
      });
    });

    // D: Stage-1 안전 보장 — proxyUrl 빈 값 시 fetch 미호출 (별도 describe — proxyUrl: '' 설정)
    describe('Stage-1 no-op (proxyUrl 빈 값)', () => {
      beforeEach(() => {
        // 외부 beforeEach에서 이미 proxyUrl: '' config + resetModules 완료됨
        // 별도 타이머 제어 없음 — 외부 beforeEach의 jest.useFakeTimers() 재사용
      });

      afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
      });

      it('D: config.proxyUrl === "" → fetch 미호출, 행위변경 없음 (Stage-1 be-mode)', async () => {
        const mockFetch = jest.fn();
        global.fetch = mockFetch;

        const groupId = 'grp-stage1-d';

        // startProxyHealthPoll 호출 — proxyUrl 빈 값이므로 no-op
        engineRegistryService.startProxyHealthPoll(groupId);

        // 타이머 전진 — fetch 미호출 확인
        await jest.advanceTimersByTimeAsync(5000);

        expect(mockFetch).not.toHaveBeenCalled();
        // 행위변경 없음: getFailClosedNs undefined
        expect(engineRegistryService.getFailClosedNs(groupId)).toBeUndefined();
      });
    });
  });
});
