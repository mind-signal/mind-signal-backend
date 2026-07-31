/**
 * session-coverage.service.ts — 수집량 기반 분석 게이트 회귀 검증
 *
 * 회귀 배경(2026-07-10 라이브, groupId 6a508a6b1048b553eea41778):
 *   subject_1의 core.main 프로세스는 604.8초 살아 있었으나 Cortex 스트림이
 *   227초 지점에서 조용히 끊겨 CSV는 227행뿐이었다. 그럼에도 티어 판정이
 *   measuredDurationSeconds(605초)만 보고 VALID로 분류해 절반이 빈 데이터로
 *   동조율 분석이 실행됐다.
 */

import {
  MIN_COVERAGE_RATIO,
  computeCoverage,
  evaluateSubjectCoverage,
} from './session-coverage.service';

const MIN_ANALYSIS_SECONDS = 180;

describe('computeCoverage: 프로세스 생존 시간 대비 실제 수집률', () => {
  it('2026-07-10 subject_1 실측값 (227행 / 605초)', () => {
    expect(computeCoverage(227, 605)).toBeCloseTo(0.375, 3);
  });

  it('2026-07-10 subject_2 실측값 (600행 / 605초)은 온전함', () => {
    expect(computeCoverage(600, 605)).toBeCloseTo(0.992, 2);
  });

  it('수집이 초과해도 1을 넘지 않음', () => {
    expect(computeCoverage(700, 600)).toBe(1);
  });

  it('측정 시간이 없거나 0이면 0 반환', () => {
    expect(computeCoverage(100, null)).toBe(0);
    expect(computeCoverage(100, 0)).toBe(0);
  });
});

describe('evaluateSubjectCoverage: 분석 게이트', () => {
  it('2026-07-10 subject_1을 거부함 (구 로직은 VALID로 통과시켰음)', () => {
    const v = evaluateSubjectCoverage(227, 605, MIN_ANALYSIS_SECONDS);
    expect(v.valid).toBe(false);
    expect(v.reason).toContain('수집률 미달');
  });

  it('2026-07-10 subject_2는 통과함', () => {
    const v = evaluateSubjectCoverage(600, 605, MIN_ANALYSIS_SECONDS);
    expect(v.valid).toBe(true);
  });

  it('측정 시간이 최소치 미만이면 거부함', () => {
    const v = evaluateSubjectCoverage(170, 170, MIN_ANALYSIS_SECONDS);
    expect(v.valid).toBe(false);
    expect(v.reason).toContain('측정 시간 부족');
  });

  it('시간은 충분하나 샘플이 최소치 미만이면 거부함', () => {
    const v = evaluateSubjectCoverage(150, 200, MIN_ANALYSIS_SECONDS);
    expect(v.valid).toBe(false);
    expect(v.reason).toContain('수집 샘플 부족');
  });

  it('측정 시간 미기록이면 거부함', () => {
    const v = evaluateSubjectCoverage(200, null, MIN_ANALYSIS_SECONDS);
    expect(v.valid).toBe(false);
    expect(v.reason).toContain('측정 시간 미기록');
  });

  it('coverage 임계 경계에서 통과와 거부가 갈림', () => {
    const duration = 300;
    const atThreshold = Math.ceil(duration * MIN_COVERAGE_RATIO);
    expect(
      evaluateSubjectCoverage(atThreshold, duration, MIN_ANALYSIS_SECONDS).valid
    ).toBe(true);
    expect(
      evaluateSubjectCoverage(atThreshold - 2, duration, MIN_ANALYSIS_SECONDS)
        .valid
    ).toBe(false);
  });
});
