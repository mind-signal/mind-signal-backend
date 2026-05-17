/**
 * timestamp-aligner.service.ts — Unit 테스트 (BE-aligner)
 *
 * 검증 항목:
 *   - proxyIngressTsNs(decimal-string 나노초) 기준 두 subject 샘플 → AlignedSample 생성 + SocketService.emitToGroup 호출
 *   - 500ms 초과 샘플 → drop (expired)
 *   - registry 수명 관리 — getOrCreate, cleanup
 *   - v8 C-1: brain_sync_all 타입 가드 (measurement.service 소스 검증)
 *   - fence test A/B: proxyIngressTsNs 기반 매칭 증명 (ADR §A / R4-2)
 */

import { timestampAlignerRegistry } from './timestamp-aligner.service';
import type { WavePower } from './timestamp-aligner.service';

// SocketService 모킹 — 실제 소켓 서버 없이 호출 검증
jest.mock('@07-shared/lib/socket', () => ({
  SocketService: {
    emitToGroup: jest.fn(),
  },
}));

import { SocketService } from '@07-shared/lib/socket';

const mockEmitToGroup = SocketService.emitToGroup as jest.Mock;

/** 테스트용 샘플 EEG WavePower */
const makeSample = (base = 1.0): WavePower => ({
  delta: base,
  theta: base + 0.1,
  alpha: base + 0.2,
  beta: base + 0.3,
  gamma: base + 0.4,
});

