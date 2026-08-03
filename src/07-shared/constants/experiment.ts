/**
 * experiment.ts — 실험 모드 상수 정의
 *
 * DUAL: 1PC 2헤드셋 동시 측정 모드 (레거시 기본값)
 * BTI: BTI 전용 측정 모드
 * SEQUENTIAL: 1PC 시분할 측정 모드 (Phase 14 P2)
 * DUAL_2PC: 2PC 타임스탬프 정렬 측정 모드 (Phase 16). 현행 운영 경로임
 *
 * 이 파일은 측정 수행 방식 축임. 분석 방식 축인 AnalysisResult.analysis_mode
 * 와 값이 겹치지만 다른 축이고 개수도 다름 — DUAL_2PC 측정 결과는
 * analysis_mode 에 'DUAL' 로 저장됨. 그 'DUAL' 은 여기 DUAL 이 아님
 */

export const EXPERIMENT_MODES = {
  DUAL: 'DUAL',
  BTI: 'BTI',
  SEQUENTIAL: 'SEQUENTIAL', // 시분할 측정 (1PC 환경, Phase 14 P2)
  DUAL_2PC: 'DUAL_2PC', // Phase 16
} as const;

export type ExperimentMode =
  (typeof EXPERIMENT_MODES)[keyof typeof EXPERIMENT_MODES];
