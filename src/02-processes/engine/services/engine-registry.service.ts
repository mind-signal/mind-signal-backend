import { config } from '@07-shared/config/config';
import { AppError } from '@07-shared/errors';
import { Session } from '@06-entities/sessions';
import { SocketService } from '@07-shared/lib/socket';

// ===== legacy 단일 slot — 1PC / SEQUENTIAL 경로 호환 =====
// 메모리 저장소 (서버 재시작 시 파이썬 엔진이 재등록해야 함)
let registeredEngineUrl: string | null = null;

// ===== DUAL_2PC 전용 저장소 =====
/** groupId → (subjectIndex → EngineRegistration) 중첩 Map */
const dualRegistry = new Map<string, Map<number, EngineRegistration>>();

/** groupId → 등록 콜백 Set */
const registeredCallbacks = new Map<string, Set<() => void>>();

/** 단일 DE 등록 정보 */
interface EngineRegistration {
  url: string;
  subjectIndex: number;
  registeredAt: number;
}

// ===== Phase 17.6 — pending registry (LD-10) =====
/** subjectIndex → pending entry (groupId 미정 상태) */
interface PendingEntry {
  url: string;
  registeredAt: number;
}

const pendingRegistry = new Map<1 | 2, PendingEntry>();

/** group-level fail-closed ns 기록 — T1-BE-F가 채움, T1-BE-G gate가 조회함 */
const failClosedAtNsByGroup = new Map<string, bigint>();

// ===== T1-BE-F: proxy /health 폴링 fail-closed 프로듀서 =====
/** groupId → setInterval 핸들 — 폴링 인터벌 관리용 */
const proxyHealthIntervals = new Map<string, NodeJS.Timeout>();

/** groupId → 연속 실패 횟수 — fail-closed 임계값 비교용 */
const proxyHealthFailCounts = new Map<string, number>();

/**
 * fail-closed 발동 내부 헬퍼 — Map.set → emit → updateMany 순서로 처리함.
 * Map.set이 먼저 실행되어 emit/updateMany 오류 시에도 gate 보호됨.
 *
 * @param groupId - fail-closed 발동 대상 그룹 ID
 */
async function triggerFailClosed(groupId: string): Promise<void> {
  // 중복 발동 방지 — 이미 fail-closed set된 그룹은 재진입 차단함 (느린 fetch 중첩 tick 가드, T1-DE-C _fail_closed_triggered 패턴 정합)
  if (failClosedAtNsByGroup.has(groupId)) return;
  // Map.set 먼저 — emit/updateMany 오류에도 gate 보호됨
  failClosedAtNsByGroup.set(groupId, BigInt(Date.now()) * 1_000_000n);
  console.log(`proxy /health fail-closed 발동 완료: groupId=${groupId}`);

  try {
    // ADR-010 §D: dual-session-failed 이벤트 emit — measurement.service.ts L216 패턴 동일
    SocketService.emitToGroup(groupId, 'dual-session-failed', {
      groupId,
      error: 'proxy_health_fail_closed',
    });
  } catch (err) {
    console.error(
      `dual-session-failed emit 오류 처리함: groupId=${groupId}`,
      err
    );
  }

  try {
    // ADR-010 §D: 세션 CANCELLED 전이 — measurement.service.ts L221-224 패턴 동일
    await Session.updateMany(
      { groupId },
      { status: 'CANCELLED', stopReason: 'ProcessError' }
    );
  } catch (err) {
    console.error(
      `Session.updateMany CANCELLED 오류 처리함: groupId=${groupId}`,
      err
    );
  }
}

