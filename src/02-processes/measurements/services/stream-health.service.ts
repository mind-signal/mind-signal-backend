import { SocketService } from '@07-shared/lib/socket';

/**
 * subject별 스트림 건강 상태.
 * - healthy: 최근 샘플이 도착함
 * - stale: 임계 시간 동안 샘플 없음 (프로세스는 살아 있을 수 있음)
 * - disconnected: DE가 헤드셋 분리를 명시적으로 통보함
 */
export type StreamHealthStatus = 'healthy' | 'stale' | 'disconnected';

/**
 * 샘플이 이 시간(ms) 이상 끊기면 stale로 전이함.
 * DE watchdog(30초)보다 짧게 잡아 프로세스가 죽어 watchdog 스레드까지
 * 함께 사라진 경우에도 BE가 독립적으로 감지함.
 * 2026-07-10 라이브: subject_1 스트림이 227초 지점에서 끊겼으나 프로세스는
 * 604.8초까지 살아 있었고, 어느 화면에도 표시되지 않았음.
 */
export const STALE_THRESHOLD_MS = 20_000;

interface SubjectState {
  lastSampleAt: number;
  status: StreamHealthStatus;
}

/**
 * 그룹별 subject 스트림 건강을 추적하고 상태가 바뀔 때만 운영자에게 통보함.
 *
 * 상태 래치가 필요한 이유: DE watchdog은 stale 동안 10초마다 같은 메시지를
 * 반복 발행하고 BE flush는 100ms 주기라, 전이 시점만 emit하지 않으면
 * 운영자 화면이 이벤트로 뒤덮임. 복구 이벤트가 없으면 배너가 영구 잔류함.
 */
export class StreamHealthTracker {
  private subjects = new Map<number, SubjectState>();

  constructor(
    private readonly groupId: string,
    private readonly staleThresholdMs: number = STALE_THRESHOLD_MS
  ) {}

  /** 샘플 수신 기록함. stale에서 복구되면 recovered 통보함. */
  recordSample(subjectIndex: number, now: number): void {
    const prev = this.subjects.get(subjectIndex);
    this.subjects.set(subjectIndex, { lastSampleAt: now, status: 'healthy' });

    if (prev && prev.status !== 'healthy') {
      this.emit(subjectIndex, 'healthy', { recovered: true });
    }
  }

  /** DE가 보낸 headset_status를 반영함 (명시적 분리 통보). */
  recordHeadsetStatus(subjectIndex: number, status: string, now: number): void {
    const next: StreamHealthStatus =
      status === 'disconnected' ? 'disconnected' : 'stale';
    const prev = this.subjects.get(subjectIndex);
    if (prev?.status === next) return; // 중복 억제함

    this.subjects.set(subjectIndex, {
      lastSampleAt: prev?.lastSampleAt ?? now,
      status: next,
    });
    this.emit(subjectIndex, next, { source: 'engine' });
  }

  /**
   * 마지막 수신 시각을 기준으로 stale 전이를 검사함.
   * DE 프로세스가 죽어 watchdog까지 사라진 경우의 안전망임.
   */
  checkStale(now: number): void {
    for (const [subjectIndex, state] of this.subjects) {
      if (state.status !== 'healthy') continue;
      if (now - state.lastSampleAt < this.staleThresholdMs) continue;

      this.subjects.set(subjectIndex, { ...state, status: 'stale' });
      this.emit(subjectIndex, 'stale', {
        source: 'backend',
        silentMs: now - state.lastSampleAt,
      });
    }
  }

  /** 현재 상태 조회함 (테스트·진단용). */
  statusOf(subjectIndex: number): StreamHealthStatus | undefined {
    return this.subjects.get(subjectIndex)?.status;
  }

  private emit(
    subjectIndex: number,
    status: StreamHealthStatus,
    extra: Record<string, unknown>
  ): void {
    console.warn(
      `[streamHealth] groupId=${this.groupId} subject=${subjectIndex} -> ${status}`
    );
    // 운영자 room으로만 보냄 — 피실험자 화면에는 도달하지 않음
    SocketService.emitToOperators(this.groupId, 'stream-health', {
      groupId: this.groupId,
      subjectIndex,
      status,
      ...extra,
    });
  }
}
