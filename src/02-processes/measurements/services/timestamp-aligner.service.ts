/**
 * timestamp-aligner.service.ts
 *
 * 두 subject EEG 샘플을 서버 ingest 타임스탬프 기준으로 정렬하는
 * 모듈 레벨 레지스트리 (Phase 16 Wave 1 skeleton → Wave 2 본 구현).
 *
 * flush 호출 주체 (v9 R9-H-2): subscribeWithAligner(groupId) 내부
 * setInterval(() => timestampAlignerRegistry.flush(groupId), 100) 기동,
 * unsubscribeGroupChannels(groupId) 헬퍼에서 clearInterval 처리.
 */

import { SocketService } from '@07-shared/lib/socket';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * 단일 EEG 주파수 대역 파워 값.
 */
export interface WavePower {
  delta: number;
  theta: number;
  alpha: number;
  beta: number;
  gamma: number;
}

/**
 * 두 subject 샘플이 타임스탬프 기준으로 정렬된 쌍.
 * v7 H-PREP-1 / v8 H-1: subjectIndex 1-based 통일.
 * snake_case 필드명은 Socket.io 페이로드 계약 (FE AlignedSample 타입과 정합).
 */
export interface AlignedSample {
  groupId: string;
  timestamp_ms: number;
  subject_1: WavePower | null;
  subject_2: WavePower | null;
}

// ---------------------------------------------------------------------------
// Internal class
// ---------------------------------------------------------------------------

/** 버퍼 엔트리 타입 */
interface BufferEntry {
  ts: number;
  sample: WavePower;
}

/**
 * 단일 groupId 전용 타임스탬프 정렬기.
 * plan-review H-4 반영 — 모듈 레벨 registry에서 groupId별로 인스턴스 관리됨.
 */
class TimestampAligner {
  /** subjectIndex(1 또는 2) 별 미처리 샘플 버퍼 */
  private buffer: Map<number, BufferEntry[]> = new Map();

  /**
   * @param groupId - 실험 그룹 ID (SocketService.emitToGroup 호출에 사용)
   * @param toleranceMs - 두 subject 타임스탬프 허용 오차(ms). 기본 200ms (plan-review M-4)
   */
  constructor(
    private groupId: string,
    private toleranceMs: number
  ) {}

  /**
   * 단일 subject 샘플을 버퍼에 적재함.
   * subjectIndex(1 또는 2) 별 buffer push.
   *
   * @param subjectIndex - 1 또는 2 (1-based)
   * @param sample - EEG 주파수 대역 파워 값
   * @param serverTimestamp - BE ingest 시각 (Date.now())
   */
  ingest(
    subjectIndex: number,
    sample: WavePower,
    serverTimestamp: number
  ): void {
    if (!this.buffer.has(subjectIndex)) {
      this.buffer.set(subjectIndex, []);
    }
    this.buffer.get(subjectIndex)!.push({ ts: serverTimestamp, sample });
  }

