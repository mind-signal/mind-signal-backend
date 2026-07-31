/**
 * Phase 17.6 — DUAL_2PC trigger gap hotfix
 *
 * 3-condition AND 충족 시 양쪽 DE에 /control/assign-group POST 호출함.
 * 멱등 lock + status cache + abort signal + exponential backoff retry 구현함.
 */

import { Session } from '@06-entities/sessions';
import { config } from '@07-shared/config/config';
import { SocketService } from '@07-shared/lib/socket';
import { engineRegistryService } from './engine-registry.service';

// ===== 공개 인터페이스 타입 =====

/** FE polling 용 registry 상태 snapshot */
export interface RegistryStatus {
  ready: boolean;
  registered: 0 | 1 | 2;
  attempts: number;
  inFlight: boolean;
  lastError?:
    | 'subject_1_failed'
    | 'subject_2_failed'
    | 'both_failed'
    | 'invalid_secret'
    | 'not_pending_mode'
    | 'group_id_conflict';
  startedAt?: number;
  finishedAt?: number;
}

/** DE pending 정보 — groupId + url + subjectIndex 묶음 (모듈 내부 전용) */
interface DePendingInfo {
  groupId: string;
  url: string;
  subjectIndex: 1 | 2;
}

/** dualTriggerService API 형태 — 모듈 내부 타입 가드 전용 (외부 import 없음) */
interface DualTriggerService {
  /**
   * 양쪽 DE에 /control/assign-group POST 호출함.
   * Promise.allSettled + 3회 retry exponential backoff 적용함.
   * 멱등: inFlight.has(groupId) 시 즉시 in_progress 반환함.
   *
   * @param groupId - 실험 그룹 ID
   * @param subjects - DePendingInfo 배열 (subjectIndex 1, 2 각각)
   * @returns 트리거 결과 status
   */
  triggerAssignGroup(
    groupId: string,
    subjects: DePendingInfo[]
  ): Promise<{ status: 'triggered' | 'in_progress' | 'already_ready' }>;

  /**
   * registry 상태 snapshot 반환함 (FE polling 용).
   * statusCache 미진입 groupId 시 기본값 반환함 (RC5-M-1 fix).
   *
   * @param groupId - 조회 대상 그룹 ID
   * @returns RegistryStatus — 기본값 ready=false, registered=0
   */
  getRegistryStatus(groupId: string): RegistryStatus;

  /**
   * 실험 시작 직전 status cache invalidate + 진행 중 retry abort 처리함.
   *
   * @param groupId - 초기화 대상 그룹 ID
   */
  resetStatus(groupId: string): void;

  /**
   * pending registry 조회 후 DePendingInfo[] 반환함.
   * 양쪽 DE 모두 pending 상태가 아니면 빈 배열 반환함 (LD-13).
   *
   * @param groupId - 트리거 대상 groupId (각 entry에 attach됨)
   * @returns subjectIndex 1, 2 둘 다 pending 시 길이 2 배열
   */
  collectPendingSubjects(groupId: string): Promise<DePendingInfo[]>;

  /**
   * 페어링 + operator-join 3-condition 체크 후 자동 trigger 시도함.
   * pairing listener / operator-join listener 에서 호출됨 (LD-12 대안 D).
   *
   * @param groupId - 체크 대상 groupId
   */
  maybeTriggerDualAssignGroup(groupId: string): Promise<void>;
}

// ===== 모듈 레벨 상태 =====

/** 현재 trigger 진행 중인 groupId Set — 멱등 lock (LD-5) */
export const inFlight = new Set<string>();

/** stale lock 안전 장치 타이머 Map */
export const inFlightTimeouts = new Map<string, NodeJS.Timeout>();

/** 진행 중 retry abort controller Map (LD-19 resetStatus 지원) */
export const inFlightControllers = new Map<string, AbortController>();

/** status GC 타이머 Map (LD-6 30분 idle GC) */
export const gcTimeouts = new Map<string, NodeJS.Timeout>();

/** groupId → RegistryStatus 캐시 (LD-6) */
export const statusCache = new Map<string, RegistryStatus>();

/** operator-join 완료 그룹 Set — BE 메모리 저장 (LD-11) */
export const operatorJoinedGroups = new Set<string>();

// ===== 상수 =====

/** stale lock 자동 해제 시간 ms (retry worst 31s + buffer) */
const STALE_LOCK_MS = 60_000;

/** status cache 자동 GC 시간 ms (30분) */
const STATUS_GC_MS = 30 * 60_000;

