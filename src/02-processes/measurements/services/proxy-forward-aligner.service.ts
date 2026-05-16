import type { SampleEnvelope } from '@07-shared/schemas/measurement-envelope.schema';
import {
  ALIGNMENT_TS_FIELD,
  type IAlignmentStrategy,
} from './alignment-strategy.interface';
import type { AlignedSample } from './timestamp-aligner.service';

/**
 * 프록시 위임 정렬 전략 — Stage-2 ADR 후보 (Phase 18 ADR §C).
 * Wave-1에서는 미구현 상태로 유지하며 throw 처리함.
 */
export class ProxyForwardAligner implements IAlignmentStrategy {
  // Phase 18 ADR §C: 스트리밍 계약 키 필드 고정
  readonly keyField = ALIGNMENT_TS_FIELD;

  /**
   * 미구현 — Stage-2 ADR 결정 후 구현 예정.
   *
   * @param _envelope - 미사용 (미구현)
   * @throws Error 항상 throw — not implemented
   */
  ingest(_envelope: SampleEnvelope): void {
    throw new Error(
      'not implemented — proxy-forward alignment is a Stage-2 ADR candidate'
    );
  }

  /**
   * 미구현 — Stage-2 ADR 결정 후 구현 예정.
   *
   * @param _groupId - 미사용 (미구현)
   * @throws Error 항상 throw — not implemented
   */
  flush(_groupId: string): AlignedSample[] {
    throw new Error(
      'not implemented — proxy-forward alignment is a Stage-2 ADR candidate'
    );
  }
}
