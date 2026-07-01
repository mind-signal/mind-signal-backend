import { config } from '@07-shared/config/config';
import { AppError } from '@07-shared/errors';

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
}

// ===== Phase 17.6 — pending registry (LD-10) =====
/** subjectIndex → pending entry (groupId 미정 상태) */
interface PendingEntry {
  url: string;
}

const pendingRegistry = new Map<1 | 2, PendingEntry>();

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
    };

    dualRegistry.get(groupId)!.set(subjectIndex, registration);
    console.log(
      `DUAL_2PC 엔진 등록 완료: groupId=${groupId}, subjectIndex=${subjectIndex}, url=${engineUrl}`
    );

    // 등록 콜백 전부 invoke — waitForBothEngines EventEmitter 패턴 지원
    registeredCallbacks.get(groupId)?.forEach((cb) => cb());
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
   * groupId에 해당하는 DUAL_2PC 등록 데이터 및 콜백 전부 제거함.
   * stopMeasurement DUAL_2PC 분기에서 호출됨.
   *
   * @param groupId - 제거할 그룹 ID
   */
  cleanupGroup(groupId: string): void {
    dualRegistry.delete(groupId);
    registeredCallbacks.delete(groupId);
    console.log(`DUAL_2PC 엔진 레지스트리 정리 완료: groupId=${groupId}`);
  },

  /**
   * 현재 dualRegistry에 등록된 모든 groupId + subjectIndex 스냅샷 반환함 (진단 대시보드용).
   *
   * @returns groupId별 등록된 subjectIndex 배열
   */
  getRegisteredGroups(): Array<{ groupId: string; subjects: number[] }> {
    const result: Array<{ groupId: string; subjects: number[] }> = [];
    for (const [gid, group] of dualRegistry.entries()) {
      result.push({ groupId: gid, subjects: [...group.keys()].sort() });
    }
    return result;
  },

  /**
   * 모든 DUAL_2PC 등록/pending/콜백 전부 제거함 — 비상 전체해제(대시보드)에서 호출됨.
   *
   * @returns 제거된 groupId 개수 + pending 개수
   */
  clearAll(): { clearedGroups: number; clearedPending: number } {
    const clearedGroups = dualRegistry.size;
    const clearedPending = pendingRegistry.size;
    dualRegistry.clear();
    registeredCallbacks.clear();
    pendingRegistry.clear();
    console.log(
      `DUAL_2PC 레지스트리 전체 클리어 완료: groups=${clearedGroups}, pending=${clearedPending}`
    );
    return { clearedGroups, clearedPending };
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
    pendingRegistry.set(subjectIndex, { url });

    // F4: DE 재시작(다른 url) 시 동일 subjectIndex의 옛 그룹 dualRegistry 배정 제거함.
    // 옛 배정 잔류가 그룹ID 표류를 유발함. proxy 모드 주기 재등록(동일 url)은
    // 라이브 배정을 보존하기 위해 url이 다를 때만 evict함 (D2 정합).
    for (const [gid, group] of dualRegistry.entries()) {
      const existing = group.get(subjectIndex);
      if (existing && existing.url !== url) {
        group.delete(subjectIndex);
        if (group.size === 0) {
          // cleanupGroup과 동일하게 콜백도 정리 — 재사용 groupId의 죽은 콜백 호출 방지함
          registeredCallbacks.delete(gid);
          dualRegistry.delete(gid);
        }
      }
    }

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
