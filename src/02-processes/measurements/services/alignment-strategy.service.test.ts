/* eslint-disable camelcase */
/**
 * alignment-strategy — IAlignmentStrategy 구현체 + factory 단위 테스트
 *
 * 검증 항목:
 *   - BeLocalAligner / ProxyForwardAligner 모두 keyField === ALIGNMENT_TS_FIELD
 *   - IAlignmentStrategy 형태 준수: ingest/flush 존재, align 없음 (ADR §C pairwise 금지)
 *   - ProxyForwardAligner.ingest/flush → throw (not implemented)
 *   - getAlignmentStrategy() → 기본값 'be' 시 BeLocalAligner 반환
 *   - getAlignmentStrategy() → 'proxy' 시 ProxyForwardAligner 반환
 */

// ---------------------------------------------------------------------------
// config 모킹 — alignmentLocation 주입 가능하도록 mutable 객체 사용
// ---------------------------------------------------------------------------
const mockConfig = {
  env: 'test',
  alignmentLocation: 'be' as 'be' | 'proxy',
};

jest.mock('@07-shared/config/config', () => ({
  get config() {
    return mockConfig;
  },
}));

// ---------------------------------------------------------------------------
// timestampAlignerRegistry 모킹 — BeLocalAligner 위임 테스트용
// ---------------------------------------------------------------------------
jest.mock('./timestamp-aligner.service', () => ({
  timestampAlignerRegistry: {
    ingest: jest.fn(),
    flush: jest.fn().mockReturnValue([]),
    getOrCreate: jest.fn(),
    cleanup: jest.fn(),
    __resetForTest__: jest.fn(),
  },
}));

// SocketService 모킹 — timestamp-aligner 내부 소켓 호출 방지
jest.mock('@07-shared/lib/socket', () => ({
  SocketService: {
    emitToGroup: jest.fn(),
  },
}));

import { ALIGNMENT_TS_FIELD } from './alignment-strategy.interface';
import { BeLocalAligner } from './be-local-aligner.service';
import { ProxyForwardAligner } from './proxy-forward-aligner.service';
import { getAlignmentStrategy } from './alignment-strategy.factory';
import { timestampAlignerRegistry } from './timestamp-aligner.service';
import type { SampleEnvelope } from '@07-shared/schemas/measurement-envelope.schema';

/** 테스트용 최소 유효 SampleEnvelope */
const makeEnvelope = (
  groupId = 'grp-test',
  subjectIdx = 0
): SampleEnvelope => ({
  group_id: groupId,
  subject_idx: subjectIdx,
  de_ts_ns: '1000000000000000000',
  proxy_ingress_ts_ns: '1000000000000000001',
  seq: 1,
  payload: {
    delta: 1.0,
    theta: 2.0,
    alpha: 3.0,
    beta: 4.0,
    gamma: 5.0,
  },
  sync_meta: {},
});

describe('IAlignmentStrategy 구현체 — keyField / 형태 검증', () => {
  // ============================================================
  // keyField 검증
  // ============================================================

  describe('keyField === ALIGNMENT_TS_FIELD', () => {
    it('BeLocalAligner.keyField 는 ALIGNMENT_TS_FIELD 와 동일함', () => {
      const aligner = new BeLocalAligner();
      // ALIGNMENT_TS_FIELD = 'proxy_ingress_ts_ns'
      expect(aligner.keyField).toBe(ALIGNMENT_TS_FIELD);
      expect(aligner.keyField).toBe('proxy_ingress_ts_ns');
    });

    it('ProxyForwardAligner.keyField 는 ALIGNMENT_TS_FIELD 와 동일함', () => {
      const aligner = new ProxyForwardAligner();
      expect(aligner.keyField).toBe(ALIGNMENT_TS_FIELD);
      expect(aligner.keyField).toBe('proxy_ingress_ts_ns');
    });
  });

  // ============================================================
  // IAlignmentStrategy 형태 검증 (ingest/flush 존재, align 없음)
  // ============================================================

  describe('IAlignmentStrategy 형태 준수 — ingest/flush 존재, align 없음 (ADR §C)', () => {
    it('BeLocalAligner 인스턴스에 ingest 메서드가 존재함', () => {
      const aligner = new BeLocalAligner();
      expect(typeof aligner.ingest).toBe('function');
    });

    it('BeLocalAligner 인스턴스에 flush 메서드가 존재함', () => {
      const aligner = new BeLocalAligner();
      expect(typeof aligner.flush).toBe('function');
    });

    it('BeLocalAligner 인스턴스에 align 메서드가 없음 (pairwise align 금지 — ADR §C)', () => {
      const aligner = new BeLocalAligner();
      expect(
        (aligner as unknown as Record<string, unknown>).align
      ).toBeUndefined();
    });

    it('ProxyForwardAligner 인스턴스에 ingest 메서드가 존재함', () => {
      const aligner = new ProxyForwardAligner();
      expect(typeof aligner.ingest).toBe('function');
    });

    it('ProxyForwardAligner 인스턴스에 flush 메서드가 존재함', () => {
      const aligner = new ProxyForwardAligner();
      expect(typeof aligner.flush).toBe('function');
    });

    it('ProxyForwardAligner 인스턴스에 align 메서드가 없음 (pairwise align 금지 — ADR §C)', () => {
      const aligner = new ProxyForwardAligner();
      expect(
        (aligner as unknown as Record<string, unknown>).align
      ).toBeUndefined();
    });
  });
});