/** retry 기본 delay ms */
const RETRY_BASE_MS = 1000;

/** retry delay 상한 ms */
const RETRY_CAP_MS = 8000;

/** retry 횟수 */
const RETRY_COUNT = 3;

/** per-attempt fetch timeout ms */
const PER_ATTEMPT_TIMEOUT_MS = 8000;

// ===== module-internal 에러 클래스 (LD-14, RC5-H-1 fix) =====

/** 4xx non-retryable 에러 — retry 없이 즉시 fail 처리됨 */
class NonRetryableError extends Error {
  public readonly isOperational = true;

  constructor(
    public errCode: string,
    public httpStatus: number
  ) {
    super(`DE ${httpStatus}: ${errCode}`);
    this.name = 'NonRetryableError';
  }
}

/** 409 conflict 에러 — DE 재시작 필요 (LD-14) */
class ConflictError extends Error {
  public readonly isOperational = true;

  constructor(
    public errCode: string,
    public currentGroupId?: string
  ) {
    super(`DE_CONFLICT:${errCode}:${currentGroupId}`);
    this.name = 'ConflictError';
  }
}

// ===== 내부 헬퍼 =====

/**
 * 단일 DE에 /control/assign-group POST 호출 + 3회 retry 처리함.
 * LD-14 분기: 4xx non-retryable, 5xx retryable, 200 already_registered 보상 등록함.
 *
 * @param s - DePendingInfo (groupId, url, subjectIndex)
 * @param parentSignal - inFlightControllers abort signal (LD-24)
 */
async function callWithRetry(
  s: DePendingInfo,
  parentSignal: AbortSignal
): Promise<void> {
  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    // attempts 카운터 증가 (statusCache 반드시 존재 — triggerAssignGroup에서 초기화됨)
    const cached = statusCache.get(s.groupId);
    if (cached) cached.attempts++;

    try {
      // per-attempt timeout + parent abort 결합 (LD-19, LD-21 — Node 20.3+ 필요)
      const signal = AbortSignal.any([
        parentSignal,
        AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_MS),
      ]);

      const res = await fetch(`${s.url}/control/assign-group`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Engine-Secret': config.dataEngine.secretKey,
        },
        // eslint-disable-next-line camelcase
        body: JSON.stringify({ group_id: s.groupId }),
        signal,
      });

      const data = await res.json().catch(() => ({}));

      // ===== 200 OK 분기 =====
      if (res.ok) {
        // LD-15 보상 경로: already_registered 시 BE가 직접 registerDual 호출함
        if (
          (data as Record<string, unknown>)?.status === 'already_registered'
        ) {
          engineRegistryService.registerDual(
            s.groupId,
            s.subjectIndex,
            s.url,
            config.dataEngine.secretKey
          );
          console.log(
            `[보상 등록] DE already_registered → BE registerDual: subject=${s.subjectIndex}`
          );
        }
        return; // success (registered 또는 already_registered 보상 모두 정상 처리됨)
      }

      // ===== 비-200 분기: LD-14 분류 처리 =====
      const errBody = data as Record<string, unknown>;
      const errCode =
        (errBody?.detail as Record<string, unknown>)?.error ?? 'unknown';

      // 401 invalid_secret / 400 not_pending_mode → non-retryable, 즉시 throw
      if (res.status === 401 || res.status === 400) {
        throw new NonRetryableError(String(errCode), res.status);
      }
      // 409 group_id_conflict → non-retryable, 복구 안내 (DE 재시작 필요)
      if (res.status === 409) {
        const current =
          (errBody?.detail as Record<string, unknown>)?.current ?? undefined;
        throw new ConflictError(
          String(errCode),
          current !== undefined ? String(current) : undefined
        );
      }
      // 502 backend_register_failed / 5xx 기타 → retryable
      throw new Error(`DE ${res.status}: ${JSON.stringify(data)}`);
    } catch (err) {
      // NonRetryableError / ConflictError → retry 안 함, 즉시 상위로 전파
      if (err instanceof NonRetryableError || err instanceof ConflictError) {
        throw err;
      }
      // AbortError (parent abort) → 즉시 전파, retry 안 함
      if ((err as Error).name === 'AbortError' && parentSignal.aborted) {
        throw err;
      }
      // 마지막 attempt → 전파
      if (attempt === RETRY_COUNT) throw err;
      // backoff 후 재시도
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_CAP_MS);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ===== 공개 서비스 객체 =====

