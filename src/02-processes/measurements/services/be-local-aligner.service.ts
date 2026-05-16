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
 * Wave-1 행위 보존: proxy_ingress_ts_ns BigInt 나노초 핵심 변경은
 * Wave-2 T1-BE-H 작업 범위. 현재는 기존 Date.now() 기반 레지스트리
 * 동작을 그대로 유지함 (ADR §A/§E 회귀 보존).
 */
export class BeLocalAligner implements IAlignmentStrategy {
  // Phase 18 ADR §C: 스트리밍 계약 키 필드 고정
  readonly keyField = ALIGNMENT_TS_FIELD;

  /**
   * SampleEnvelope를 기존 timestampAlignerRegistry.ingest에 위임함.
   * Wave-1: serverTimestamp는 Date.now() 사용 (ADR §E 회귀 보존).
   *
   * @param envelope - 검증된 SampleEnvelope 인스턴스
   */
  ingest(envelope: SampleEnvelope): void {
    // Wave-1 행위 보존 — proxy_ingress_ts_ns BigInt 변환은 Wave-2 T1-BE-H 범위임
    timestampAlignerRegistry.ingest(
      envelope.group_id,
      envelope.subject_idx,
      envelope.payload,
      Date.now()
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