describe('ProxyForwardAligner — not implemented throw 검증', () => {
  it('ingest() 호출 시 "not implemented" 메시지 포함 에러 throw함', () => {
    const aligner = new ProxyForwardAligner();
    expect(() => aligner.ingest(makeEnvelope())).toThrow('not implemented');
  });

  it('flush() 호출 시 "not implemented" 메시지 포함 에러 throw함', () => {
    const aligner = new ProxyForwardAligner();
    expect(() => aligner.flush('grp-test')).toThrow('not implemented');
  });
});

describe('BeLocalAligner — timestampAlignerRegistry 위임 검증', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('ingest() — subject_idx=1 을 변환 없이 그대로 registry에 전달함 (contract pass-through)', () => {
    // Arrange — subject_idx=1 (1-based, 변환 없이 그대로 전달됨)
    const aligner = new BeLocalAligner();
    const envelope = makeEnvelope('grp-be', 1);
    aligner.ingest(envelope);

    // Assert — subject_idx=1 → registry에 1 그대로 전달됨 (+1/-1 변환 없음)
    expect(timestampAlignerRegistry.ingest).toHaveBeenCalledWith(
      'grp-be',
      1,
      envelope.payload,
      expect.any(Number)
    );
  });

  it('ingest() — subject_idx=2 을 변환 없이 그대로 registry에 전달함 (contract pass-through)', () => {
    // Arrange — subject_idx=2 (1-based, 변환 없이 그대로 전달됨)
    const aligner = new BeLocalAligner();
    const envelope = makeEnvelope('grp-be', 2);
    aligner.ingest(envelope);

    // Assert — subject_idx=2 → registry에 2 그대로 전달됨 (+1/-1 변환 없음)
    expect(timestampAlignerRegistry.ingest).toHaveBeenCalledWith(
      'grp-be',
      2,
      envelope.payload,
      expect.any(Number)
    );
  });

  it('flush() 호출 시 timestampAlignerRegistry.flush에 위임하고 결과 반환함', () => {
    const aligner = new BeLocalAligner();
    const result = aligner.flush('grp-be');

    expect(timestampAlignerRegistry.flush).toHaveBeenCalledWith('grp-be');
    expect(result).toEqual([]);
  });
});

describe('getAlignmentStrategy() — factory 반환 타입 검증', () => {
  beforeEach(() => {
    // 기본값으로 리셋함
    mockConfig.alignmentLocation = 'be';
  });

  it('alignmentLocation = "be" 일 때 BeLocalAligner 인스턴스 반환함', () => {
    mockConfig.alignmentLocation = 'be';
    const strategy = getAlignmentStrategy();
    expect(strategy).toBeInstanceOf(BeLocalAligner);
  });

  it('alignmentLocation = "proxy" 일 때 ProxyForwardAligner 인스턴스 반환함', () => {
    mockConfig.alignmentLocation = 'proxy';
    const strategy = getAlignmentStrategy();
    expect(strategy).toBeInstanceOf(ProxyForwardAligner);
  });
});
