import fs from 'fs';
import path from 'path';
import { resolveCsvDir } from './csv-upload.service';

/**
 * 실제 수집된 샘플이 기대치 대비 이 비율 미만이면 유효 측정으로 인정하지 않음.
 * 2026-07-10 라이브: subject_1이 프로세스는 604.8초 생존했으나 CSV는 227행뿐이라
 * coverage 약 0.375였음. 그럼에도 measuredDurationSeconds만 보고 VALID로 분류돼
 * 절반이 빈 데이터로 분석이 실행됨.
 */
export const MIN_COVERAGE_RATIO = 0.8;

/** CSV 1행이 1초를 뜻함 (streamer가 초당 1행 기록함) */
const SECONDS_PER_ROW = 1;

/**
 * 특정 그룹·피실험자의 최신 CSV 데이터 행 수 반환함 (헤더 제외).
 *
 * @param groupId - 측정 그룹 식별자임
 * @param subjectIndex - 피실험자 순번(1 또는 2)임
 * @returns 데이터 행 수 반환. CSV 미발견 시 0 반환
 */
export function countCsvRows(groupId: string, subjectIndex: number): number {
  const dir = resolveCsvDir();
  if (!fs.existsSync(dir)) return 0;

  const prefix = `subject_${subjectIndex}_${groupId}_`;
  const matches = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.csv'))
    .map((f) => {
      const full = path.join(dir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (matches.length === 0) return 0;

  const lines = fs.readFileSync(matches[0].full, 'utf-8').split('\n');
  // 헤더 1행과 말미 빈 줄 제외함
  return lines.filter((l, i) => i > 0 && l.trim() !== '').length;
}

/**
 * 프로세스 생존 시간 대비 실제 수집량 비율 계산함.
 *
 * @param rows - 실제 CSV 데이터 행 수임
 * @param measuredDurationSeconds - 측정 프로세스가 살아 있던 wall-clock 초임
 * @returns 0 이상 1 이하 coverage 반환. 측정 시간이 0 이하면 0 반환
 */
export function computeCoverage(
  rows: number,
  measuredDurationSeconds: number | null
): number {
  if (!measuredDurationSeconds || measuredDurationSeconds <= 0) return 0;
  const expected = measuredDurationSeconds / SECONDS_PER_ROW;
  return Math.min(1, rows / expected);
}

/**
 * 한 피실험자의 측정이 분석에 쓸 만한지 판정함.
 *
 * 프로세스 생존 시간만 보면 스트림이 중간에 죽어도 통과하므로
 * 실제 수집 행 수와 coverage를 함께 확인함.
 *
 * @param rows - 실제 CSV 데이터 행 수임
 * @param measuredDurationSeconds - 프로세스 wall-clock 생존 초임
 * @param minAnalysisSeconds - 최소 분석 가능 시간(초)임
 * @returns 유효 여부와 판단 근거 반환
 */
export function evaluateSubjectCoverage(
  rows: number,
  measuredDurationSeconds: number | null,
  minAnalysisSeconds: number
): { valid: boolean; coverage: number; reason: string } {
  const coverage = computeCoverage(rows, measuredDurationSeconds);

  if (measuredDurationSeconds === null) {
    return { valid: false, coverage, reason: '측정 시간 미기록' };
  }
  if (measuredDurationSeconds < minAnalysisSeconds) {
    return {
      valid: false,
      coverage,
      reason: `측정 시간 부족 (${measuredDurationSeconds}초 < ${minAnalysisSeconds}초)`,
    };
  }
  if (rows < minAnalysisSeconds) {
    return {
      valid: false,
      coverage,
      reason: `수집 샘플 부족 (${rows}행 < ${minAnalysisSeconds}행)`,
    };
  }
  if (coverage < MIN_COVERAGE_RATIO) {
    return {
      valid: false,
      coverage,
      reason: `수집률 미달 (${(coverage * 100).toFixed(1)}% < ${MIN_COVERAGE_RATIO * 100}%) — 측정 중 스트림 단절 의심`,
    };
  }
  return { valid: true, coverage, reason: '유효' };
}
