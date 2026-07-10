/**
 * post-measurement.service.ts — 매칭 점수 변환 회귀 검증
 *
 * 회귀 배경(2026-07-10 라이브 2-PC 측정):
 *   동조율 -0.12738이 matchingScore -13으로 변환되어 AnalysisResult 스키마의
 *   min:0 검증에 걸림. ValidationError가 엔진 try/catch 바깥에서 발생해
 *   결과가 저장되지 않았고 FE는 120초 폴링 후 "결과를 가져올 수 없습니다"를 표시함.
 */

import { toMatchingScore } from './post-measurement.service';

describe('toMatchingScore: 동조율을 0..100 매칭 점수로 변환함', () => {
  it('음수 동조율을 0으로 클램프함 (2026-07-10 회귀)', () => {
    expect(toMatchingScore(-0.12738473800151376)).toBe(0);
  });

  it('완전 역상관 -1도 0으로 클램프함', () => {
    expect(toMatchingScore(-1)).toBe(0);
  });

  it('양수 동조율은 백분율로 반올림함', () => {
    expect(toMatchingScore(0.5)).toBe(50);
    expect(toMatchingScore(0.126)).toBe(13);
  });

  it('완전 동조 1은 상한 100 반환', () => {
    expect(toMatchingScore(1)).toBe(100);
  });

  it('미측정(null)은 0 반환', () => {
    expect(toMatchingScore(null)).toBe(0);
  });

  it('스키마 제약 0..100 범위를 항상 만족함', () => {
    const samples = [-1, -0.5, -0.001, 0, 0.001, 0.5, 1];
    for (const s of samples) {
      const score = toMatchingScore(s);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});
