/**
 * timestamp-aligner.service.ts — Unit 테스트 (BE-aligner)
 *
 * 검증 항목:
 *   - ±200ms 내 두 subject 샘플 → AlignedSample 생성 + SocketService.emitToGroup 호출
 *   - tolerance 초과 미매칭 샘플 → 단독 emit (만료 drop 없음)
 *   - registry 수명 관리 — getOrCreate, cleanup
 *   - v8 C-1: brain_sync_all 타입 가드 (measurement.service 소스 검증)
 */

import { timestampAlignerRegistry } from './timestamp-aligner.service';
import type { SubjectSample, WavePower } from './timestamp-aligner.service';

// SocketService 모킹 — 실제 소켓 서버 없이 호출 검증
jest.mock('@07-shared/lib/socket', () => ({
  SocketService: {
    emitToGroup: jest.fn(),
  },
}));

import { SocketService } from '@07-shared/lib/socket';

const mockEmitToGroup = SocketService.emitToGroup as jest.Mock;

/** 테스트용 샘플 EEG WavePower */
const makeWaves = (base = 1.0): WavePower => ({
  delta: base,
  theta: base + 0.1,
  alpha: base + 0.2,
  beta: base + 0.3,
  gamma: base + 0.4,
});

/** aligned_pair 계약: 각 subject는 waves와 metrics를 함께 실음 (2026-07-10) */
const makeSample = (base = 1.0): SubjectSample => ({
  waves: makeWaves(base),
  metrics: {
    focus: 0.1,
    engagement: 0.2,
    interest: 0.3,
    excitement: 0.4,
    stress: 0.5,
    relaxation: 0.6,
  },
});

