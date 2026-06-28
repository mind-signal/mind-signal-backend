import { Session } from '@06-entities/sessions';
import { redisService } from '@07-shared/lib/redis';
import { SocketService } from '@07-shared/lib/socket';
import { AppError } from '@07-shared/errors';
import { engineRegistryService } from '@02-processes/engine/services/engine-registry.service';
import { timestampAlignerRegistry } from './timestamp-aligner.service';
import { stimulusBroadcasterService } from './stimulus-broadcaster.service';
import type { WavePower } from './timestamp-aligner.service';
import { RedisClientType } from 'redis';
import { config } from '@07-shared/config/config';

// ---------------------------------------------------------------------------
// 반환 타입 — discriminated union (v5 N-9 반영)
// ---------------------------------------------------------------------------

/** startMeasurementService 반환 타입 */
export type StartMeasurementResult =
  | { kind: 'DUAL_2PC'; groupId: string } // fire-and-forget 경로
  | { kind: 'SYNC'; measuredAt: Date | undefined }; // 기존 경로

// ---------------------------------------------------------------------------
// 모듈 레벨 구독자 레지스트리 — 기존 1PC 경로
// ---------------------------------------------------------------------------

/** Redis 구독자 레지스트리 — 키: `${groupId}:${subjectIndex}` */
const subscriberRegistry = new Map<string, RedisClientType>();

// ---------------------------------------------------------------------------
// 모듈 레벨 구독자 레지스트리 — DUAL_2PC 경로 (v7 H-1 반영)
// ---------------------------------------------------------------------------

/** DUAL_2PC groupId별 Redis 구독자 목록 — cleanup 시 unsubscribe 필요 */
const groupSubscribers = new Map<string, RedisClientType[]>();

/** DUAL_2PC groupId별 flush setInterval 핸들러 — unsubscribeGroupChannels에서 clearInterval */
const groupFlushIntervals = new Map<string, ReturnType<typeof setInterval>>();

/** 진행 중인 DUAL_2PC 측정 groupId — 중복 트리거 차단 */
const dualMeasurementInFlight = new Set<string>();

// ---------------------------------------------------------------------------
// 내부 헬퍼 — DUAL_2PC 전용
// ---------------------------------------------------------------------------

/**
 * DUAL_2PC groupId의 두 Redis 채널(subject 1 + 2)을 구독하고
 * aligner.ingest()로 라우팅함 (v7 H-1 반영).
 * flush setInterval(100ms)도 이 함수 내부에서 기동함 (v9 R9-H-2 반영).
 *
 * @param groupId - 실험 그룹 ID
 */
async function subscribeWithAligner(groupId: string): Promise<void> {
  const subscribers: RedisClientType[] = [];

  // v7 H-PREP-1: subjectIndex는 1-based
  // 기존 Redis 채널 규칙(`mind-signal:{groupId}:subject:{subjectIndex}`) 그대로 유지
  for (const subjectIndex of [1, 2]) {
    const subscriber = redisService.client.duplicate() as RedisClientType;
    await subscriber.connect();
    const channel = `mind-signal:${groupId}:subject:${subjectIndex}`;
    await subscriber.subscribe(channel, (message: string) => {
      try {
        const parsed = JSON.parse(message);
        // v8 C-1: streamer.py가 brain_sync_all 외에 headset_status 타입도 동일 채널에 publish
        // (watchdog L172-183, on_headset_disconnected L193-204). parsed.waves 필드 없음 → aligner에 undefined 주입 방지
        if (parsed.type !== 'brain_sync_all') return;
        // waves 필드 → WavePower 추출 (core/streamer.py L266-277 payload 구조 기준)
        const sample: WavePower = parsed.waves;
        const serverTimestamp = Date.now();
        timestampAlignerRegistry.ingest(
          groupId,
          subjectIndex,
          sample,
          serverTimestamp
        );
      } catch (err) {
        console.error(`DUAL_2PC ${channel} parse error:`, err);
      }
    });
    subscribers.push(subscriber);
  }
  groupSubscribers.set(groupId, subscribers);

  // v9 R9-H-2: flush 호출 주체는 subscribeWithAligner 내부 setInterval(100)
  // unsubscribeGroupChannels에서 clearInterval 처리
  const intervalId = setInterval(() => {
    timestampAlignerRegistry.flush(groupId);
  }, 100);
  // process 종료 시 flush 타이머가 Jest/Node를 block하지 않도록 unref 적용함
  intervalId.unref();
  groupFlushIntervals.set(groupId, intervalId);
}

/**
 * DUAL_2PC groupId의 Redis 구독자 2개 + flush interval 전부 해제함.
 * stopMeasurementService allCompleted gate에서 호출됨.
 *
 * @param groupId - 실험 그룹 ID
 */
