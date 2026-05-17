import type { SampleEnvelope } from '@07-shared/schemas/measurement-envelope.schema';
import {
  ALIGNMENT_TS_FIELD,
  type IAlignmentStrategy,
} from './alignment-strategy.interface';
import {
  timestampAlignerRegistry,
  type AlignedSample,
} from './timestamp-aligner.service';

/**
 * BE-local 정렬 전략 — Stage-1 기본값 (Phase 18 ADR §A/§E).
 *
 * Wave-2 T1-BE-H: proxy_ingress_ts_ns decimal-string 나노초를
 * timestampAlignerRegistry.ingest에 직접 전달함 (ADR §A 정렬 권한 변경).
 */
export class BeLocalAligner implements IAlignmentStrategy {
  // Phase 18 ADR §C: 스트리밍 계약 키 필드 고정
  readonly keyField = ALIGNMENT_TS_FIELD;

  /**
   * SampleEnvelope를 timestampAlignerRegistry.ingest에 위임함.
   * proxy_ingress_ts_ns를 정렬 키로 전달 (ADR §A T1-BE-H 범위).
   *
   * @param envelope - 검증된 SampleEnvelope 인스턴스
   */
  ingest(envelope: SampleEnvelope): void {
    // proxy_ingress_ts_ns decimal-string 나노초를 aligner에 전달함 (ADR §A)
    timestampAlignerRegistry.ingest(
      envelope.group_id,
      envelope.subject_idx,
      envelope.payload,
      envelope.proxy_ingress_ts_ns
    );
  }

  /**
   * 해당 groupId의 버퍼를 스캔하여 정렬된 AlignedSample 배열 반환함.
   * 기존 timestampAlignerRegistry.flush에 위임함.
   *
   * @param groupId - 실험 그룹 ID
   * @returns 정렬된 AlignedSample 배열
   */
  flush(groupId: string): AlignedSample[] {
    return timestampAlignerRegistry.flush(groupId);
  }
}
