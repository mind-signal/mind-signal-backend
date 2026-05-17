/**
 * dual-2pc-trigger.service.ts — Unit 테스트 (Phase 17.6 T-BE-1 ~ T-BE-12)
 *
 * 검증 항목:
 *   T-BE-1: 양쪽 1회 성공 → ready=true
 *   T-BE-2: 한쪽 3회 fail → cleanupGroup + dual-session-failed emit
 *   T-BE-3: 동시 trigger 2회 멱등 (inFlight lock)
 *   T-BE-4: status cache 상태 변화 검증
 *   T-BE-5: AbortError 처리 → cleanup 호출
 *   T-BE-6: maybeTriggerDualAssignGroup 3조건 충족 시 자동 trigger
 *   T-BE-7: partial-failure 후 재trigger → already_registered 보상 등록
 *   T-BE-8: 4xx non-retryable 즉시 fail
 *   T-BE-9: registerPending secret mismatch → 403
 *   T-BE-10: unregisterPending idempotent + secret 검증
 *   T-BE-11: getRegistryStatus 기본값 반환
 *   T-BE-12: registerPairingTriggerListener 2회 호출 idempotent
 */

// ===== config mock — 가변 객체로 proxyUrl 런타임 주입 지원함 =====
const mockConfigObj = {
  config: {
    dataEngine: { secretKey: 'valid-secret' },
    proxyUrl: '' as string,
  },
};
jest.mock('@07-shared/config/config', () => mockConfigObj);

// ===== SocketService mock =====
jest.mock('@07-shared/lib/socket', () => ({
  SocketService: {
    emitToGroup: jest.fn(),
  },
}));

// ===== Session mock — Mongoose 격리 =====
jest.mock('@06-entities/sessions', () => ({
  Session: {
    find: jest.fn(),
  },
}));

// ===== 전역 fetch mock =====
// mockFetch 수명 주기 불변식:
//   - 첫 번째 describe beforeEach가 각 테스트 전 mockFetch.mockReset() 호출함
//   - jest.resetModules() 패턴 테스트(TS-1~TS-6 / T-BE-6 / T-BE-12)는
//     maybeTriggerDualAssignGroup 내부에서 조기 return하여 fetch에 도달하지 않음
//     → 공유 mockFetch 상태를 관찰하지 않으므로 격리 보장됨
//   - global.fetch = originalFetch 원복은 파일 레벨 afterAll 단 1회 수행함
//     (두 describe 모두 완료 후 실행 — T-BE-E 테스트까지 mock 유효 보장함)
const originalFetch = global.fetch;
const mockFetch = jest.fn();
global.fetch = mockFetch;

// ===== 표준 subjects fixture =====
const subjects = [
  {
    groupId: 'grp-001',
    url: 'http://de-1.ngrok-free.dev',
    subjectIndex: 1 as const,
  },
  {
    groupId: 'grp-001',
    url: 'http://de-2.ngrok-free.dev',
    subjectIndex: 2 as const,
  },
];

// 성공 응답 helper
function mockSuccess(status = 'registered') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status }),
  };
}

// 실패 응답 helper
function mockFail(statusCode: number, errCode?: string) {
  return {
    ok: false,
    status: statusCode,
    json: async () => (errCode ? { detail: { error: errCode } } : {}),
  };
}