async function unsubscribeGroupChannels(groupId: string): Promise<void> {
  // flush interval 먼저 중단함
  const intervalId = groupFlushIntervals.get(groupId);
  if (intervalId !== undefined) {
    clearInterval(intervalId);
    groupFlushIntervals.delete(groupId);
  }

  const subscribers = groupSubscribers.get(groupId);
  if (!subscribers) return;
  for (const subscriber of subscribers) {
    try {
      await subscriber.unsubscribe();
      await subscriber.quit();
    } catch (err) {
      console.error('DUAL_2PC subscriber cleanup error:', err);
    }
  }
  groupSubscribers.delete(groupId);
}

/**
 * 두 DE가 모두 등록될 때까지 기다리거나 timeout 발생함 (v4 N-4 + v4 N-7 반영).
 * EventEmitter 패턴: engineRegistryService.registerDual() 호출 시 emit.
 * Promise settle 시 unsubscribe + clearTimeout 필수 (ghost 콜백/타이머 누수 방지).
 *
 * @param groupId - 실험 그룹 ID
 * @param timeoutMs - 최대 대기 시간(ms)
 */
async function waitForBothEngines(
  groupId: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const checkReady = () => {
      if (engineRegistryService.isFullyRegistered(groupId, 2)) {
        cleanup();
        resolve();
      }
    };

    // 즉시 1회 체크 (이미 등록 완료됐을 수 있음)
    checkReady();

    // 이벤트 listen — unsubscribe 함수 저장
    unsubscribe = engineRegistryService.onRegistered(groupId, checkReady);

    // timeout — timer 참조 저장
    timer = setTimeout(() => {
      cleanup();
      reject(new AppError('DE 등록 timeout', 504));
    }, timeoutMs);
  });
}

/**
 * DUAL_2PC 측정 fire-and-forget 실행함 (v4 N-4 반영).
 * Express 요청 핸들러에서는 이미 202 응답 반환 후 비동기로 실행됨.
 *
 * @param groupId - 실험 그룹 ID
 */
function startDualMeasurement(groupId: string): void {
  // 동일 groupId 중복 호출 차단 — 원자적 동기 가드
  if (dualMeasurementInFlight.has(groupId)) {
    return;
  }
  dualMeasurementInFlight.add(groupId);
  (async () => {
    try {
      // 두 DE 등록 대기 (최대 60초) — 클라이언트에게는 이미 응답 반환됨
      await waitForBothEngines(groupId, config.dualPc.registrationTimeoutMs);

      // ▼ 신규 (T17-4): 두 DE에 streamStart 병렬 호출
      const { engineProxyService } =
        await import('@02-processes/engine/services/engine-proxy.service');
      await Promise.all([
        engineProxyService.streamStartDual(groupId, 1),
        engineProxyService.streamStartDual(groupId, 2),
      ]);
      // ▲ 신규

      // 두 DE 스트림 시작 성공 → 양쪽 세션 MEASURING 전이함 (상태머신 정합).
      // 누락 시 세션이 PAIRED 잔류하여 stop이 PAIRED→COMPLETED 불가로 실패함.
      await Session.updateMany(
        { groupId },
        { status: 'MEASURING', measuredAt: new Date() }
      );

      // aligner registry에 인스턴스 생성
      timestampAlignerRegistry.getOrCreate(
        groupId,
        config.dualPc.timestampToleranceMs
      );

      // stimulus broadcast (room emit)
      await stimulusBroadcasterService.broadcast(groupId);

      // Redis 구독 → aligner.ingest() (v7 H-1: 두 채널 각각 구독 필요)
      await subscribeWithAligner(groupId);

      // 성공 통보
      SocketService.emitToGroup(groupId, 'dual-session-ready', {
        groupId,
        // eslint-disable-next-line camelcase
        timestamp_ms: Date.now(),
      });
    } catch (err) {
      // T4 fix: 반쪽 등록 잔류 방지 — dualRegistry cleanup 호출함 (LD-4)
      engineRegistryService.cleanupGroup(groupId);
      // 실패 통보 (60초 timeout + streamStart 실패 포함)
      SocketService.emitToGroup(groupId, 'dual-session-failed', {
        groupId,
        error: err instanceof Error ? err.message : 'unknown',
      });
      // 세션 상태 CANCELLED로 전이
      await Session.updateMany(
        { groupId },
        { status: 'CANCELLED', stopReason: 'ProcessError' }
      );
    } finally {
      dualMeasurementInFlight.delete(groupId);
    }
  })();
}

