import fs from 'fs';
import path from 'path';
import { resolveCsvDir } from './csv-upload.service';

/**
 * 실제 수집된 샘플이 기대치 대비 이 비율 미만이면 유효 측정으로 인정하지 않음.
 *
 * 분모 정정(2026-07-31): 이전에는 `measuredDurationSeconds`를 분모로 썼으나
 * 그 값은 BE가 정지 시점에 `Date.now() - measuredAt`으로 계산하는 그룹 공용
 * wall-clock이고(measurement.service.ts), 분자인 행 수는 Cortex 취득 시각
 * 기준이다. 서로 다른 시계를 나누고 있었다. 그 결과 내부 공백이 0인 온전한
 * 데이터가 "수집률 미달"로 탈락했다(2026-07-31 subject_1: 282행, 내부 공백
 * 0개, 간격 중앙값 1.000초인데 282/368 = 76.6%로 거부됨).
 *
 * 지금 분모는 그 CSV 자신의 시간 span이다. 이 비율은 "기록된 구간 안에
 * 구멍이 있는가"를 판정함.
 */
export const MIN_COVERAGE_RATIO = 0.8;

/** CSV 1행이 1초를 뜻함 (streamer가 초당 1행 기록함) */
const SECONDS_PER_ROW = 1;

/** CSV 1개에서 읽어낸 수집 통계임 */
export interface CsvStats {
  /** 헤더를 제외한 데이터 행 수임 */
  rows: number;
  /** 첫 행부터 마지막 행까지의 초임. 행이 2개 미만이면 0임 */
  spanSeconds: number;
}

/**
 * 특정 그룹·피실험자의 최신 CSV 수집 통계 반환함 (헤더 제외).
 *
 * @param groupId - 측정 그룹 식별자임
 * @param subjectIndex - 피실험자 순번(1 또는 2)임
 * @returns 행 수와 시간 span 반환. CSV 미발견 시 둘 다 0임
 */