  /**
   * 버퍼 스캔 후 정렬 가능한 쌍 생성 + Socket.io 전송 + 만료 항목 drop 수행함.
   *
   * - |ts_1 - ts_2| ≤ toleranceMs 인 쌍 생성
   * - AlignedSample.subject_1 / subject_2 필드로 매핑 (1-based)
   * - 매칭 실패 샘플은 Date.now() - ts > 500ms 시 drop (timestamp_min-aged)
   * - 정렬된 쌍은 SocketService.emitToGroup(groupId, 'aligned_pair', alignedSample) 전송
   *
   * @returns 정렬된 AlignedSample 배열
   */
  flush(): AlignedSample[] {
    const now = Date.now();
    const expireThresholdMs = 500;
    const aligned: AlignedSample[] = [];

    const buf1 = this.buffer.get(1) ?? [];
    const buf2 = this.buffer.get(2) ?? [];

    // 만료 항목 drop — 매칭 실패 샘플 Date.now() - ts > 500ms 시 제거
    const fresh1 = buf1.filter((e) => now - e.ts <= expireThresholdMs);
    const fresh2 = buf2.filter((e) => now - e.ts <= expireThresholdMs);

    // 그리디 매칭: buf1 각 항목에 대해 toleranceMs 내 buf2 최근접 항목 탐색
    // 매칭 여부를 인덱스로 추적하여 버퍼 업데이트에 활용함
    const usedIdx1 = new Set<number>();
    const usedIdx2 = new Set<number>();

    // 단일 헤드셋 지원 — subject 1 미수신 시 subject 2 단독 emit함
    // ponytail: subject 2 방향만 처리. 데모는 subject 1=operator(헤드셋 없음) 고정.
    // 양쪽 다 있으면 아래 그리디 매칭 경로(불변)로 진입함.
    if (fresh1.length === 0 && fresh2.length > 0) {
      /* eslint-disable camelcase */
      for (const entry2 of fresh2) {
        const sample: AlignedSample = {
          groupId: this.groupId,
          timestamp_ms: entry2.ts,
          subject_1: null,
          subject_2: entry2.sample,
        };
        aligned.push(sample);
        SocketService.emitToGroup(this.groupId, 'aligned_pair', sample);
      }
      /* eslint-enable camelcase */
      this.buffer.set(1, []);
      this.buffer.set(2, []);
      return aligned;
    }

    for (let i1 = 0; i1 < fresh1.length; i1++) {
      const entry1 = fresh1[i1];
      let bestIdx = -1;
      let bestDiff = Infinity;

      for (let i = 0; i < fresh2.length; i++) {
        if (usedIdx2.has(i)) continue;
        const diff = Math.abs(entry1.ts - fresh2[i].ts);
        if (diff <= this.toleranceMs && diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        usedIdx1.add(i1);
        usedIdx2.add(bestIdx);
        const entry2 = fresh2[bestIdx];
        // 두 타임스탬프의 평균을 aligned timestamp로 사용함
        const alignedTs = Math.round((entry1.ts + entry2.ts) / 2);
        // snake_case 필드명은 FE Socket.io 페이로드 계약 — eslint-disable 필수
        /* eslint-disable camelcase */
        const sample: AlignedSample = {
          groupId: this.groupId,
          timestamp_ms: alignedTs,
          subject_1: entry1.sample,
          subject_2: entry2.sample,
        };
        /* eslint-enable camelcase */
        aligned.push(sample);
        SocketService.emitToGroup(this.groupId, 'aligned_pair', sample);
      }
    }

    // 미매칭 항목만 버퍼에 유지 — 만료 항목(fresh 필터에서 제외된 것)은 자동 drop됨
    const newBuf1 = fresh1.filter((_, idx) => !usedIdx1.has(idx));
    const newBuf2 = fresh2.filter((_, idx) => !usedIdx2.has(idx));

    this.buffer.set(1, newBuf1);
    this.buffer.set(2, newBuf2);

    return aligned;
  }
}

// ---------------------------------------------------------------------------
// Module-level registry (plan-review H-4)
// Redis 콜백 외부 참조 가능, multi-group 동시성 지원.
// ---------------------------------------------------------------------------

const registry = new Map<string, TimestampAligner>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const timestampAlignerRegistry = {
  /**
   * groupId 에 대한 TimestampAligner 를 가져오거나 새로 생성함.
   *
   * @param groupId - 실험 그룹 ID
   * @param toleranceMs - 타임스탬프 허용 오차 (기본 200ms)
   * @returns TimestampAligner 인스턴스
   */
  getOrCreate(groupId: string, toleranceMs: number): TimestampAligner {
    const existing = registry.get(groupId);
    if (existing) return existing;
    const aligner = new TimestampAligner(groupId, toleranceMs);
    registry.set(groupId, aligner);
    return aligner;
  },

  /**
   * 단일 subject 샘플을 해당 group 의 aligner 버퍼에 적재함.
   * 내부 TimestampAligner.ingest() 위임.
   *
   * @param groupId - 실험 그룹 ID
   * @param subjectIndex - 1 또는 2 (1-based)
   * @param sample - EEG 주파수 대역 파워 값
   * @param serverTimestamp - BE ingest 시각 (Date.now())
   */
  ingest(
    groupId: string,
    subjectIndex: number,
    sample: WavePower,
    serverTimestamp: number
  ): void {
    const aligner = registry.get(groupId);
    if (!aligner) return; // aligner 미생성 시 무시함 (race condition 방어)
    aligner.ingest(subjectIndex, sample, serverTimestamp);
  },

  /**
   * 해당 group 의 버퍼를 스캔하여 정렬된 쌍을 반환하고 Socket.io로 전송함.
   * flush 호출 주체 (v9 R9-H-2): subscribeWithAligner 내부 setInterval(100).
   *
   * @param groupId - 실험 그룹 ID
   * @returns 정렬된 AlignedSample 배열
   */
  flush(groupId: string): AlignedSample[] {
    const aligner = registry.get(groupId);
    if (!aligner) return [];
    return aligner.flush();
  },

  /**
   * groupId 에 해당하는 aligner 를 레지스트리에서 제거하고 리소스 해제함.
   * stopMeasurementService 에서 DUAL_2PC allCompleted 시 호출됨.
   *
   * @param groupId - 실험 그룹 ID
   */
  cleanup(groupId: string): void {
    registry.delete(groupId);
  },

  /**
   * 테스트 격리용 — 전역 registry 전체 초기화함 (v2 Med-1).
   * Jest beforeEach 에서만 호출할 것. 프로덕션 코드에서 호출 금지.
   *
   * @example
   * ```ts
   * beforeEach(() => timestampAlignerRegistry.__resetForTest__());
   * ```
   */
  __resetForTest__(): void {
    registry.clear();
  },
};
