import { config } from '@07-shared/config/config';
import type { IAlignmentStrategy } from './alignment-strategy.interface';
import { BeLocalAligner } from './be-local-aligner.service';
import { ProxyForwardAligner } from './proxy-forward-aligner.service';

/**
 * config.alignmentLocation 값에 따라 정렬 전략 인스턴스 반환함.
 * 기본값 'be' → BeLocalAligner, 'proxy' → ProxyForwardAligner.
 *
 * @returns IAlignmentStrategy 구현 인스턴스
 */
export function getAlignmentStrategy(): IAlignmentStrategy {
  return config.alignmentLocation === 'proxy'
    ? new ProxyForwardAligner()
    : new BeLocalAligner();
}
