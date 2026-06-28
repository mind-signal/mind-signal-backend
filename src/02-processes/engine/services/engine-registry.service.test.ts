/**
 * engine-registry.service.ts — Unit 테스트 (BE-5)
 *
 * 검증 항목:
 *   - 기존 getEngineUrl: 등록 전 → AppError 503, 등록 후 → URL 반환
 *   - registerDual + getEngineUrlByGroupSubject: 1-based subjectIndex
 *   - isFullyRegistered: 2개 등록 시 true, 1개만 등록 시 false
 *   - v8 M-1: getEngineUrlByGroupSubject(groupId, 1) → subject 1 URL 조회
 *   - cleanupGroup: 등록 데이터 제거 후 isFullyRegistered false
 */

// config 모킹 — 시크릿 키 주입
jest.mock('@07-shared/config/config', () => ({
  config: {
    dataEngine: { secretKey: 'valid-secret' },
    jwtSecret: { secret: 'test-secret', expiresIn: '1d' },
  },
}));

// engineRegistryService는 모듈 레벨 상태를 유지하므로 각 테스트 전 상태 초기화 필요
// jest.isolateModules로 독립 인스턴스 사용

describe('engineRegistryService — BE-5', () => {
  let engineRegistryService: typeof import('./engine-registry.service').engineRegistryService;

  beforeEach(() => {
    // 모듈 캐시를 초기화하여 모듈 레벨 상태(registeredEngineUrl, dualRegistry) 리셋함
    jest.resetModules();
    // config 모킹을 resetModules 후 재등록
    jest.mock('@07-shared/config/config', () => ({
      config: {
        dataEngine: { secretKey: 'valid-secret' },
        jwtSecret: { secret: 'test-secret', expiresIn: '1d' },
      },
    }));
    engineRegistryService =
      require('./engine-registry.service').engineRegistryService;
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
});