// ---------------------------------------------------------------------------
// 공개 서비스 함수
// ---------------------------------------------------------------------------

/**
 * groupId 기반 DUAL_2PC 측정 시작 서비스.
 * 오퍼레이터 대시보드가 sessionId 없이 groupId만 보유한 경우 사용함.
 *
 * @param groupId - 실험 그룹 ID
 * @returns 그룹 ID 반환
 * @throws AppError 404 — 해당 groupId의 세션 미존재
 * @throws AppError 400 — experimentMode가 DUAL_2PC가 아님
 */
export const startDualMeasurementByGroup = async (
  groupId: string
): Promise<{ groupId: string }> => {
  // groupId로 세션 목록 조회함
  const sessions = await Session.find({ groupId });
  if (sessions.length === 0) {
    throw new AppError('해당 groupId에 속한 세션을 찾을 수 없습니다.', 404);
  }

  // experimentMode 검증 — 그룹 내 모든 세션이 DUAL_2PC여야 함
  if (!sessions.every((s) => s.experimentMode === 'DUAL_2PC')) {
    throw new AppError(
      'groupId 기반 측정 시작은 DUAL_2PC 모드만 지원합니다.',
      400
    );
  }

  // 상태 전이 가드 — 그룹 내 모든 세션이 MEASURING으로 전이 가능해야 함.
  // MEASURING 잔류 세션 재트리거(중복 start) 차단함.
  if (!sessions.every((s) => s.canTransitionTo('MEASURING'))) {
    throw new AppError(
      '그룹 내 전이 불가 세션이 존재하여 측정을 시작할 수 없습니다.',
      400
    );
  }

  // fire-and-forget 실행 (기존 함수 재사용)
  startDualMeasurement(groupId);
  return { groupId };
};

/**
 * 뇌파 측정 시작 서비스 (discriminated union 반환, v5 N-9 반영).
 *
 * DUAL_2PC: fire-and-forget 후 { kind: 'DUAL_2PC', groupId } 반환.
 * 그 외: 기존 동기 경로 후 { kind: 'SYNC', measuredAt } 반환.
 *
 * @param sessionId - 측정을 시작할 세션 ID
 * @returns StartMeasurementResult discriminated union
 * @throws AppError 404 — 세션 미존재
 * @throws AppError 400 — 상태 전이 불가 또는 subjectIndex 없음
 */
export const startMeasurementService = async (
  sessionId: string
): Promise<StartMeasurementResult> => {
  // 1. 세션 조회 및 검증함
  const session = await Session.findById(sessionId);
  if (!session) {
    throw new AppError('요청하신 세션을 찾을 수 없습니다.', 404);
  }

  // 2. 상태 전이 비즈니스 규칙 검사함
  if (!session.canTransitionTo('MEASURING')) {
    throw new AppError(
      `현재 ${session.status} 상태에서는 측정을 시작할 수 없습니다.`,
      400
    );
  }

  // 3. DUAL_2PC 분기 먼저 (subjectIndex guard 이전, v2 N-2 반영)
  // DUAL_2PC는 subjectIndex 없어도 OK — groupId 기반 처리
  if (session.experimentMode === 'DUAL_2PC') {
    startDualMeasurement(session.groupId); // fire-and-forget (비동기)
    return { kind: 'DUAL_2PC', groupId: session.groupId };
  }

  // 4. subjectIndex guard (SEQUENTIAL/DUAL/BTI 경로만, Bug 3 guard)
  if (session.subjectIndex === null || session.subjectIndex <= 0) {
    throw new AppError('세션에 유효한 subjectIndex가 없습니다.', 400);
  }

  // 5. DB 업데이트함 (기존 경로)
  session.status = 'MEASURING';
  session.measuredAt = new Date();
  await session.save();

  // 6. Redis 구독자 연결 (실패 시 상태 롤백 수행함)
  const subscriber = redisService.client.duplicate();
  try {
    await subscriber.connect();
  } catch (err) {
    // Redis 연결 실패 시 세션 상태를 CANCELLED로 롤백함
    session.status = 'CANCELLED';
    await session.save();
    throw err;
  }

  // 구독자 레지스트리에 등록함
  const registryKey = `${session.groupId}:${session.subjectIndex}`;
  subscriberRegistry.set(registryKey, subscriber as unknown as RedisClientType);

  const channel = `mind-signal:${session.groupId}:subject:${session.subjectIndex}`;
  await subscriber.subscribe(channel, (message: string) => {
    try {
      const parsed = JSON.parse(message);
      // Python 엔진 페이로드에서 metrics 필드만 추출하여 전달함
      // 전체 구조: { type, groupId, subjectIndex, waves, metrics, time }
      // 프론트엔드 EmotivMetrics 규격: { engagement, interest, excitement, stress, relaxation, focus }
      const data = parsed.metrics ?? parsed;
      SocketService.emitLiveEvent('eeg-live', { sessionId: session._id, data });
    } catch (err) {
      console.error('Redis JSON 파싱 에러:', err);
    }
  });

  // 7. 엔진 프록시를 통해 EEG 스트리밍 시작 요청함 (로컬 FastAPI → core.main spawn)
  const { engineProxyService } =
    await import('@02-processes/engine/services/engine-proxy.service');
  try {
    const result = await engineProxyService.streamStart(
      session.groupId,
      session.subjectIndex
    );
    console.log(`EEG 스트리밍 시작됨: ${JSON.stringify(result)}`);
  } catch (err) {
    console.error('EEG 스트리밍 시작 실패:', err);
    session.status = 'CANCELLED';
    await session.save();
    SocketService.emitLiveEvent('measurement-complete', {
      sessionId: session._id,
      status: session.status,
    });
    try {
      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    } catch (cleanupErr) {
      console.error('Redis 정리 중 에러:', cleanupErr);
    }
    throw err;
  }

  return { kind: 'SYNC', measuredAt: session.measuredAt };
};

