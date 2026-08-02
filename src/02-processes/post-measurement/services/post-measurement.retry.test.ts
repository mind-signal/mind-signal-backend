/**
 * post-measurement.service.ts — 엔진 실패 후 재시도 경로 회귀 검증
 *
 * 회귀 배경(2026-07-31):
 *   엔진 실패 시 파이프라인이 예외를 삼키고 return해 프론트가 무한 폴링 후
 *   "응답 시간 초과"만 표시했고 DB에 흔적이 없었음. 예외를 다시 던지도록
 *   고치면서 멱등성 가드를 COMPLETED 한정으로 완화했는데, groupId에 unique
 *   인덱스가 걸려 있어 재시도의 마지막 쓰기가 중복키로 죽는 문제가 생김.
 *   그러면 분석이 실제로 성공했는데도 사용자에게 "분석 실패"로 보고됨.
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

const GROUP_ID = 'grp_retry_test';

/** subjectIndex 1과 2의 COMPLETED 세션 2건 반환함 */
const mockSessions = () => {
  const make = (idx: number) => ({
    _id: `session_${idx}`,
    subjectIndex: idx,
    userId: { _id: `user_${idx}` },
    experimentMode: 'DUAL_2PC',
  });
  (Session.find as jest.Mock).mockReturnValue({
    populate: jest.fn().mockResolvedValue([make(1), make(2)]),
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSessions();
  (Consent.findOne as jest.Mock).mockResolvedValue(null);
  (EegRecord.findOneAndUpdate as jest.Mock).mockImplementation((filter) =>
    Promise.resolve({ _id: `record_${filter.sessionId}` })
  );
  (EegRecord.findByIdAndUpdate as jest.Mock).mockResolvedValue({});
  (AnalysisResult.findOneAndUpdate as jest.Mock).mockResolvedValue({
    _id: 'analysis_1',
  });
  (MatchingPool.findOneAndUpdate as jest.Mock).mockResolvedValue({});
});

describe('runPostMeasurementPipeline: 멱등성 가드', () => {
  it('COMPLETED 문서가 있으면 스킵함', async () => {
    (MatchingPool.findOne as jest.Mock).mockResolvedValue({
      status: 'COMPLETED',
    });

    await runPostMeasurementPipeline(GROUP_ID);

    expect(Session.find).not.toHaveBeenCalled();
  });

  it('PENDING만 남은 그룹은 스킵하지 않고 재시도함 (2026-07-31 회귀)', async () => {
    // 가드가 status 무관하게 조회하면 PENDING이 재시도를 영구히 막음
    (MatchingPool.findOne as jest.Mock).mockResolvedValue(null);
    (engineProxyService.analyzePipeline as jest.Mock).mockResolvedValue({
      synchronyScore: 0.5,
      markdown: '# ok',
    });

    await runPostMeasurementPipeline(GROUP_ID);

    expect(MatchingPool.findOne).toHaveBeenCalledWith({
      groupId: GROUP_ID,
      status: 'COMPLETED',
    });
    expect(engineProxyService.analyzePipeline).toHaveBeenCalled();
  });
});

describe('runPostMeasurementPipeline: 재시도 시 중복키 회피', () => {
  beforeEach(() => {
    (MatchingPool.findOne as jest.Mock).mockResolvedValue(null);
  });

  it('성공 경로가 create가 아니라 groupId upsert를 씀', async () => {
    (engineProxyService.analyzePipeline as jest.Mock).mockResolvedValue({
      synchronyScore: 0.42,
      markdown: '# ok',
    });

    await runPostMeasurementPipeline(GROUP_ID);

    // create를 쓰면 PENDING이 남은 재시도에서 unique 인덱스에 걸림
    expect(AnalysisResult.create).not.toHaveBeenCalled();
    expect(MatchingPool.create).not.toHaveBeenCalled();
    expect(AnalysisResult.findOneAndUpdate).toHaveBeenCalledWith(
      { groupId: GROUP_ID },
      expect.anything(),
      expect.objectContaining({ upsert: true })
    );
    expect(MatchingPool.findOneAndUpdate).toHaveBeenCalledWith(
      { groupId: GROUP_ID },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'COMPLETED' }),
      }),
      expect.objectContaining({ upsert: true })
    );
  });

  it('EegRecord도 sessionId upsert라 재시도에서 중복 누적되지 않음', async () => {
    (engineProxyService.analyzePipeline as jest.Mock).mockResolvedValue({
      synchronyScore: 0.1,
      markdown: '',
    });

    await runPostMeasurementPipeline(GROUP_ID);

    expect(EegRecord.create).not.toHaveBeenCalled();
    expect(EegRecord.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(EegRecord.findOneAndUpdate).toHaveBeenCalledWith(
      { sessionId: 'session_1' },
      expect.anything(),
      expect.objectContaining({ upsert: true })
    );
  });
});

describe('runPostMeasurementPipeline: 엔진 실패 처리', () => {
  beforeEach(() => {
    (MatchingPool.findOne as jest.Mock).mockResolvedValue(null);
    (engineProxyService.analyzePipeline as jest.Mock).mockRejectedValue(
      new Error('engine down')
    );
  });

  it('실패를 삼키지 않고 다시 던짐 (호출부가 소켓으로 알리도록)', async () => {
    await expect(runPostMeasurementPipeline(GROUP_ID)).rejects.toThrow(
      'engine down'
    );
  });

  it('실패 시 PENDING을 upsert로 남겨 두 번째 실패도 엔진 사유를 보고함', async () => {
    await expect(runPostMeasurementPipeline(GROUP_ID)).rejects.toThrow();

    expect(MatchingPool.create).not.toHaveBeenCalled();
    expect(MatchingPool.findOneAndUpdate).toHaveBeenCalledWith(
      { groupId: GROUP_ID },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'PENDING' }),
      }),
      expect.objectContaining({ upsert: true })
    );
  });

  it('실패 시 AnalysisResult를 만들지 않아 재시도가 가능함', async () => {
    await expect(runPostMeasurementPipeline(GROUP_ID)).rejects.toThrow();

    expect(AnalysisResult.findOneAndUpdate).not.toHaveBeenCalled();
    expect(AnalysisResult.create).not.toHaveBeenCalled();
  });
});
