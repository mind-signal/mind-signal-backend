/**
 * experiment.ts — 실험 모드 상수 정의
 *
 * BTI: BTI 전용 측정 모드 (PARTIAL 폴백 분석에도 사용됨)
 * DUAL_2PC: 2PC 타임스탬프 정렬 측정 모드. 현행 운영 경로임
 *
 * DUAL 과 SEQUENTIAL 은 SESSION-W002(2026-08-04)에서 제거함
 *
 * 이 파일은 측정 수행 방식 축임. 분석 방식 축인 AnalysisResult.analysis_mode
 * 와 값이 겹치지만 다른 축이고 개수도 다름 — DUAL_2PC 측정 결과는
 * analysis_mode 에 'DUAL' 로 저장됨. 그 'DUAL' 은 여기 DUAL 이 아님
 */

export const EXPERIMENT_MODES = {
  BTI: 'BTI',
  DUAL_2PC: 'DUAL_2PC',
} as const;

export type ExperimentMode =
  (typeof EXPERIMENT_MODES)[keyof typeof EXPERIMENT_MODES];