describe('[TS-STREAM-01] timestampAlignerRegistry — BE-aligner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // 테스트 격리 — 전역 레지스트리 초기화함
    timestampAlignerRegistry.__resetForTest__();
  });

  // ============================================================
  // getOrCreate / cleanup 수명 관리
  // ============================================================

  describe('registry 수명 관리', () => {
    it('getOrCreate로 aligner 생성 후 동일 groupId → 동일 인스턴스 반환함', () => {
      const aligner1 = timestampAlignerRegistry.getOrCreate('grp-01', 200);
      const aligner2 = timestampAlignerRegistry.getOrCreate('grp-01', 200);
      expect(aligner1).toBe(aligner2);
    });

    it('다른 groupId → 독립 인스턴스 반환함', () => {
      const aligner1 = timestampAlignerRegistry.getOrCreate('grp-01', 200);
      const aligner2 = timestampAlignerRegistry.getOrCreate('grp-02', 200);
      expect(aligner1).not.toBe(aligner2);
    });

    it('cleanup 후 flush → 빈 배열 반환함 (registry 없음)', () => {
      timestampAlignerRegistry.getOrCreate('grp-01', 200);
      timestampAlignerRegistry.cleanup('grp-01');
      const result = timestampAlignerRegistry.flush('grp-01');
      expect(result).toEqual([]);
    });

    it('aligner 없이 ingest 호출 시 에러 없이 무시됨 (race condition 방어)', () => {
      expect(() => {
        timestampAlignerRegistry.ingest(
          'nonexistent',
          1,
          makeSample(),
          Date.now()
        );
      }).not.toThrow();
    });
  });

  // ============================================================
  // ±200ms 내 쌍 매칭
  // ============================================================

  describe('±200ms 내 쌍 매칭', () => {
    it('두 subject 샘플 타임스탬프 차이 0ms → AlignedSample 생성됨', () => {
      // Arrange
      const groupId = 'grp-match';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const now = Date.now();
      const sample1 = makeSample(1.0);
      const sample2 = makeSample(2.0);

      // Act
      timestampAlignerRegistry.ingest(groupId, 1, sample1, now);
      timestampAlignerRegistry.ingest(groupId, 2, sample2, now);
      const result = timestampAlignerRegistry.flush(groupId);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].groupId).toBe(groupId);
      expect(result[0].subject_1).toEqual(sample1);
      expect(result[0].subject_2).toEqual(sample2);
      expect(typeof result[0].timestamp_ms).toBe('number');
    });

    it('두 subject 타임스탬프 차이 100ms (≤200ms) → 매칭됨', () => {
      // Arrange
      const groupId = 'grp-100ms';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const now = Date.now();

      // Act
      timestampAlignerRegistry.ingest(groupId, 1, makeSample(1.0), now);
      timestampAlignerRegistry.ingest(groupId, 2, makeSample(2.0), now + 100);
      const result = timestampAlignerRegistry.flush(groupId);

      // Assert
      expect(result).toHaveLength(1);
    });

    it('두 subject 타임스탬프 차이 200ms (경계값) → 매칭됨', () => {
      // Arrange
      const groupId = 'grp-200ms';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const now = Date.now();

      // Act
      timestampAlignerRegistry.ingest(groupId, 1, makeSample(1.0), now);
      timestampAlignerRegistry.ingest(groupId, 2, makeSample(2.0), now + 200);
      const result = timestampAlignerRegistry.flush(groupId);

      // Assert — 경계값 포함(≤200ms) 매칭됨
      expect(result).toHaveLength(1);
    });

    it('두 subject 타임스탬프 차이 201ms (>200ms) → 매칭 안 됨', () => {
      // Arrange
      const groupId = 'grp-201ms';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const now = Date.now();

      // Act
      timestampAlignerRegistry.ingest(groupId, 1, makeSample(1.0), now);
      timestampAlignerRegistry.ingest(groupId, 2, makeSample(2.0), now + 201);
      const result = timestampAlignerRegistry.flush(groupId);

      // Assert — 201ms > tolerance 200ms → 매칭 실패
      expect(result).toHaveLength(0);
    });

    it('AlignedSample timestamp_ms는 두 타임스탬프의 평균값임', () => {
      // Arrange — 현재 시각 기반 타임스탬프 사용 (만료 방지)
      const groupId = 'grp-avg';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const now = Date.now();
      // 100ms 차이 타임스탬프 — 평균이 정수로 맞아야 함
      const ts1 = now;
      const ts2 = now + 100;
      const expectedAvg = Math.round((ts1 + ts2) / 2);

      // Act
      timestampAlignerRegistry.ingest(groupId, 1, makeSample(), ts1);
      timestampAlignerRegistry.ingest(groupId, 2, makeSample(), ts2);
      const result = timestampAlignerRegistry.flush(groupId);

      // Assert — 두 타임스탬프의 평균값
      expect(result).toHaveLength(1);
      expect(result[0].timestamp_ms).toBe(expectedAvg);
    });
  });

  // ============================================================
  // 지연 샘플 보존 — flush 가 늦어져도 drop 하지 않음
  // ============================================================

  describe('지연 샘플 보존 (구 500ms 만료 drop 대체)', () => {
    // 이전에는 500ms 넘은 미매칭 샘플을 조용히 버렸다. flush 는 100ms 마다 돌지만
    // 이벤트 루프가 잠깐 멈추면 샘플이 tolerance 창을 건너뛰어 사라졌다. 늦게
    // 본 샘플도 정상 데이터라 pair 또는 단독으로 반드시 내보냄 (CodeRabbit #106)
    it('flush 가 600ms 늦어도 tolerance 내 두 샘플은 pair 로 emit됨', () => {
      // Arrange
      const groupId = 'grp-late-pair';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const oldTs = Date.now() - 600;
      const sample1 = makeSample(1.0);
      const sample2 = makeSample(2.0);

      // Act
      timestampAlignerRegistry.ingest(groupId, 1, sample1, oldTs);
      timestampAlignerRegistry.ingest(groupId, 2, sample2, oldTs);
      const result = timestampAlignerRegistry.flush(groupId);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].subject_1).toEqual(sample1);
      expect(result[0].subject_2).toEqual(sample2);
    });

    it('flush 가 늦어 둘 다 500ms 를 넘겼고 서로 tolerance 밖이면 각각 단독 emit됨', () => {
      // Arrange — 300ms 위상 차 스트림에서 이벤트 루프가 900ms 멈춘 상황
      const groupId = 'grp-stall';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const now = Date.now();
      const sample1 = makeSample(1.0);
      const sample2 = makeSample(2.0);
      timestampAlignerRegistry.ingest(groupId, 1, sample1, now - 900);
      timestampAlignerRegistry.ingest(groupId, 2, sample2, now - 600);

      // Act
      const result = timestampAlignerRegistry.flush(groupId);

      // Assert — 하나도 버리지 않고 둘 다 단독으로 나감. 버퍼는 비어 다음 flush 재emit 없음
      expect(result).toHaveLength(2);
      expect(
        result.map((s) => [s.subject_1 !== null, s.subject_2 !== null])
      ).toEqual([
        [true, false],
        [false, true],
      ]);
      expect(timestampAlignerRegistry.flush(groupId)).toHaveLength(0);
    });
  });

  // ============================================================
  // SocketService.emitToGroup 호출 검증
  // ============================================================

  describe('aligned_pair 이벤트 emitToGroup 호출', () => {
    it('매칭 성공 시 emitToGroup(groupId, aligned_pair, sample) 호출됨', () => {
      // Arrange
      const groupId = 'grp-emit';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const now = Date.now();

      // Act
      timestampAlignerRegistry.ingest(groupId, 1, makeSample(1.0), now);
      timestampAlignerRegistry.ingest(groupId, 2, makeSample(2.0), now);
      timestampAlignerRegistry.flush(groupId);

      // Assert
      expect(mockEmitToGroup).toHaveBeenCalledTimes(1);
      const [calledGroupId, calledEvent, calledPayload] =
        mockEmitToGroup.mock.calls[0];
      expect(calledGroupId).toBe(groupId);
      expect(calledEvent).toBe('aligned_pair');
      expect(calledPayload.groupId).toBe(groupId);
      expect(calledPayload).toHaveProperty('subject_1');
      expect(calledPayload).toHaveProperty('subject_2');
      expect(calledPayload).toHaveProperty('timestamp_ms');
    });

    it('매칭 실패 시 emitToGroup 미호출됨', () => {
      // Arrange — subject 1만 ingest, subject 2 없음
      const groupId = 'grp-no-match';
      timestampAlignerRegistry.getOrCreate(groupId, 200);

      // Act
      timestampAlignerRegistry.ingest(groupId, 1, makeSample(), Date.now());
      timestampAlignerRegistry.flush(groupId);

      // Assert
      expect(mockEmitToGroup).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // 단일 헤드셋 지원 — subject 2 단독 emit
  // ============================================================

  describe('단일 헤드셋 — subject 2 단독 emit', () => {
    it('subject 2가 tolerance 초과 대기(subject 1 없음) → subject_1:null로 단독 emit됨', () => {
      // Arrange — subject 1 헤드셋 없음, subject 2(노트북 B) 샘플이 페어링 윈도
      // (200ms) 를 넘겨 대기함 (250ms 전 ingest, 500ms 만료 전)
      const groupId = 'grp-single2';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const sample2 = makeSample(2.0);

      // Act
      timestampAlignerRegistry.ingest(groupId, 2, sample2, Date.now() - 250);
      const result = timestampAlignerRegistry.flush(groupId);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].subject_1).toBeNull();
      expect(result[0].subject_2).toEqual(sample2);
      expect(mockEmitToGroup).toHaveBeenCalledTimes(1);
      expect(mockEmitToGroup.mock.calls[0][1]).toBe('aligned_pair');
    });

    it('subject 2 단독 emit 후 버퍼 비워짐 — 다음 flush 재emit 없음', () => {
      // Arrange
      const groupId = 'grp-single2-clear';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      timestampAlignerRegistry.ingest(
        groupId,
        2,
        makeSample(2.0),
        Date.now() - 250
      );

      // Act — 1차 flush에서 단독 emit
      timestampAlignerRegistry.flush(groupId);
      mockEmitToGroup.mockClear();
      const second = timestampAlignerRegistry.flush(groupId);

      // Assert — 2차 flush는 빈 배열 + emit 없음
      expect(second).toHaveLength(0);
      expect(mockEmitToGroup).not.toHaveBeenCalled();
    });

    it('subject 1이 tolerance 내로 늦게 도착하면 조기 단독 emit 없이 pair로 매칭됨 (CodeRabbit #68 회귀)', () => {
      // Arrange — 2헤드셋 세션, subject 2 먼저 도착(아직 페어링 윈도 내)
      const groupId = 'grp-late1';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const now = Date.now();
      const sample1 = makeSample(1.0);
      const sample2 = makeSample(2.0);

      // Act 1 — subject 2만 있고 어림 → 단독 emit 안 함, 버퍼 유지
      timestampAlignerRegistry.ingest(groupId, 2, sample2, now);
      const first = timestampAlignerRegistry.flush(groupId);

      // Assert 1 — subject 1 지연을 single-headset으로 오판하지 않음
      expect(first).toHaveLength(0);
      expect(mockEmitToGroup).not.toHaveBeenCalled();

      // Act 2 — subject 1이 tolerance 내(100ms)로 늦게 도착
      timestampAlignerRegistry.ingest(groupId, 1, sample1, now + 100);
      const second = timestampAlignerRegistry.flush(groupId);

      // Assert 2 — 조기 solo가 아니라 pair로 매칭됨
      expect(second).toHaveLength(1);
      expect(second[0].subject_1).toEqual(sample1);
      expect(second[0].subject_2).toEqual(sample2);
    });
  });

  // ============================================================
  // subject 1 단독 emit — subject 2 분기와 대칭 (2026-09-07 측정 회귀)
  // ============================================================

  describe('단일 헤드셋 — subject 1 단독 emit', () => {
    // 2026-09-07 2PC 측정에서 두 엔진의 도착 위상 차가 200ms 를 넘는 동안
    // subject 1 은 매칭 실패 후 500ms 뒤 조용히 drop 되고 subject 2 만 단독
    // emit 됐다. BE 는 두 subject 를 다 받고 있었는데 화면은 1 만 STALE 이었다.
    it('subject 1이 tolerance 초과 대기(subject 2 없음) → subject_2:null로 단독 emit됨', () => {
      // Arrange
      const groupId = 'grp-single1';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const sample1 = makeSample(1.0);

      // Act
      timestampAlignerRegistry.ingest(groupId, 1, sample1, Date.now() - 250);
      const result = timestampAlignerRegistry.flush(groupId);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].subject_1).toEqual(sample1);
      expect(result[0].subject_2).toBeNull();
      expect(mockEmitToGroup).toHaveBeenCalledTimes(1);
      expect(mockEmitToGroup.mock.calls[0][1]).toBe('aligned_pair');
    });

    it('subject 1 단독 emit 후 버퍼 비워짐 — 다음 flush 재emit 없음', () => {
      // Arrange
      const groupId = 'grp-single1-clear';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      timestampAlignerRegistry.ingest(
        groupId,
        1,
        makeSample(1.0),
        Date.now() - 250
      );

      // Act
      timestampAlignerRegistry.flush(groupId);
      mockEmitToGroup.mockClear();
      const second = timestampAlignerRegistry.flush(groupId);

      // Assert
      expect(second).toHaveLength(0);
      expect(mockEmitToGroup).not.toHaveBeenCalled();
    });

    it('두 subject가 tolerance 초과 위상 차로 계속 들어오면 둘 다 단독 emit됨 (2026-09-07 실측)', () => {
      // Arrange — 1Hz 두 스트림이 300ms 어긋나 도착. 상대 버퍼가 비는 순간이
      // 없어, "상대 버퍼 비움"을 조건으로 걸면 먼저 온 쪽이 500ms 만료로 항상
      // drop 됨. tolerance 를 넘겨 기다린 샘플은 미래 파트너와도 못 맞으므로
      // 상대 버퍼와 무관하게 혼자 나가야 함
      const groupId = 'grp-phase300';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const now = Date.now();
      const sample1 = makeSample(1.0);
      const sample2 = makeSample(2.0);
      timestampAlignerRegistry.ingest(groupId, 1, sample1, now - 300);
      timestampAlignerRegistry.ingest(groupId, 2, sample2, now);

      // Act
      const result = timestampAlignerRegistry.flush(groupId);

      // Assert — subject 1 은 혼자 나가고, 아직 어린 subject 2 는 버퍼에 남음
      expect(result).toHaveLength(1);
      expect(result[0].subject_1).toEqual(sample1);
      expect(result[0].subject_2).toBeNull();
      expect(mockEmitToGroup).toHaveBeenCalledTimes(1);
    });

    it('subject 2가 tolerance 내로 늦게 도착하면 조기 단독 emit 없이 pair로 매칭됨', () => {
      // Arrange — subject 1 먼저 도착(아직 페어링 윈도 내)
      const groupId = 'grp-late2';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const now = Date.now();
      const sample1 = makeSample(1.0);
      const sample2 = makeSample(2.0);

      // Act 1 — subject 1만 있고 어림 → 단독 emit 안 함
      timestampAlignerRegistry.ingest(groupId, 1, sample1, now);
      const first = timestampAlignerRegistry.flush(groupId);

      // Assert 1
      expect(first).toHaveLength(0);
      expect(mockEmitToGroup).not.toHaveBeenCalled();

      // Act 2 — subject 2가 tolerance 내(100ms)로 늦게 도착
      timestampAlignerRegistry.ingest(groupId, 2, sample2, now + 100);
      const second = timestampAlignerRegistry.flush(groupId);

      // Assert 2 — pair로 매칭됨
      expect(second).toHaveLength(1);
      expect(second[0].subject_1).toEqual(sample1);
      expect(second[0].subject_2).toEqual(sample2);
    });
  });

  // ============================================================
  // v8 C-1: brain_sync_all 타입 가드 소스 검증
  // ============================================================

  describe('v8 C-1: brain_sync_all 타입 가드 (정적 검증)', () => {
    it('measurement.service.ts에 brain_sync_all 타입 가드가 존재함', () => {
      const fs = require('fs');
      const path = require('path');
      const serviceSource = fs.readFileSync(
        path.resolve(__dirname, 'measurement.service.ts'),
        'utf-8'
      );
      // v8 C-1: brain_sync_all 외 타입은 ingest 안 됨
      expect(serviceSource).toContain("parsed.type !== 'brain_sync_all'");
      expect(serviceSource).toContain('return;');
    });
  });
});