describe('timestampAlignerRegistry — BE-aligner', () => {
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
          String(BigInt(Date.now()) * 1_000_000n)
        );
      }).not.toThrow();
    });
  });

  // ============================================================
  // proxyIngressTsNs(nanoseconds decimal-string) 기준 쌍 매칭
  // ============================================================

  describe('proxyIngressTsNs 기준 쌍 매칭', () => {
    it('두 subject 샘플 ns 차이 0 → AlignedSample 생성됨', () => {
      // Arrange
      const groupId = 'grp-match';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const nowNs = String(BigInt(Date.now()) * 1_000_000n);
      const sample1 = makeSample(1.0);
      const sample2 = makeSample(2.0);

      // Act
      timestampAlignerRegistry.ingest(groupId, 1, sample1, nowNs);
      timestampAlignerRegistry.ingest(groupId, 2, sample2, nowNs);
      const result = timestampAlignerRegistry.flush(groupId);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].groupId).toBe(groupId);
      expect(result[0].subject_1).toEqual(sample1);
      expect(result[0].subject_2).toEqual(sample2);
      expect(typeof result[0].timestamp_ms).toBe('number');
    });

    it('두 subject ns 차이 100ms (≤200ms) → 매칭됨', () => {
      // Arrange
      const groupId = 'grp-100ms';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const nowNs = String(BigInt(Date.now()) * 1_000_000n);
      const ns100later = String(BigInt(nowNs) + 100_000_000n);

      // Act
      timestampAlignerRegistry.ingest(groupId, 1, makeSample(1.0), nowNs);
      timestampAlignerRegistry.ingest(groupId, 2, makeSample(2.0), ns100later);
      const result = timestampAlignerRegistry.flush(groupId);

      // Assert
      expect(result).toHaveLength(1);
    });

    it('두 subject ns 차이 200ms (경계값) → 매칭됨', () => {
      // Arrange
      const groupId = 'grp-200ms';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const nowNs = String(BigInt(Date.now()) * 1_000_000n);
      const ns200later = String(BigInt(nowNs) + 200_000_000n);

      // Act
      timestampAlignerRegistry.ingest(groupId, 1, makeSample(1.0), nowNs);
      timestampAlignerRegistry.ingest(groupId, 2, makeSample(2.0), ns200later);
      const result = timestampAlignerRegistry.flush(groupId);

      // Assert — 경계값 포함(≤200ms) 매칭됨
      expect(result).toHaveLength(1);
    });

    it('두 subject ns 차이 201ms (>200ms) → 매칭 안 됨', () => {
      // Arrange
      const groupId = 'grp-201ms';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const nowNs = String(BigInt(Date.now()) * 1_000_000n);
      const ns201later = String(BigInt(nowNs) + 201_000_000n);

      // Act
      timestampAlignerRegistry.ingest(groupId, 1, makeSample(1.0), nowNs);
      timestampAlignerRegistry.ingest(groupId, 2, makeSample(2.0), ns201later);
      const result = timestampAlignerRegistry.flush(groupId);

      // Assert — 201ms > tolerance 200ms → 매칭 실패
      expect(result).toHaveLength(0);
    });

    it('AlignedSample timestamp_ms는 두 proxyIngressTsNs 평균값 (ms 변환)임', () => {
      // Arrange — 현재 시각 기반 ns 타임스탬프 사용 (만료 방지)
      const groupId = 'grp-avg';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const baseMs = Date.now();
      const nsA = BigInt(baseMs) * 1_000_000n;
      const nsB = nsA + 100_000_000n; // 100ms 차이
      // 독립 ms 도메인 오라클 — 두 ns 중점은 baseMs + 50ms (impl 식 미러 아님)
      const expectedAvg = baseMs + 50;

      // Act
      timestampAlignerRegistry.ingest(groupId, 1, makeSample(), String(nsA));
      timestampAlignerRegistry.ingest(groupId, 2, makeSample(), String(nsB));
      const result = timestampAlignerRegistry.flush(groupId);

      // Assert — 두 proxyIngressTsNs BigInt 평균을 ms 변환한 값
      expect(result).toHaveLength(1);
      expect(result[0].timestamp_ms).toBe(expectedAvg);
    });
  });

  // ============================================================
  // 500ms 만료 drop (proxyIngressTsNs BigInt 기준)
  // ============================================================

  describe('500ms 만료 drop', () => {
    it('500ms 초과 ns 샘플 → flush 시 drop됨 (매칭 없음)', () => {
      // Arrange
      const groupId = 'grp-expire';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      // 600ms 이전 ns 타임스탬프 (Date.now() - 600ms → ns)
      const oldNs = String(BigInt(Date.now()) * 1_000_000n - 600_000_000n);

      // Act
      timestampAlignerRegistry.ingest(groupId, 1, makeSample(), oldNs);
      timestampAlignerRegistry.ingest(groupId, 2, makeSample(), oldNs);
      // flush 시 nowNs - oldNs > 500ms → 만료 drop
      const result = timestampAlignerRegistry.flush(groupId);

      // Assert — 만료로 drop → 빈 배열 반환
      expect(result).toHaveLength(0);
    });

    it('만료 샘플은 버퍼에서 제거되고 다음 flush에서 재처리 안 됨', () => {
      // Arrange
      const groupId = 'grp-expire-clean';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const oldNs = String(BigInt(Date.now()) * 1_000_000n - 600_000_000n);

      // Act — 1차 flush에서 drop
      timestampAlignerRegistry.ingest(groupId, 1, makeSample(), oldNs);
      timestampAlignerRegistry.flush(groupId);

      // 2차 flush — 버퍼가 비어 있어야 함
      const result2 = timestampAlignerRegistry.flush(groupId);

      // Assert
      expect(result2).toHaveLength(0);
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
      const nowNs = String(BigInt(Date.now()) * 1_000_000n);

      // Act
      timestampAlignerRegistry.ingest(groupId, 1, makeSample(1.0), nowNs);
      timestampAlignerRegistry.ingest(groupId, 2, makeSample(2.0), nowNs);
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
      timestampAlignerRegistry.ingest(
        groupId,
        1,
        makeSample(),
        String(BigInt(Date.now()) * 1_000_000n)
      );
      timestampAlignerRegistry.flush(groupId);

      // Assert
      expect(mockEmitToGroup).not.toHaveBeenCalled();
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

  // ============================================================
  // fence test A/B — proxyIngressTsNs 기반 매칭 분리 증명 (ADR §A / R4-2)
  // ============================================================

  describe('fence test — proxyIngressTsNs 기반 매칭 ADR §A / R4-2 증명', () => {
    it('flush()가 proxyIngressTsNs 기준으로 매칭함 — window 내 ns pair → 1쌍 (fence test A)', () => {
      const groupId = 'grp-fence-a';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const nsA = String(BigInt(Date.now()) * 1_000_000n);
      const nsB = String(BigInt(nsA) + 50_000_000n); // ns delta 50ms < tol 200ms → 매칭
      timestampAlignerRegistry.ingest(groupId, 1, makeSample(1.0), nsA);
      timestampAlignerRegistry.ingest(groupId, 2, makeSample(2.0), nsB);
      expect(timestampAlignerRegistry.flush(groupId)).toHaveLength(1);
    });

    it('flush()가 proxyIngressTsNs 기준으로 매칭함 — ns window 초과 → 0쌍 (fence test B)', () => {
      const groupId = 'grp-fence-b';
      timestampAlignerRegistry.getOrCreate(groupId, 200);
      const nsA = String(BigInt(Date.now()) * 1_000_000n);
      const nsC = String(BigInt(nsA) + 300_000_000n); // ns delta 300ms > tol 200ms → 불일치
      timestampAlignerRegistry.ingest(groupId, 1, makeSample(1.0), nsA);
      timestampAlignerRegistry.ingest(groupId, 2, makeSample(2.0), nsC);
      // Date.now()로 매칭했다면 둘 다 동일 ms라 delta≈0 → 1쌍 통과. 0쌍이어야 ns 기반 증명.
      expect(timestampAlignerRegistry.flush(groupId)).toHaveLength(0);
    });
  });
});