export function readCsvStats(groupId: string, subjectIndex: number): CsvStats {
  const dir = resolveCsvDir();
  if (!fs.existsSync(dir)) return { rows: 0, spanSeconds: 0 };

  const prefix = `subject_${subjectIndex}_${groupId}_`;
  const matches = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.csv'))
    .map((f) => {
      const full = path.join(dir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (matches.length === 0) return { rows: 0, spanSeconds: 0 };

  const lines = fs.readFileSync(matches[0].full, 'utf-8').split('\n');
  // 헤더 1행과 말미 빈 줄 제외함
  const dataLines = lines.filter((l, i) => i > 0 && l.trim() !== '');
  if (dataLines.length === 0) return { rows: 0, spanSeconds: 0 };

  return {
    rows: dataLines.length,
    spanSeconds: computeSpanSeconds(dataLines),
  };
}

/**
 * 데이터 행들의 첫 시각과 마지막 시각 차이 계산함.
 *
 * timestamp는 항상 첫 컬럼이며 Cortex 취득 시각임(streamer가 기록).
 *
 * @param dataLines - 헤더를 제외한 CSV 데이터 행들임
 * @returns 초 단위 span 반환. 파싱 불가하거나 행이 2개 미만이면 0임
 */
function computeSpanSeconds(dataLines: string[]): number {
  if (dataLines.length < 2) return 0;
  const first = Date.parse(dataLines[0].split(',')[0]);
  const last = Date.parse(dataLines[dataLines.length - 1].split(',')[0]);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0;
  const span = (last - first) / 1000;
  return span > 0 ? span : 0;
}

/**
 * 기록된 구간 안의 수집 밀도 계산함.
 *
 * 분모가 CSV 자신의 span이므로 "이 사람이 기록한 시간 동안 초당 1행이
 * 제대로 쌓였는가"를 봄. 중간에 스트림이 끊겨 구멍이 나면 span은 그대로인데
 * 행 수만 줄어 비율이 떨어짐.
 *
 * @param rows - 실제 CSV 데이터 행 수임
 * @param spanSeconds - 첫 행부터 마지막 행까지의 초임
 * @returns 0 이상 1 이하 밀도 반환. span이 0 이하면 0 반환
 */
export function computeDensity(rows: number, spanSeconds: number): number {
  if (!spanSeconds || spanSeconds <= 0) return 0;
  const expected = spanSeconds / SECONDS_PER_ROW;
  return Math.min(1, rows / expected);
}

/**
 * 예정 측정 구간 대비 실제로 끝까지 기록된 비율 계산함.
 *
 * 게이트가 아니라 관측 지표임. 낮으면 그 피실험자의 스트림이 일찍 멎었거나
 * 전달이 실시간보다 느렸다는 뜻이고, 데이터 자체의 품질과는 무관함.
 *
 * @param spanSeconds - CSV 첫 행부터 마지막 행까지의 초임
 * @param measuredDurationSeconds - 그룹 측정 wall-clock 초임
 * @returns 0 이상 1 이하 완주율 반환. 측정 시간이 0 이하면 0 반환
 */
export function computeCompletionRatio(
  spanSeconds: number,
  measuredDurationSeconds: number | null
): number {
  if (!measuredDurationSeconds || measuredDurationSeconds <= 0) return 0;
  return Math.min(1, spanSeconds / measuredDurationSeconds);
}

/** 한 피실험자의 수집 판정 결과임 */
export interface CoverageVerdict {
  valid: boolean;
  /** 기록 구간 내 수집 밀도임. 게이트 대상 */
  density: number;
  /** 예정 구간 대비 완주율임. 기록만 하고 게이트로 쓰지 않음 */
  completionRatio: number;
  /** 옛 판정식(행 수 나누기 wall-clock) 값임. 회차 간 비교 연속성 유지용 */
  legacyCoverage: number;
  reason: string;
}

/**
 * 한 피실험자의 측정이 분석에 쓸 만한지 판정함.
 *
 * 게이트는 셋이다. 최소 측정 시간, 최소 수집 행 수, 그리고 기록 구간 내
 * 수집 밀도임. 완주율은 계산해서 남기기만 하고 탈락 사유로 쓰지 않음.
 * 늦게 전달됐거나 일찍 끝났다는 사실이 이미 기록된 데이터의 품질을 떨어뜨리지
 * 않기 때문이다. 동조율은 두 CSV의 절대시각 교집합으로 계산되므로(analysis.py
 * align_on_second) 짧은 쪽이 겹침을 줄일 뿐 값을 오염시키지 않음.
 *
 * @param stats - CSV 행 수와 시간 span임
 * @param measuredDurationSeconds - 그룹 측정 wall-clock 초임
 * @param minAnalysisSeconds - 최소 분석 가능 시간(초)임
 * @returns 유효 여부와 세 지표와 판단 근거 반환
 */
export function evaluateSubjectCoverage(
  stats: CsvStats,
  measuredDurationSeconds: number | null,
  minAnalysisSeconds: number
): CoverageVerdict {
  const { rows, spanSeconds } = stats;
  const density = computeDensity(rows, spanSeconds);
  const completionRatio = computeCompletionRatio(
    spanSeconds,
    measuredDurationSeconds
  );
  const legacyCoverage =
    measuredDurationSeconds && measuredDurationSeconds > 0
      ? Math.min(1, rows / measuredDurationSeconds)
      : 0;
  const base = { density, completionRatio, legacyCoverage };

  if (measuredDurationSeconds === null) {
    return { valid: false, ...base, reason: '측정 시간 미기록' };
  }
  if (measuredDurationSeconds < minAnalysisSeconds) {
    return {
      valid: false,
      ...base,
      reason: `측정 시간 부족 (${measuredDurationSeconds}초 < ${minAnalysisSeconds}초)`,
    };
  }
  if (rows < minAnalysisSeconds) {
    return {
      valid: false,
      ...base,
      reason: `수집 샘플 부족 (${rows}행 < ${minAnalysisSeconds}행)`,
    };
  }
  // 행 수는 "1행 1초" 가정 위에서만 시간의 대리 지표임. streamer 오동작이나
  // 중복 기록으로 행이 초당 1개보다 빨리 쌓이면 span이 수십 초뿐인 CSV도
  // 행 수 게이트를 통과함. 이 게이트의 존재 이유가 streamer 오동작 방어인데
  // 자기 가정에 기대면 안 되므로 실제 시간 범위를 직접 검사함
  if (stats.spanSeconds < minAnalysisSeconds) {
    return {
      valid: false,
      ...base,
      reason: `기록 구간 부족 (${stats.spanSeconds.toFixed(1)}초 < ${minAnalysisSeconds}초)`,
    };
  }
  if (density < MIN_COVERAGE_RATIO) {
    return {
      valid: false,
      ...base,
      reason: `수집 밀도 미달 (${(density * 100).toFixed(1)}% < ${MIN_COVERAGE_RATIO * 100}%) — 기록 구간 내 결측 의심`,
    };
  }
  return { valid: true, ...base, reason: '유효' };
}
