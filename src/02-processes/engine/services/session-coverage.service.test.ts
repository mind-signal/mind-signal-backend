/**
 * session-coverage.service.ts — 수집량 기반 분석 게이트 회귀 검증
 *
 * 회귀 배경(2026-07-10 라이브, groupId 6a508a6b1048b553eea41778):
 *   subject_1의 core.main 프로세스는 604.8초 살아 있었으나 CSV는 227행뿐이라
 *   행 수 나누기 wall-clock이 0.375였다. 당시에는 이것을 "절반이 빈 데이터"로
 *   진단하고 게이트를 도입했다.
 *
 * 진단 정정(2026-07-31, 원본 CSV 재분석):
 *   그 227행은 비어 있지 않았다. 15:01:41부터 15:05:28까지 간격 중앙값
 *   0.999초로 빽빽했고 1.5초 초과 공백은 1건뿐이었다. 데이터가 빈 것이 아니라
 *   기록이 227초에서 일찍 끝난 것이다. subject_2와의 절대시각 겹침도 227초로
 *   최소 분석 시간 180초를 넘는다.
 *
 *   같은 현상이 2026-07-31에 재발했다(subject_1: 282행, 내부 공백 0개,
 *   span 280.9초인데 282/368 = 76.6%로 탈락). 분자는 Cortex 취득 시각 기준
 *   행 수이고 분모는 BE의 wall-clock이라 서로 다른 시계를 나누고 있었다.
 *
 *   그래서 게이트를 밀도(행 수 나누기 CSV 자신의 span)로 바꿨다. 최소 측정
 *   시간과 최소 행 수 게이트는 그대로 두어 짧은 측정은 여전히 막는다.
 *   완주율(span 나누기 wall-clock)은 관측 지표로만 남긴다.
 */

import {
  MIN_COVERAGE_RATIO,
  computeCompletionRatio,
  computeDensity,
  evaluateSubjectCoverage,
} from './session-coverage.service';

const MIN_ANALYSIS_SECONDS = 180;

/** 실측 기반 픽스처. span은 원본 CSV 첫 행과 마지막 행 차이임 */
const CASE = {
  /** 2026-07-10 subject_1 — 227초에서 조기 종료, 내부는 빽빽함 */
  early0710: { stats: { rows: 227, spanSeconds: 227.2 }, duration: 604.8 },
  /** 2026-07-10 subject_2 — 온전함 */
  full0710: { stats: { rows: 600, spanSeconds: 598.8 }, duration: 604.8 },
  /** 2026-07-31 subject_1 — 전달 지연 누적, 내부 공백 0개 */
  stalled0731: { stats: { rows: 282, spanSeconds: 280.9 }, duration: 368 },
  /** 2026-07-31 subject_2 — 온전함 */
  full0731: { stats: { rows: 365, spanSeconds: 363.9 }, duration: 368 },
};

describe('computeDensity: 기록 구간 내 수집 밀도', () => {
  it('2026-07-10 subject_1은 조기 종료했으나 기록 구간은 빽빽함', () => {
    expect(computeDensity(227, 227.2)).toBeCloseTo(1, 2);
  });

  it('2026-07-31 subject_1도 마찬가지로 빽빽함', () => {
    expect(computeDensity(282, 280.9)).toBeCloseTo(1, 2);
  });

  it('기록 구간에 구멍이 나면 밀도가 떨어짐', () => {
    // 600초 동안 기록했는데 300행뿐이면 절반이 결측임
    expect(computeDensity(300, 600)).toBeCloseTo(0.5, 3);
  });

  it('span이 없거나 0이면 0 반환', () => {
    expect(computeDensity(100, 0)).toBe(0);
    expect(computeDensity(100, -1)).toBe(0);
  });

  it('수집이 초과해도 1을 넘지 않음', () => {
    expect(computeDensity(700, 600)).toBe(1);
  });
});

