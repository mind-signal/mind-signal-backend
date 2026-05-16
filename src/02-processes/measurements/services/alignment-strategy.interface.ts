import type { SampleEnvelope } from '@07-shared/schemas/measurement-envelope.schema';
import type { AlignedSample } from './timestamp-aligner.service';

// Phase 18 ADR §C: 스트리밍 계약 기준 키 필드 — proxy ingress 나노초 타임스탬프 필드명
export const ALIGNMENT_TS_FIELD = 'proxy_ingress_ts_ns' as const;

/**
 * 샘플 정렬 전략 인터페이스 (Phase 18 ADR §C 스트리밍 계약).
 * pairwise align(a,b) 시그니처 금지 — ingest/flush 스트리밍 패턴만 허용함.
 */
export interface IAlignmentStrategy {
  readonly keyField: typeof ALIGNMENT_TS_FIELD;
  /**
   * 단일 SampleEnvelope를 내부 버퍼에 적재함.
   *
   * @param envelope - 검증된 SampleEnvelope 인스턴스
   */
  ingest(envelope: SampleEnvelope): void;
  /**
   * 내부 버퍼를 스캔하여 정렬된 AlignedSample 배열 반환함.
   *
   * @param groupId - 실험 그룹 ID
   * @returns 정렬된 AlignedSample 배열
   */
  flush(groupId: string): AlignedSample[];
}

// Phase 18 config.alignmentLocation 타입 재사용 편의용 export
export type AlignmentLocation = 'be' | 'proxy';
