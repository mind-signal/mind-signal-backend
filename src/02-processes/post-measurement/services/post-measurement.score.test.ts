/**
 * post-measurement.service.ts — 정본 수식 점수 저장 경로 검증 (ANALYSIS-W004)
 *
 * 엔진이 friendshipScore를 주면 그 값을 저장하고, 필드가 아예 없는 구 엔진에는
 * 기존 동조율 변환으로 폴백함. undefined를 값으로 다루면 Math.round(undefined)가
 * NaN이 되어 스키마 min/max 검증에서 결과가 통째로 유실되므로 그 회귀를 고정함.
 */

import { runPostMeasurementPipeline } from './post-measurement.service';
import { Session } from '@06-entities/sessions';
import { AnalysisResult } from '@06-entities/analysis-results';
import { MatchingPool } from '@06-entities/matching-pools';
import { EegRecord } from '@06-entities/eeg-records';
import { Consent } from '@06-entities/consents';
import { engineProxyService } from '@02-processes/engine/services/engine-proxy.service';

jest.mock('@06-entities/sessions', () => ({ Session: { find: jest.fn() } }));
jest.mock('@06-entities/analysis-results', () => ({
  AnalysisResult: { findOneAndUpdate: jest.fn(), create: jest.fn() },
}));
jest.mock('@06-entities/matching-pools', () => ({
  MatchingPool: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    create: jest.fn(),
  },
}));
jest.mock('@06-entities/eeg-records', () => ({
  EegRecord: {
    findOneAndUpdate: jest.fn(),
    create: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  },
}));
jest.mock('@06-entities/consents', () => ({ Consent: { findOne: jest.fn() } }));
jest.mock('@02-processes/engine/services/engine-proxy.service', () => ({
  engineProxyService: { analyzePipeline: jest.fn() },
}));

const GROUP_ID = 'grp_score_test';

/** AnalysisResult에 저장된 matchingScore 추출함 */
const savedMatchingScore = (): unknown =>
  (AnalysisResult.findOneAndUpdate as jest.Mock).mock.calls[0][1].$set
    .matchingScore;

beforeEach(() => {
  jest.clearAllMocks();
  const make = (idx: number) => ({
    _id: `session_${idx}`,
    subjectIndex: idx,
    userId: { _id: `user_${idx}` },
    experimentMode: 'DUAL_2PC',
  });
  (Session.find as jest.Mock).mockReturnValue({
    populate: jest.fn().mockResolvedValue([make(1), make(2)]),
  });
  (Consent.findOne as jest.Mock).mockResolvedValue(null);
  (MatchingPool.findOne as jest.Mock).mockResolvedValue(null);
  (EegRecord.findOneAndUpdate as jest.Mock).mockImplementation((filter) =>
    Promise.resolve({ _id: `record_${filter.sessionId}` })
  );
  (EegRecord.findByIdAndUpdate as jest.Mock).mockResolvedValue({});
  (AnalysisResult.findOneAndUpdate as jest.Mock).mockResolvedValue({
    _id: 'analysis_1',
  });
  (MatchingPool.findOneAndUpdate as jest.Mock).mockResolvedValue({});
});

describe('runPostMeasurementPipeline: matchingScore 산출 경로', () => {
  it('엔진이 friendshipScore를 주면 그 값을 저장함', async () => {
    // 상관 0의 정본 점수는 50임. 구 변환이었다면 0이 저장됨
    (engineProxyService.analyzePipeline as jest.Mock).mockResolvedValue({
      synchronyScore: 0,
      friendshipScore: 50,
      markdown: '# ok',
    });

    await runPostMeasurementPipeline(GROUP_ID);

    expect(savedMatchingScore()).toBe(50);
  });

  it('소수 점수를 반올림함', async () => {
    (engineProxyService.analyzePipeline as jest.Mock).mockResolvedValue({
      synchronyScore: 0.31,
      friendshipScore: 65.6,
      markdown: '# ok',
    });

    await runPostMeasurementPipeline(GROUP_ID);

    expect(savedMatchingScore()).toBe(66);
  });

  it.each([
    [-1, 0],
    [101, 100],
  ])('범위를 벗어난 %p을 %p으로 클램프함', async (given, expected) => {
    (engineProxyService.analyzePipeline as jest.Mock).mockResolvedValue({
      synchronyScore: 0.5,
      friendshipScore: given,
      markdown: '# ok',
    });

    await runPostMeasurementPipeline(GROUP_ID);

    expect(savedMatchingScore()).toBe(expected);
  });

  it('유한 수치가 아닌 점수는 저장하지 않고 실패로 보고함', async () => {
    // 엔진 응답은 Record<string, unknown>이라 타입이 보장되지 않음.
    // 문자열이 그대로 흘러가면 스키마 검증에서 결과가 통째로 유실됨
    (engineProxyService.analyzePipeline as jest.Mock).mockResolvedValue({
      synchronyScore: 0.5,
      friendshipScore: 'not-a-number',
      markdown: '# ok',
    });

    await expect(runPostMeasurementPipeline(GROUP_ID)).rejects.toThrow(
      /friendshipScore/
    );
    expect(AnalysisResult.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('필드가 없는 구 엔진에는 동조율 변환으로 폴백함 (NaN 회귀 가드)', async () => {
    (engineProxyService.analyzePipeline as jest.Mock).mockResolvedValue({
      synchronyScore: 0.42,
      markdown: '# ok',
    });

    await runPostMeasurementPipeline(GROUP_ID);

    const score = savedMatchingScore();
    expect(Number.isNaN(score as number)).toBe(false);
    expect(score).toBe(42);
  });

  it('신 엔진이 null(미측정)을 주면 0으로 저장함', async () => {
    (engineProxyService.analyzePipeline as jest.Mock).mockResolvedValue({
      synchronyScore: null,
      friendshipScore: null,
      markdown: '',
    });

    await runPostMeasurementPipeline(GROUP_ID);

    expect(savedMatchingScore()).toBe(0);
  });
});
