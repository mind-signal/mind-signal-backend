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
 * EMOTIV 자체 산출 지표 6종 (0..1 정규화됨).
 */
export interface EmotivMetrics {
  focus: number;
  engagement: number;
  interest: number;
  excitement: number;
  stress: number;
  relaxation: number;
}

/**
 * 한 subject의 한 시점 샘플.
 *
 * waves(대역 파워)와 metrics(EMOTIV 지표)를 함께 실음. metrics는 구버전 DE
 * 프레임에서 없을 수 있어 optional임. 과거에는 waves만 전달해 FE가 대역 파워를
 * 지표 자리에 끼워 넣었고(stress에 delta), 차트가 왜곡됐음 (2026-07-10 수정).
 */
export interface SubjectSample {
  waves: WavePower;
  metrics?: EmotivMetrics;
}

/**
 * 두 subject 샘플이 타임스탬프 기준으로 정렬된 쌍.
 * v7 H-PREP-1 / v8 H-1: subjectIndex 1-based 통일.
 * snake_case 필드명은 Socket.io 페이로드 계약 (FE AlignedSample 타입과 정합).
 */
export interface AlignedSample {
  groupId: string;
  timestamp_ms: number;
  subject_1: SubjectSample | null;
  subject_2: SubjectSample | null;
}

// ---------------------------------------------------------------------------
// Internal class
// ---------------------------------------------------------------------------

/** 버퍼 엔트리 타입 */
interface BufferEntry {
  ts: number;
  sample: SubjectSample;
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
   * @param sample - 대역 파워와 EMOTIV 지표를 담은 subject 샘플
   * @param serverTimestamp - BE ingest 시각 (Date.now())
   */
  ingest(
    subjectIndex: number,
    sample: SubjectSample,
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
   * - 매칭 실패 샘플은 toleranceMs 초과 대기 시 상대를 null 로 두고 단독 emit
   * - 정렬된 쌍은 SocketService.emitToGroup(groupId, 'aligned_pair', alignedSample) 전송
   *
   * @returns 정렬된 AlignedSample 배열
   */
  flush(): AlignedSample[] {
    const now = Date.now();
    const aligned: AlignedSample[] = [];

    // 만료 drop 없음. 미매칭 샘플은 아래 단독 emit 이 tolerance 초과 즉시
    // 내보내므로 버퍼가 쌓이지 않음. 이전의 500ms 만료 필터는 이벤트 루프가
    // 잠깐 멈추면 샘플이 tolerance 창을 건너뛰어 조용히 사라지는 구멍이었음
    // (CodeRabbit #106)
    const fresh1 = this.buffer.get(1) ?? [];
    const fresh2 = this.buffer.get(2) ?? [];

    // 그리디 매칭: buf1 각 항목에 대해 toleranceMs 내 buf2 최근접 항목 탐색
    // 매칭 여부를 인덱스로 추적하여 버퍼 업데이트에 활용함
    const usedIdx1 = new Set<number>();
    const usedIdx2 = new Set<number>();

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

    // 미매칭 항목만 남김
    const newBuf1 = fresh1.filter((_, idx) => !usedIdx1.has(idx));
    const newBuf2 = fresh2.filter((_, idx) => !usedIdx2.has(idx));

    // 단독 emit — 페어링 윈도(toleranceMs)를 넘겨 대기한 미매칭 샘플은 혼자
    // 내보냄. ingest 시각은 서버 Date.now() 라 단조 증가하므로, tolerance 를
    // 넘긴 샘플은 앞으로 올 어떤 파트너와도 맞을 수 없음. 윈도 내 어린 샘플은
    // 유지해 late pair 허용 (CodeRabbit #68 — 일시 지연을 single-headset 으로
    // 오판하지 않음).
    //
    // 상대 버퍼 비움을 조건으로 걸지 않음. 2026-09-07 2PC 측정에서 두 엔진이
    // 300ms 위상 차로 계속 들어오자 상대 버퍼가 비는 순간이 없어 먼저 온
    // subject 1 이 매번 500ms 만료로 drop 되고 화면이 STALE 이 됐음 (BE 수신은
    // 정상). 옛 코드는 그 조건에 더해 subject 2 에만 분기가 있었음.
    const keptBuf1 = this.emitSolo(newBuf1, 1, now, aligned);
    const keptBuf2 = this.emitSolo(newBuf2, 2, now, aligned);

    this.buffer.set(1, keptBuf1);
    this.buffer.set(2, keptBuf2);

    return aligned;
  }

  /**
   * 미매칭 샘플 중 tolerance 를 초과 대기한 것을 단독 emit함.
   *
   * @param own - 이 subject 의 미매칭 버퍼
   * @param subjectIndex - 1 또는 2 (1-based)
   * @param now - flush 시각
   * @param aligned - emit 된 샘플을 누적할 배열
   * @returns 단독 emit 되지 않고 버퍼에 남길 항목
   */
  private emitSolo(
    own: BufferEntry[],
    subjectIndex: 1 | 2,
    now: number,
    aligned: AlignedSample[]
  ): BufferEntry[] {
    const kept: BufferEntry[] = [];
    for (const entry of own) {
      if (now - entry.ts > this.toleranceMs) {
        /* eslint-disable camelcase */
        const sample: AlignedSample = {
          groupId: this.groupId,
          timestamp_ms: entry.ts,
          subject_1: subjectIndex === 1 ? entry.sample : null,
          subject_2: subjectIndex === 2 ? entry.sample : null,
        };
        /* eslint-enable camelcase */
        aligned.push(sample);
        SocketService.emitToGroup(this.groupId, 'aligned_pair', sample);
      } else {
        kept.push(entry);
      }
    }
    return kept;
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
   * @param sample - 대역 파워와 EMOTIV 지표를 담은 subject 샘플
   * @param serverTimestamp - BE ingest 시각 (Date.now())
   */
  ingest(
    groupId: string,
    subjectIndex: number,
    sample: SubjectSample,
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