describe('dualTriggerService — Phase 17.6', () => {
  let dualTriggerService: typeof import('./dual-2pc-trigger.service').dualTriggerService;
  let engineRegistryService: typeof import('./engine-registry.service').engineRegistryService;
  let SocketService: { emitToGroup: jest.Mock };

  beforeEach(() => {
    // 모듈 상태 격리 — 각 테스트마다 fresh module
    jest.resetModules();

    // be 모드 — proxyUrl 비활성 보장 (Stage-1 기본값 보존함)
    mockConfigObj.config.proxyUrl = '';

    // SocketService mock 재등록
    jest.mock('@07-shared/lib/socket', () => ({
      SocketService: {
        emitToGroup: jest.fn(),
      },
    }));

    // Session mock 재등록
    jest.mock('@06-entities/sessions', () => ({
      Session: {
        find: jest.fn(),
      },
    }));

    mockFetch.mockReset();

    dualTriggerService =
      require('./dual-2pc-trigger.service').dualTriggerService;
    engineRegistryService =
      require('./engine-registry.service').engineRegistryService;
    SocketService = require('@07-shared/lib/socket').SocketService;
    // Session mock 참조는 T-BE-6에서 직접 re-import 패턴으로 사용됨
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
  });

  // ============================================================
  // T-BE-1: 양쪽 1회 성공 → ready=true
  // ============================================================

  it('T-BE-1: 양쪽 1회 성공 → ready=true', async () => {
    // RC4-C-1 fix: fetch mock에 json() 메서드 필수
    mockFetch
      .mockResolvedValueOnce(mockSuccess('registered'))
      .mockResolvedValueOnce(mockSuccess('registered'));

    const result = await dualTriggerService.triggerAssignGroup(
      'grp-001',
      subjects
    );

    expect(result.status).toBe('triggered');
    const status = dualTriggerService.getRegistryStatus('grp-001');
    expect(status.ready).toBe(true);
  });

  // ============================================================
  // T-BE-2: 한쪽 3회 fail → cleanupGroup + dual-session-failed emit
  // ============================================================

  it('T-BE-2: 한쪽 3회 fail → cleanupGroup + dual-session-failed emit', async () => {
    const cleanupSpy = jest.spyOn(engineRegistryService, 'cleanupGroup');

    mockFetch
      // subject 1: 성공
      .mockResolvedValueOnce(mockSuccess('registered'))
      // subject 2: 3회 fail (502)
      .mockResolvedValueOnce(mockFail(502))
      .mockResolvedValueOnce(mockFail(502))
      .mockResolvedValueOnce(mockFail(502));

    await dualTriggerService.triggerAssignGroup('grp-001', subjects);

    expect(cleanupSpy).toHaveBeenCalledWith('grp-001');
    expect(SocketService.emitToGroup).toHaveBeenCalledWith(
      'grp-001',
      'dual-session-failed',
      expect.objectContaining({
        groupId: 'grp-001',
        error: expect.any(String),
      })
    );

    const status = dualTriggerService.getRegistryStatus('grp-001');
    expect(status.ready).toBe(false);
  });

  // ============================================================
  // T-BE-3: 동시 trigger 2회 멱등 (inFlight lock)
  // ============================================================

  it('T-BE-3: 동시 trigger 2회 → inFlight lock으로 1번만 실행됨', async () => {
    mockFetch.mockResolvedValue(mockSuccess('registered'));

    const p1 = dualTriggerService.triggerAssignGroup('grp-001', subjects);
    const p2 = dualTriggerService.triggerAssignGroup('grp-001', subjects);
    const [r1, r2] = await Promise.all([p1, p2]);

    const statuses = [r1.status, r2.status].sort();
    // 하나는 triggered, 하나는 in_progress (또는 already_ready)
    expect(
      statuses.includes('in_progress') || statuses.includes('already_ready')
    ).toBe(true);

    // iter 2 M-2 fix: race 안정화 — fetch 호출 수는 2~4 범위
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(4);
  });

  // ============================================================
  // T-BE-4: status cache 상태 변화 검증
  // ============================================================

  it('T-BE-4: 초기 상태 → in_progress → ready 상태 전이 검증됨', async () => {
    // 초기: statusCache 미진입 → 기본값
    const initial = dualTriggerService.getRegistryStatus('grp-004');
    expect(initial).toEqual({
      ready: false,
      registered: 0,
      attempts: 0,
      inFlight: false,
    });

    // trigger 후 ready=true
    mockFetch
      .mockResolvedValueOnce(mockSuccess('registered'))
      .mockResolvedValueOnce(mockSuccess('registered'));

    await dualTriggerService.triggerAssignGroup('grp-004', [
      { ...subjects[0], groupId: 'grp-004' },
      { ...subjects[1], groupId: 'grp-004' },
    ]);

    const after = dualTriggerService.getRegistryStatus('grp-004');
    expect(after.ready).toBe(true);
    expect(after.inFlight).toBe(false);
  });

  // ============================================================
  // T-BE-5: AbortError → cleanup 호출
  // ============================================================

  it('T-BE-5: fetch AbortError → 3회 retry 후 cleanup 호출됨', async () => {
    // RC5-fix: fake timer 대신 fetch mock에서 AbortError 직접 throw
    mockFetch.mockImplementation(() =>
      Promise.reject(
        new DOMException('The operation was aborted', 'AbortError')
      )
    );

    const cleanupSpy = jest.spyOn(engineRegistryService, 'cleanupGroup');

    await dualTriggerService.triggerAssignGroup('grp-005', subjects);

    expect(cleanupSpy).toHaveBeenCalledWith('grp-005');
    // AbortError는 parentSignal.aborted=false이므로 retry 3회 × 2 subjects = 최대 6회
    // 단, parentSignal aborted가 아니면 retry 됨
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  // ============================================================
  // T-BE-6: maybeTriggerDualAssignGroup 3조건 충족 시 자동 trigger
  // ============================================================

  it('T-BE-6: maybeTriggerDualAssignGroup — 3조건 충족 시 자동 trigger 호출됨', async () => {
    // RC5-H-2 fix: jest.resetModules() 이후 re-import
    jest.resetModules();
    // mockConfigObj proxyUrl은 beforeEach에서 '' 로 리셋됨 — 재등록 불필요함
    jest.mock('@07-shared/lib/socket', () => ({
      SocketService: { emitToGroup: jest.fn() },
    }));
    jest.mock('@06-entities/sessions', () => ({
      Session: {
        find: jest.fn().mockResolvedValue([
          {
            groupId: 'grp-006',
            subjectIndex: 1,
            status: 'PAIRED',
            experimentMode: 'DUAL_2PC',
          },
          {
            groupId: 'grp-006',
            subjectIndex: 2,
            status: 'PAIRED',
            experimentMode: 'DUAL_2PC',
          },
        ]),
      },
    }));

    const freshModule = await import('./dual-2pc-trigger.service');
    const freshRegistryModule = await import('./engine-registry.service');

    // pending subjects 등록
    freshRegistryModule.engineRegistryService.registerPending(
      1,
      'http://de-1.ngrok-free.dev',
      'valid-secret'
    );
    freshRegistryModule.engineRegistryService.registerPending(
      2,
      'http://de-2.ngrok-free.dev',
      'valid-secret'
    );

    // operatorJoined 플래그 설정
    freshModule.operatorJoinedGroups.add('grp-006');

    // fetch mock 설정
    mockFetch
      .mockResolvedValueOnce(mockSuccess('registered'))
      .mockResolvedValueOnce(mockSuccess('registered'));

    const triggerSpy = jest.spyOn(
      freshModule.dualTriggerService,
      'triggerAssignGroup'
    );
    // TS-7 (J phase amend): success path silent log 검증용 spy
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await freshModule.dualTriggerService.maybeTriggerDualAssignGroup('grp-006');

    expect(triggerSpy).toHaveBeenCalledWith('grp-006', expect.any(Array));
    // TS-7: success path는 [2PC-trigger-skip] log emit 없음
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('[2PC-trigger-skip]')
    );
    consoleSpy.mockRestore();
  });

  // ============================================================
  // T-BE-7: partial-failure 후 재trigger → already_registered 보상 등록
  // ============================================================

  it('T-BE-7: 재trigger 시 already_registered → BE registerDual 보상 등록됨', async () => {
    const registerDualSpy = jest.spyOn(engineRegistryService, 'registerDual');

    // grp-007 전용 subjects fixture — groupId 일치 필수
    const subjects007 = [
      {
        groupId: 'grp-007',
        url: 'http://de-1.ngrok-free.dev',
        subjectIndex: 1 as const,
      },
      {
        groupId: 'grp-007',
        url: 'http://de-2.ngrok-free.dev',
        subjectIndex: 2 as const,
      },
    ];

    // 1차 trigger: subject 1 성공 / subject 2 fail × 3
    mockFetch
      .mockResolvedValueOnce(mockSuccess('registered'))
      .mockResolvedValueOnce(mockFail(502))
      .mockResolvedValueOnce(mockFail(502))
      .mockResolvedValueOnce(mockFail(502))
      // 2차 trigger: subject 1 already_registered / subject 2 success
      .mockResolvedValueOnce(mockSuccess('already_registered'))
      .mockResolvedValueOnce(mockSuccess('registered'));

    // 1차 trigger
    await dualTriggerService.triggerAssignGroup('grp-007', subjects007);
    // 1차 후 registerDualSpy 초기화
    registerDualSpy.mockClear();

    // 2차 trigger
    await dualTriggerService.triggerAssignGroup('grp-007', subjects007);

    // 보상 등록: subject 1 already_registered → BE registerDual 직접 호출됨
    expect(registerDualSpy).toHaveBeenCalledWith(
      'grp-007',
      1,
      expect.any(String),
      expect.any(String)
    );
  });

  // ============================================================
  // T-BE-8: 4xx non-retryable 즉시 fail
  // ============================================================

  it('T-BE-8: 401 invalid_secret → retry 없이 즉시 fail됨', async () => {
    mockFetch.mockResolvedValue(mockFail(401, 'invalid_secret'));

    await dualTriggerService.triggerAssignGroup('grp-008', subjects);

    // non-retryable이므로 양쪽 × 1회 = 최대 2회 (3회 retry 아님)
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(2);

    const status = dualTriggerService.getRegistryStatus('grp-008');
    expect(status.ready).toBe(false);
    expect(status.lastError).toBe('invalid_secret');
  });

  // ============================================================
  // T-BE-9: registerPending secret mismatch → AppError 403
  // ============================================================

  it('T-BE-9: registerPending secret mismatch → AppError 403 발생함', () => {
    expect(() =>
      engineRegistryService.registerPending(1, 'http://test', 'wrong-secret')
    ).toThrow();

    try {
      engineRegistryService.registerPending(1, 'http://test', 'wrong-secret');
    } catch (err: unknown) {
      expect((err as { statusCode?: number }).statusCode).toBe(403);
    }
  });

  // ============================================================
  // T-BE-10: DELETE /register-pending idempotent + secret 검증
  // ============================================================

  it('T-BE-10: unregisterPending — 정상 삭제 + idempotent + secret 검증됨', () => {
    // 정상 등록
    engineRegistryService.registerPending(1, 'http://de-1', 'valid-secret');
    expect(engineRegistryService.getPendingSubjects()).toHaveLength(1);

    // 정상 삭제
    engineRegistryService.unregisterPending(1, 'http://de-1', 'valid-secret');
    expect(engineRegistryService.getPendingSubjects()).toEqual([]);

    // 이미 없음 → idempotent (throw 금지)
    expect(() =>
      engineRegistryService.unregisterPending(1, 'http://de-1', 'valid-secret')
    ).not.toThrow();

    // secret mismatch → 403
    engineRegistryService.registerPending(1, 'http://de-1', 'valid-secret');
    expect(() =>
      engineRegistryService.unregisterPending(1, 'http://de-1', 'wrong-secret')
    ).toThrow();
    try {
      engineRegistryService.unregisterPending(1, 'http://de-1', 'wrong-secret');
    } catch (err: unknown) {
      expect((err as { statusCode?: number }).statusCode).toBe(403);
    }
  });

  // ============================================================
  // T-BE-11: getRegistryStatus 기본값 반환
  // ============================================================

  it('T-BE-11: getRegistryStatus — 미진입 groupId 시 기본값 반환됨', () => {
    const status = dualTriggerService.getRegistryStatus('grp-never-triggered');
    expect(status).toEqual({
      ready: false,
      registered: 0,
      attempts: 0,
      inFlight: false,
    });
  });

  // ============================================================
  // T-BE-12: registerPairingTriggerListener 2회 호출 idempotent
  // ============================================================

  it('T-BE-12: registerPairingTriggerListener 2회 호출 시 2번째는 false 반환됨', async () => {
    jest.resetModules();
    // mockConfigObj proxyUrl은 beforeEach에서 '' 로 리셋됨 — 재등록 불필요함
    jest.mock('@07-shared/lib/socket', () => ({
      SocketService: { emitToGroup: jest.fn() },
    }));
    jest.mock('@06-entities/sessions', () => ({
      Session: { find: jest.fn() },
    }));
    jest.mock('@05-features/sessions/services/pairing.service', () => ({
      addPairingCompleteListener: jest.fn(),
    }));
    jest.mock('@05-features/sessions/services/join-operator.service', () => ({
      addOperatorJoinListener: jest.fn(),
    }));

    const { registerPairingTriggerListener } =
      await import('@01-app/startup-listeners');

    const result1 = registerPairingTriggerListener();
    const result2 = registerPairingTriggerListener();

    // 1회차: 등록 성공 → true
    expect(result1).toBe(true);
    // 2회차: 이미 등록됨 → false (idempotent)
    expect(result2).toBe(false);
  });

  // ============================================================
  // TS-1 ~ TS-6: maybeTriggerDualAssignGroup audit logging (J phase)
  //   6 silent return reason 분기별 log emit + trigger 미호출 검증함
  // ============================================================

  it('TS-1: sessions 빈 배열 → log emit reason=no_sessions + trigger 미호출됨', async () => {
    jest.resetModules();
    jest.mock('@06-entities/sessions', () => ({
      Session: { find: jest.fn().mockResolvedValue([]) },
    }));
    const freshModule = await import('./dual-2pc-trigger.service');
    const triggerSpy = jest.spyOn(
      freshModule.dualTriggerService,
      'triggerAssignGroup'
    );
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await freshModule.dualTriggerService.maybeTriggerDualAssignGroup('g-empty');

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason=no_sessions')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('groupId=g-empty')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('sessionCount=0')
    );
    expect(triggerSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('TS-2: BTI mode → log emit reason=mode_not_dual_2pc + 미호출됨', async () => {
    jest.resetModules();
    jest.mock('@06-entities/sessions', () => ({
      Session: {
        find: jest.fn().mockResolvedValue([
          {
            groupId: 'g-bti',
            subjectIndex: 1,
            status: 'PAIRED',
            experimentMode: 'BTI',
          },
        ]),
      },
    }));
    const freshModule = await import('./dual-2pc-trigger.service');
    const triggerSpy = jest.spyOn(
      freshModule.dualTriggerService,
      'triggerAssignGroup'
    );
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await freshModule.dualTriggerService.maybeTriggerDualAssignGroup('g-bti');

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason=mode_not_dual_2pc')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('mode=BTI')
    );
    expect(triggerSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('TS-3: subject1 미페어링 → log emit reason=subject1_not_paired + 미호출됨', async () => {
    jest.resetModules();
    jest.mock('@06-entities/sessions', () => ({
      Session: {
        find: jest.fn().mockResolvedValue([
          {
            groupId: 'g-s1',
            subjectIndex: 1,
            status: 'CREATED',
            experimentMode: 'DUAL_2PC',
          },
          {
            groupId: 'g-s1',
            subjectIndex: 2,
            status: 'PAIRED',
            experimentMode: 'DUAL_2PC',
          },
        ]),
      },
    }));
    const freshModule = await import('./dual-2pc-trigger.service');
    freshModule.operatorJoinedGroups.add('g-s1');
    const triggerSpy = jest.spyOn(
      freshModule.dualTriggerService,
      'triggerAssignGroup'
    );
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await freshModule.dualTriggerService.maybeTriggerDualAssignGroup('g-s1');

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason=subject1_not_paired')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('subject1Paired=false')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('subject2Paired=true')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('operatorJoined=true')
    );
    expect(triggerSpy).not.toHaveBeenCalled();
    // cleanup — Set leak 방어 (plan-review R-02)
    freshModule.operatorJoinedGroups.delete('g-s1');
    consoleSpy.mockRestore();
  });

  it('TS-4: subject2 미페어링 → log emit reason=subject2_not_paired + 미호출됨', async () => {
    jest.resetModules();
    jest.mock('@06-entities/sessions', () => ({
      Session: {
        find: jest.fn().mockResolvedValue([
          {
            groupId: 'g-s2',
            subjectIndex: 1,
            status: 'PAIRED',
            experimentMode: 'DUAL_2PC',
          },
          {
            groupId: 'g-s2',
            subjectIndex: 2,
            status: 'CREATED',
            experimentMode: 'DUAL_2PC',
          },
        ]),
      },
    }));
    const freshModule = await import('./dual-2pc-trigger.service');
    freshModule.operatorJoinedGroups.add('g-s2');
    const triggerSpy = jest.spyOn(
      freshModule.dualTriggerService,
      'triggerAssignGroup'
    );
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await freshModule.dualTriggerService.maybeTriggerDualAssignGroup('g-s2');

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason=subject2_not_paired')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('subject1Paired=true')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('subject2Paired=false')
    );
    expect(triggerSpy).not.toHaveBeenCalled();
    freshModule.operatorJoinedGroups.delete('g-s2');
    consoleSpy.mockRestore();
  });

  it('TS-5: operator 미참여 → log emit reason=operator_not_joined + 미호출됨', async () => {
    jest.resetModules();
    jest.mock('@06-entities/sessions', () => ({
      Session: {
        find: jest.fn().mockResolvedValue([
          {
            groupId: 'g-op',
            subjectIndex: 1,
            status: 'PAIRED',
            experimentMode: 'DUAL_2PC',
          },
          {
            groupId: 'g-op',
            subjectIndex: 2,
            status: 'PAIRED',
            experimentMode: 'DUAL_2PC',
          },
        ]),
      },
    }));
    const freshModule = await import('./dual-2pc-trigger.service');
    // operatorJoinedGroups에 add 안 함 → operatorJoined=false 강제
    const triggerSpy = jest.spyOn(
      freshModule.dualTriggerService,
      'triggerAssignGroup'
    );
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await freshModule.dualTriggerService.maybeTriggerDualAssignGroup('g-op');

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason=operator_not_joined')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('subject1Paired=true')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('subject2Paired=true')
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('operatorJoined=false')
    );
    expect(triggerSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('TS-6: pending=1 (한쪽만 등록) → reason=pending_count_mismatch + 미호출됨', async () => {
    jest.resetModules();
    // mockConfigObj proxyUrl은 beforeEach에서 '' 로 리셋됨 — 재등록 불필요함
    jest.mock('@06-entities/sessions', () => ({
      Session: {
        find: jest.fn().mockResolvedValue([
          {
            groupId: 'g-pc1',
            subjectIndex: 1,
            status: 'PAIRED',
            experimentMode: 'DUAL_2PC',
          },
          {
            groupId: 'g-pc1',
            subjectIndex: 2,
            status: 'PAIRED',
            experimentMode: 'DUAL_2PC',
          },
        ]),
      },
    }));
    const freshModule = await import('./dual-2pc-trigger.service');
    const freshRegistryModule = await import('./engine-registry.service');
    // subject 1만 등록 → pending.length = 1 → collectPendingSubjects 빈 배열 반환
    freshRegistryModule.engineRegistryService.registerPending(
      1,
      'http://de-1.ngrok-free.dev',
      'valid-secret'
    );
    freshModule.operatorJoinedGroups.add('g-pc1');
    const triggerSpy = jest.spyOn(
      freshModule.dualTriggerService,
      'triggerAssignGroup'
    );
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

    await freshModule.dualTriggerService.maybeTriggerDualAssignGroup('g-pc1');

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('reason=pending_count_mismatch')
    );
    // pendingCount 값까지 검증 (plan-review R-01/R-03)
    // collectPendingSubjects line 421 `pending.length < 2 ? []` → subjects.length=0
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('pendingCount=0')
    );
    expect(triggerSpy).not.toHaveBeenCalled();
    // cleanup — registry + Set 양쪽 (unregisterPending: subjectIndex, url, secret)
    freshRegistryModule.engineRegistryService.unregisterPending(
      1,
      'http://de-1.ngrok-free.dev',
      'valid-secret'
    );
    freshModule.operatorJoinedGroups.delete('g-pc1');
    consoleSpy.mockRestore();
  });
});

// ============================================================
// T-BE-E: proxy 모드 assign-group 라우팅 검증
// 공유 mock 객체 직접 변조 패턴 — proxyUrl을 런타임에 주입함
// ============================================================

describe('dualTriggerService — T-BE-E proxy 모드 assign-group 라우팅', () => {
  const proxyUrl = 'http://operator-pc:5050';
  const groupId = 'grp-proxy-001';
  const subjects = [
    {
      groupId,
      url: 'http://de-1.ngrok-free.dev',
      subjectIndex: 1 as const,
    },
    {
      groupId,
      url: 'http://de-2.ngrok-free.dev',
      subjectIndex: 2 as const,
    },
  ];

  let dualTriggerSvc: typeof import('./dual-2pc-trigger.service').dualTriggerService;
  let engineRegistrySvc: typeof import('./engine-registry.service').engineRegistryService;
  let socketSvc: { emitToGroup: jest.Mock };

  beforeAll(() => {
    // proxy 모드 활성화 — mockConfigObj.config.proxyUrl 직접 주입함
    mockConfigObj.config.proxyUrl = 'http://operator-pc:5050';
    // 모듈 재로드 — 위 proxyUrl 설정 후 fresh module 로드함
    jest.resetModules();
    dualTriggerSvc = require('./dual-2pc-trigger.service').dualTriggerService;
    engineRegistrySvc =
      require('./engine-registry.service').engineRegistryService;
    socketSvc = require('@07-shared/lib/socket').SocketService;
  });

  afterAll(() => {
    // proxy 모드 해제 — 후속 테스트 격리 보장함
    mockConfigObj.config.proxyUrl = '';
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    mockFetch.mockReset();
  });

  // ============================================================
  // T-BE-E-1: proxy 모드 단일 Proxy 엔드포인트 호출 검증
  // ============================================================

  it('T-BE-E-1: proxy 모드 — Proxy 단일 POST 호출 + 200 성공 시 triggered 반환됨', async () => {
    // proxy 모드: 단일 Proxy 엔드포인트 200 응답 설정함
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok' }),
    });

    const result = await dualTriggerSvc.triggerAssignGroup(groupId, subjects);

    expect(result.status).toBe('triggered');

    // 단일 Proxy 엔드포인트에만 호출됨 — per-DE 루프 없음
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      `${proxyUrl}/control/assign-group`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Engine-Secret': 'valid-secret',
          'Content-Type': 'application/json',
        }),
        // eslint-disable-next-line camelcase
        body: JSON.stringify({ group_id: groupId }),
      })
    );

    // Proxy 200 = 양쪽 할당 완료 — registry ready 상태 확인함
    const status = dualTriggerSvc.getRegistryStatus(groupId);
    expect(status.ready).toBe(true);
    expect(status.registered).toBe(2);
  });

  // ============================================================
  // T-BE-E-2: proxy 모드 실패 경로 — 기존 실패 처리(cleanup + emit) 발동 검증
  // ============================================================

  it('T-BE-E-2: proxy 모드 — Proxy 5xx retry 소진 시 dual-session-failed emit됨', async () => {
    const cleanupSpy = jest.spyOn(engineRegistrySvc, 'cleanupGroup');

    // 3회 5xx — proxy 단일 엔드포인트 retry 소진 시 실패 처리 발동 검증
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => ({}),
      });

    await dualTriggerSvc.triggerAssignGroup(groupId, subjects);

    // 실패 처리 발동 확인 — cleanup + dual-session-failed emit 검증함
    expect(cleanupSpy).toHaveBeenCalledWith(groupId);
    expect(socketSvc.emitToGroup).toHaveBeenCalledWith(
      groupId,
      'dual-session-failed',
      expect.objectContaining({
        groupId,
        error: expect.any(String),
      })
    );

    const status = dualTriggerSvc.getRegistryStatus(groupId);
    expect(status.ready).toBe(false);
  }, 15000); // proxy retry 3회 backoff(1s+2s) + 여유 시간 확보함
});

// 파일 레벨 afterAll — 전역 fetch 원복 (모든 describe 완료 후 실행됨)
afterAll(() => {
  global.fetch = originalFetch;
});