export const dualTriggerService: DualTriggerService = {
  async triggerAssignGroup(groupId, subjects) {
    // 1. 멱등 guard — inFlight 중복 방지 (LD-5)
    if (inFlight.has(groupId)) return { status: 'in_progress' };
    // 1b. 이미 양쪽 등록 완료 guard
    if (engineRegistryService.isFullyRegistered(groupId, 2)) {
      return { status: 'already_ready' };
    }

    // 2. lock + abort controller + stale timeout (LD-19)
    inFlight.add(groupId);
    const controller = new AbortController();
    inFlightControllers.set(groupId, controller);

    const staleLockTimer = setTimeout(() => {
      // stale lock 강제 해제
      controller.abort();
      inFlightControllers.delete(groupId);
      inFlight.delete(groupId);
      inFlightTimeouts.delete(groupId);
    }, STALE_LOCK_MS);
    // process 종료 시 타이머가 Node를 block하지 않도록 unref 적용함
    staleLockTimer.unref();
    inFlightTimeouts.set(groupId, staleLockTimer);

    // 초기 status 설정
    statusCache.set(groupId, {
      ready: false,
      registered: 0,
      attempts: 0,
      inFlight: true,
      startedAt: Date.now(),
    });

    try {
      // 3. Promise.allSettled — 부분 성공 처리 (LD-3, LD-24)
      const results = await Promise.allSettled(
        subjects.map((s) => callWithRetry(s, controller.signal))
      );

      const successCount = results.filter(
        (r) => r.status === 'fulfilled'
      ).length;
      const fail1 = results[0]?.status === 'rejected';
      const fail2 = results[1]?.status === 'rejected';

      // 4. 결과 분기
      if (successCount === subjects.length && subjects.length > 0) {
        statusCache.set(groupId, {
          ...statusCache.get(groupId)!,
          ready: true,
          registered: 2,
          inFlight: false,
          finishedAt: Date.now(),
        });
        return { status: 'triggered' };
      }

      // 5. 부분 또는 전체 실패 → cleanup + emit (LD-4, LD-28)
      engineRegistryService.cleanupGroup(groupId);

      // lastError 결정: LD-14 NonRetryableError/ConflictError errCode 우선 사용
      let lastError: RegistryStatus['lastError'];
      const rej0 = results[0] as PromiseRejectedResult | undefined;
      const rej1 = results[1] as PromiseRejectedResult | undefined;
      const e0 = rej0?.reason;
      const e1 = rej1?.reason;

      if (fail1 && fail2) {
        // NonRetryableError가 있으면 구체 errCode 우선 사용 (LD-14)
        if (e0 instanceof NonRetryableError || e0 instanceof ConflictError) {
          lastError = e0.errCode as RegistryStatus['lastError'];
        } else if (
          e1 instanceof NonRetryableError ||
          e1 instanceof ConflictError
        ) {
          lastError = e1.errCode as RegistryStatus['lastError'];
        } else {
          lastError = 'both_failed';
        }
      } else if (fail1) {
        if (e0 instanceof NonRetryableError || e0 instanceof ConflictError) {
          lastError = e0.errCode as RegistryStatus['lastError'];
        } else {
          lastError = 'subject_1_failed';
        }
      } else {
        if (e1 instanceof NonRetryableError || e1 instanceof ConflictError) {
          lastError = e1.errCode as RegistryStatus['lastError'];
        } else {
          lastError = 'subject_2_failed';
        }
      }

      statusCache.set(groupId, {
        ...statusCache.get(groupId)!,
        ready: false,
        registered: 0,
        inFlight: false,
        lastError,
        finishedAt: Date.now(),
      });

      // 실패 socket emit — best-effort 보조 (LD-8, LD-28)
      SocketService.emitToGroup(groupId, 'dual-session-failed', {
        groupId,
        error: lastError ?? 'both_failed',
      });

      return { status: 'triggered' };
    } finally {
      // 6. lock 해제 (try/finally 보장, LD-5)
      inFlight.delete(groupId);
      const t = inFlightTimeouts.get(groupId);
      if (t) clearTimeout(t);
      inFlightTimeouts.delete(groupId);
      inFlightControllers.delete(groupId);

      // 기존 GC 타이머 교체 (중복 누적 방지, iter 1 M-2 fix)
      const existingGc = gcTimeouts.get(groupId);
      if (existingGc) clearTimeout(existingGc);
      const gcTimer = setTimeout(() => {
        statusCache.delete(groupId);
        gcTimeouts.delete(groupId);
      }, STATUS_GC_MS);
      // process 종료 시 GC 타이머가 Jest/Node를 block하지 않도록 unref 적용함
      gcTimer.unref();
      gcTimeouts.set(groupId, gcTimer);
    }
  },

  getRegistryStatus(groupId) {
    // RC5-M-1 fix: statusCache 미진입 시 기본값 반환함
    return (
      statusCache.get(groupId) ?? {
        ready: false,
        registered: 0,
        attempts: 0,
        inFlight: false,
      }
    );
  },

  resetStatus(groupId) {
    // 1. retry loop abort (LD-19)
    const controller = inFlightControllers.get(groupId);
    if (controller) {
      controller.abort();
      inFlightControllers.delete(groupId);
    }
    // 2. lock 해제
    inFlight.delete(groupId);
    const t = inFlightTimeouts.get(groupId);
    if (t) clearTimeout(t);
    inFlightTimeouts.delete(groupId);
    // 3. GC 타이머 해제
    const gc = gcTimeouts.get(groupId);
    if (gc) clearTimeout(gc);
    gcTimeouts.delete(groupId);
    // 4. status cache 삭제
    statusCache.delete(groupId);
  },

  async collectPendingSubjects(groupId) {
    const pending = engineRegistryService.getPendingSubjects();
    // subjectIndex 1, 2 둘 다 있어야 trigger 가능 (LD-13, LD-25)
    if (pending.length < 2) return [];
    const hasSubject1 = pending.some((p) => p.subjectIndex === 1);
    const hasSubject2 = pending.some((p) => p.subjectIndex === 2);
    if (!hasSubject1 || !hasSubject2) return [];
    // caller가 inject한 groupId를 각 entry에 attach함 (LD-25)
    return pending.map((p) => ({
      groupId,
      url: p.url,
      subjectIndex: p.subjectIndex,
    }));
  },

  async maybeTriggerDualAssignGroup(groupId) {
    // Mongoose Session 조회 — 3-condition AND 체크 (LD-1)
    const sessions = await Session.find({ groupId });
    if (sessions.length === 0) {
      console.log(
        `[2PC-trigger-skip] groupId=${groupId} reason=no_sessions ` +
          `sessionCount=0 mode=n/a subject1Paired=n/a subject2Paired=n/a ` +
          `operatorJoined=n/a pendingCount=n/a`
      );
      return;
    }

    const mode = sessions[0].experimentMode;
    if (mode !== 'DUAL_2PC') {
      // DUAL_2PC 모드가 아니면 skip
      console.log(
        `[2PC-trigger-skip] groupId=${groupId} reason=mode_not_dual_2pc ` +
          `sessionCount=${sessions.length} mode=${mode} ` +
          `subject1Paired=n/a subject2Paired=n/a operatorJoined=n/a ` +
          `pendingCount=n/a`
      );
      return;
    }

    const subject1Paired = sessions.some(
      (s) => s.subjectIndex === 1 && s.status === 'PAIRED'
    );
    const subject2Paired = sessions.some(
      (s) => s.subjectIndex === 2 && s.status === 'PAIRED'
    );
    const operatorJoined = operatorJoinedGroups.has(groupId);

    // 3조건 AND 체크 (LD-1) — silent return reason 3분기 식별함
    if (!subject1Paired || !subject2Paired || !operatorJoined) {
      const reason = !subject1Paired
        ? 'subject1_not_paired'
        : !subject2Paired
          ? 'subject2_not_paired'
          : 'operator_not_joined';
      console.log(
        `[2PC-trigger-skip] groupId=${groupId} reason=${reason} ` +
          `sessionCount=${sessions.length} mode=${mode} ` +
          `subject1Paired=${subject1Paired} ` +
          `subject2Paired=${subject2Paired} ` +
          `operatorJoined=${operatorJoined} pendingCount=n/a`
      );
      return;
    }

    // pending DE 정보 조회 (LD-13)
    const subjects = await dualTriggerService.collectPendingSubjects(groupId);
    if (subjects.length !== 2) {
      console.log(
        `[2PC-trigger-skip] groupId=${groupId} ` +
          `reason=pending_count_mismatch ` +
          `sessionCount=${sessions.length} mode=${mode} ` +
          `subject1Paired=${subject1Paired} ` +
          `subject2Paired=${subject2Paired} ` +
          `operatorJoined=${operatorJoined} ` +
          `pendingCount=${subjects.length}`
      );
      return;
    }

    await dualTriggerService.triggerAssignGroup(groupId, subjects);
  },
};