/**
 * 측정 종료 후 세션 COMPLETED 전이 + Redis 구독 해제 수행함.
 * 두 subject 모두 COMPLETED 시 포스트-측정 오케스트레이션 트리거함.
 * DUAL_2PC: allCompleted gate — 두 subject 모두 완료 시에만 emit (v7 H-2 반영).
 *
 * @param groupId - 실험 그룹 ID
 * @param subjectIndex - 피실험자 순번
 * @param stopReason - 측정 종료 사유
 * @returns allCompleted 여부
 */
export const stopMeasurementService = async (
  groupId: string,
  subjectIndex: number,
  stopReason:
    | 'Natural'
    | 'ManualEarly'
    | 'HeadsetLost'
    | 'ProcessError' = 'Natural'
) => {
  const session = await Session.findOne({ groupId, subjectIndex });
  if (!session) {
    throw new AppError('세션을 찾을 수 없습니다.', 404);
  }

  if (!session.canTransitionTo('COMPLETED')) {
    throw new AppError(
      `현재 ${session.status} 상태에서는 측정을 완료할 수 없습니다.`,
      400
    );
  }

  // 세션 상태 COMPLETED 전이 + stopReason + measuredDuration 기록함
  session.status = 'COMPLETED';
  session.stopReason = stopReason;
  if (session.measuredAt) {
    session.measuredDurationSeconds = Math.round(
      (Date.now() - session.measuredAt.getTime()) / 1000
    );
  }
  await session.save();

  // 기존 1PC 경로 Redis 구독자 정리함
  const registryKey = `${groupId}:${subjectIndex}`;
  const subscriber = subscriberRegistry.get(registryKey);
  if (subscriber) {
    try {
      const channel = `mind-signal:${groupId}:subject:${subjectIndex}`;
      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    } catch (err) {
      console.error('Redis 구독 해제 중 에러:', err);
    }
    subscriberRegistry.delete(registryKey);
  }

  // 두 subject 모두 COMPLETED인지 확인함
  const allSessions = await Session.find({ groupId });
  const allCompleted = allSessions.every((s) => s.status === 'COMPLETED');

  const payload = {
    groupId,
    subjectIndex,
    status: 'COMPLETED',
    stopReason,
  };

  // v7 H-2: DUAL_2PC는 allCompleted일 때만 1회 emit + cleanup
  // 기존 기존 SEQUENTIAL/DUAL/BTI 경로는 subject별 emit 유지 (v2 N-3 반영)
  if (session.experimentMode === 'DUAL_2PC') {
    if (allCompleted) {
      // 두 subject 모두 COMPLETED일 때만 1회 emit
      SocketService.emitToGroup(session.groupId, 'measurement-complete', {
        ...payload,
        sessionId: session._id,
      });
      timestampAlignerRegistry.cleanup(session.groupId);
      engineRegistryService.cleanupGroup(session.groupId);
      // subscribeWithAligner가 생성한 Redis subscriber 2개 + flush interval 전부 해제
      await unsubscribeGroupChannels(session.groupId);
    }
    // 첫 subject stop 시점에는 emit 생략 (UI는 "partner 측정 중" 상태 유지)
  } else {
    // 기존 SEQUENTIAL/DUAL/BTI 경로 유지 (subject별 emit 유지)
    SocketService.emitLiveEvent('measurement-complete', {
      sessionId: session._id,
      ...payload,
    });
  }

  return { allCompleted };
};