describe('computeCompletionRatio: 예정 구간 대비 완주율 (게이트 아님)', () => {
  it('2026-07-10 subject_1은 완주율이 낮음', () => {
    expect(computeCompletionRatio(227.2, 604.8)).toBeCloseTo(0.376, 3);
  });

  it('2026-07-31 subject_1도 낮음', () => {
    expect(computeCompletionRatio(280.9, 368)).toBeCloseTo(0.763, 3);
  });

  it('온전한 측정은 1에 가까움', () => {
    expect(computeCompletionRatio(363.9, 368)).toBeGreaterThan(0.98);
  });

  it('측정 시간이 없거나 0이면 0 반환', () => {
    expect(computeCompletionRatio(100, null)).toBe(0);
    expect(computeCompletionRatio(100, 0)).toBe(0);
  });
});

describe('evaluateSubjectCoverage: 분석 게이트', () => {
  it('2026-07-31 subject_1을 통과시킴 (구 로직은 76.6%로 탈락시켰음)', () => {
    const v = evaluateSubjectCoverage(
      CASE.stalled0731.stats,
      CASE.stalled0731.duration,
      MIN_ANALYSIS_SECONDS
    );
    expect(v.valid).toBe(true);
    expect(v.density).toBeCloseTo(1, 2);
    // 완주율은 낮지만 탈락 사유가 아님. 경고 지표로만 남음
    expect(v.completionRatio).toBeLessThan(MIN_COVERAGE_RATIO);
    // 옛 판정식 값도 함께 보존해 회차 간 비교가 끊기지 않음
    expect(v.legacyCoverage).toBeCloseTo(0.766, 3);
  });

  it('2026-07-10 subject_1도 통과시킴 (진단 정정 — 빈 데이터가 아니었음)', () => {
    const v = evaluateSubjectCoverage(
      CASE.early0710.stats,
      CASE.early0710.duration,
      MIN_ANALYSIS_SECONDS
    );
    expect(v.valid).toBe(true);
    expect(v.legacyCoverage).toBeCloseTo(0.375, 3);
  });

  it('두 회차의 온전한 subject_2는 그대로 통과함', () => {
    for (const c of [CASE.full0710, CASE.full0731]) {
      const v = evaluateSubjectCoverage(
        c.stats,
        c.duration,
        MIN_ANALYSIS_SECONDS
      );
      expect(v.valid).toBe(true);
    }
  });

  it('기록 구간에 구멍이 나면 거부함 (밀도 게이트가 지키는 진짜 결측)', () => {
    const v = evaluateSubjectCoverage(
      { rows: 300, spanSeconds: 600 },
      605,
      MIN_ANALYSIS_SECONDS
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toContain('수집 밀도 미달');
  });

  it('측정 시간이 최소치 미만이면 거부함', () => {
    const v = evaluateSubjectCoverage(
      { rows: 170, spanSeconds: 169 },
      170,
      MIN_ANALYSIS_SECONDS
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toContain('측정 시간 부족');
  });

  it('시간은 충분하나 샘플이 최소치 미만이면 거부함', () => {
    const v = evaluateSubjectCoverage(
      { rows: 150, spanSeconds: 150 },
      200,
      MIN_ANALYSIS_SECONDS
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toContain('수집 샘플 부족');
  });

  it('측정 시간 미기록이면 거부함', () => {
    const v = evaluateSubjectCoverage(
      { rows: 200, spanSeconds: 200 },
      null,
      MIN_ANALYSIS_SECONDS
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toContain('측정 시간 미기록');
  });

  it('CSV가 없으면 거부함', () => {
    const v = evaluateSubjectCoverage(
      { rows: 0, spanSeconds: 0 },
      300,
      MIN_ANALYSIS_SECONDS
    );
    expect(v.valid).toBe(false);
  });

  it('밀도 임계 경계에서 통과와 거부가 갈림', () => {
    const span = 300;
    const atThreshold = Math.ceil(span * MIN_COVERAGE_RATIO);
    expect(
      evaluateSubjectCoverage(
        { rows: atThreshold, spanSeconds: span },
        span,
        MIN_ANALYSIS_SECONDS
      ).valid
    ).toBe(true);
    expect(
      evaluateSubjectCoverage(
        { rows: atThreshold - 2, spanSeconds: span },
        span,
        MIN_ANALYSIS_SECONDS
      ).valid
    ).toBe(false);
  });
});