export const engineRegistryService = {
  // ===== 기존 메서드 — backward compat 유지 (engine-proxy.service.ts 5곳 호출 보존) =====

  /** 파이썬 엔진 URL 등록 및 secret_key 검증함 */
  register(engineUrl: string, secretKey: string): void {
    if (secretKey !== config.dataEngine.secretKey) {
      throw new AppError('유효하지 않은 시크릿 키입니다.', 403);
    }
    registeredEngineUrl = engineUrl;
    console.log(`파이썬 엔진 등록 완료: ${engineUrl}`);
  },

  /** 등록된 엔진 URL 반환함 */
  getEngineUrl(): string {
    if (!registeredEngineUrl) {
      throw new AppError('파이썬 데이터 엔진이 아직 등록되지 않았습니다.', 503);
    }
    return registeredEngineUrl;
  },

  /** 등록 상태 확인함 */
  isRegistered(): boolean {
    return registeredEngineUrl !== null;
  },

  // ===== 신규 메서드 — DUAL_2PC 전용 =====

  /**
   * DUAL_2PC 모드 전용 DE 등록 및 secret_key 검증함.
   *
   * @param groupId - 실험 그룹 ID
   * @param subjectIndex - 피실험자 순번 (1-based)
   * @param engineUrl - 등록할 엔진 URL
   * @param secretKey - 검증용 시크릿 키
   */
  registerDual(
    groupId: string,
    subjectIndex: number,
    engineUrl: string,
    secretKey: string
  ): void {
    if (secretKey !== config.dataEngine.secretKey) {
      throw new AppError('유효하지 않은 시크릿 키입니다.', 403);
    }

    if (!dualRegistry.has(groupId)) {
      dualRegistry.set(groupId, new Map());
    }

    const registration: EngineRegistration = {
      url: engineUrl,
      subjectIndex,
      registeredAt: Date.now(),
    };

    dualRegistry.get(groupId)!.set(subjectIndex, registration);
    console.log(
      `DUAL_2PC 엔진 등록 완료: groupId=${groupId}, subjectIndex=${subjectIndex}, url=${engineUrl}`
    );

    // 등록 콜백 전부 invoke — waitForBothEngines EventEmitter 패턴 지원
    registeredCallbacks.get(groupId)?.forEach((cb) => cb());

    // 양쪽 DE 등록 완료 시 proxy /health 폴링 시작함 (T1-BE-F)
    // poll 수명 ⊆ group 등록 수명 — cleanupGroup에서 stopProxyHealthPoll 짝 호출
    if (engineRegistryService.isFullyRegistered(groupId)) {
      engineRegistryService.startProxyHealthPoll(groupId);
    }
  },

  /**
   * groupId + subjectIndex로 등록된 엔진 URL 조회함.
   *
   * @param groupId - 실험 그룹 ID
   * @param subjectIndex - 피실험자 순번 (1-based)
   * @returns 등록된 엔진 URL
   * @throws AppError 503 — 해당 엔진 미등록 시
   */
  getEngineUrlByGroupSubject(groupId: string, subjectIndex: number): string {
    const registration = dualRegistry.get(groupId)?.get(subjectIndex);
    if (!registration) {
      throw new AppError(
        `DUAL_2PC 엔진 미등록: groupId=${groupId}, subjectIndex=${subjectIndex}`,
        503
      );
    }
    return registration.url;
  },

  /**
   * groupId에 등록된 전체 엔진 Map 반환함.
   *
   * @param groupId - 실험 그룹 ID
   * @returns (subjectIndex → EngineRegistration) Map 또는 undefined
   */
  getByGroup(groupId: string): Map<number, EngineRegistration> | undefined {
    return dualRegistry.get(groupId);
  },

  /**
   * groupId의 등록 엔진 수가 expectedCount에 도달했는지 확인함.
   *
   * @param groupId - 실험 그룹 ID
   * @param expectedCount - 기대 등록 수 (기본값 2)
   * @returns 등록 완료 여부
   */
  isFullyRegistered(groupId: string, expectedCount: number = 2): boolean {
    const group = dualRegistry.get(groupId);
    return !!group && group.size >= expectedCount;
  },

  /**
   * DUAL_2PC 등록 이벤트 구독함.
   * registerDual 호출 시 콜백을 invoke함.
   *
   * @param groupId - 실험 그룹 ID
   * @param callback - 등록 이벤트 발생 시 호출할 함수
   * @returns unsubscribe 함수 — Promise settle 후 반드시 호출해야 ghost 콜백 방지됨
   */
  onRegistered(groupId: string, callback: () => void): () => void {
    if (!registeredCallbacks.has(groupId)) {
      registeredCallbacks.set(groupId, new Set());
    }
    const callbacks = registeredCallbacks.get(groupId)!;
    callbacks.add(callback);

    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        registeredCallbacks.delete(groupId);
      }
    };
  },

  /**
   * groupId의 fail-closed 발동 ns 타임스탬프 조회함 (ADR §D).
   * T1-BE-F가 proxy /health 폴링 실패 시 set, 본 getter는 T1-BE-G 게이트가 조회함.
   *
   * @param groupId - 실험 그룹 ID
   * @returns fail-closed ns(bigint) 또는 미발동 시 undefined
   */
  getFailClosedNs(groupId: string): bigint | undefined {
    return failClosedAtNsByGroup.get(groupId);
  },

  /**
   * proxy /health 폴링을 시작함 (T1-BE-F ADR-010 §D 프로듀서).
   * config.proxyUrl 빈 값이면 no-op — Stage-1 be-mode 무행위변경 보장함.
   * 이미 폴링 중이면 idempotent 반환함.
   *
   * @param groupId - 폴링 대상 그룹 ID
   */
  startProxyHealthPoll(groupId: string): void {
    // Stage-1 안전 게이트 — proxyUrl 미설정 시 no-op (5/26 시연 / dev-only / ADR §E 회귀 보존)
    if (!config.proxyUrl) {
      return;
    }

    // 중복 폴링 방지 — idempotent
    if (proxyHealthIntervals.has(groupId)) {
      return;
    }

    // 연속 실패 카운터 초기화함
    proxyHealthFailCounts.set(groupId, 0);

    // setInterval 폴링 시작 — fetch 전역 함수 사용 (repo convention)
    const handle = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch(`${config.proxyUrl}/health`);
          if (res.ok) {
            // 성공: 카운터 리셋함
            proxyHealthFailCounts.set(groupId, 0);
          } else {
            // 비정상 HTTP 응답: 실패 카운터 증가 처리함
            const count = (proxyHealthFailCounts.get(groupId) ?? 0) + 1;
            proxyHealthFailCounts.set(groupId, count);
            if (count >= config.proxyHealth.failCount) {
              // 임계값 도달 — fail-closed 발동 후 폴링 중단 (one-shot 보장)
              await triggerFailClosed(groupId);
              engineRegistryService.stopProxyHealthPoll(groupId);
            }
          }
        } catch {
          // 네트워크/타임아웃 오류: 실패 카운터 증가 처리함
          const count = (proxyHealthFailCounts.get(groupId) ?? 0) + 1;
          proxyHealthFailCounts.set(groupId, count);
          if (count >= config.proxyHealth.failCount) {
            // 임계값 도달 — fail-closed 발동 후 폴링 중단 (one-shot 보장)
            await triggerFailClosed(groupId);
            engineRegistryService.stopProxyHealthPoll(groupId);
          }
        }
      })();
    }, config.proxyHealth.pollIntervalMs);

    // Node.js/Jest 프로세스 종료를 블록하지 않도록 unref 처리함 (repo 패턴 준수)
    handle.unref();
    proxyHealthIntervals.set(groupId, handle);
  },

  /**
   * proxy /health 폴링을 중단하고 관련 상태 제거함.
   * idempotent — 폴링 중이 아닐 때 호출해도 안전함.
   *
   * @param groupId - 폴링 중단 대상 그룹 ID
   */
  stopProxyHealthPoll(groupId: string): void {
    const handle = proxyHealthIntervals.get(groupId);
    if (handle !== undefined) {
      clearInterval(handle);
      proxyHealthIntervals.delete(groupId);
    }
    proxyHealthFailCounts.delete(groupId);
  },

  /**
   * groupId에 해당하는 DUAL_2PC 등록 데이터 및 콜백 전부 제거함.
   * stopMeasurement DUAL_2PC 분기에서 호출됨.
   *
   * @param groupId - 제거할 그룹 ID
   */
  cleanupGroup(groupId: string): void {
    // proxy /health 폴링 중단 및 상태 제거함
    engineRegistryService.stopProxyHealthPoll(groupId);
    dualRegistry.delete(groupId);
    registeredCallbacks.delete(groupId);
    // CX4-5: T1-BE-G가 추가한 failClosed Map의 소비 cleanup — T1-BE-F .set과 짝
    failClosedAtNsByGroup.delete(groupId);
    console.log(`DUAL_2PC 엔진 레지스트리 정리 완료: groupId=${groupId}`);
  },

  // ===== Phase 17.6 — pending registry 메서드 (LD-10, LD-16, LD-26) =====

  /**
   * DE startup 시 본인 ngrok/LAN URL을 BE에 사전 등록함.
   * groupId 미정 상태에서 호출됨 (assign-group 전).
   *
   * @param subjectIndex - 피실험자 순번 (1-based: 1 또는 2)
   * @param url - DE의 ngrok 또는 LAN URL
   * @param secretKey - 검증용 시크릿 키
   * @throws AppError 403 — secretKey 불일치 시
   */
  registerPending(subjectIndex: 1 | 2, url: string, secretKey: string): void {
    if (secretKey !== config.dataEngine.secretKey) {
      throw new AppError('유효하지 않은 시크릿 키입니다.', 403);
    }
    pendingRegistry.set(subjectIndex, { url, registeredAt: Date.now() });
    console.log(`pending 등록 완료: subjectIndex=${subjectIndex}, url=${url}`);
  },

  /**
   * pending 상태인 양쪽 DE 정보 반환함.
   *
   * @returns subjectIndex + url 배열 (최대 2개)
   */
  getPendingSubjects(): Array<{ subjectIndex: 1 | 2; url: string }> {
    const result: Array<{ subjectIndex: 1 | 2; url: string }> = [];
    for (const [subjectIndex, entry] of pendingRegistry.entries()) {
      result.push({ subjectIndex, url: entry.url });
    }
    return result;
  },

  /**
   * DE process 종료 시 pending entry 삭제함. 멱등 동작 보장.
   *
   * @param subjectIndex - 삭제할 피실험자 순번
   * @param url - 등록 시 사용한 URL (검증용)
   * @param secretKey - 검증용 시크릿 키
   * @throws AppError 403 — secretKey 불일치 시
   */
  unregisterPending(subjectIndex: 1 | 2, url: string, secretKey: string): void {
    if (secretKey !== config.dataEngine.secretKey) {
      throw new AppError('유효하지 않은 시크릿 키입니다.', 403);
    }
    const entry = pendingRegistry.get(subjectIndex);
    if (entry && entry.url === url) {
      pendingRegistry.delete(subjectIndex);
      console.log(`pending 삭제 완료: subjectIndex=${subjectIndex}`);
    }
    // entry 없으면 idempotent — 아무 동작 안 함
  },
};
