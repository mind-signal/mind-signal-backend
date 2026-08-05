/**
 * AUTH-W002 회귀 방어 — engine 라우트의 groupId 소유권 검증.
 *
 * 이 라우트들은 `authenticate` 만 통과시킨 뒤 body 의 groupId 를 그대로 서비스로
 * 넘겼음. 즉 계정만 있으면 남의 그룹 측정을 시작하거나 중단하거나(stop-all 은 한
 * 호출로 그룹 전체) 분석 결과를 `includeMarkdown` 으로 받아낼 수 있었음.
 *
 * 소유권 판정 자체는 group-ownership.service.test.ts 가 검증함. 여기서는
 * 라우트가 그 판정을 실제로 거치는지, 그리고 거부가 부수효과보다 먼저인지 봄.
 */

import express from 'express';
import request from 'supertest';

const VALID_GROUP_ID = '65c9f0b2a1b2c3d4e5f67890';

// 소유권 검증 mock — 기본은 통과, 개별 테스트에서 거부로 바꿈
jest.mock('@05-features/sessions', () => ({
  assertGroupOwnership: jest.fn().mockResolvedValue(undefined),
}));

// 외부 인프라(파이썬 엔진, Redis, MongoDB) 의존 제거
jest.mock('../services/engine-proxy.service', () => ({
  engineProxyService: {
    analyzePipeline: jest.fn().mockResolvedValue({ ok: true }),
    streamStart: jest.fn().mockResolvedValue({ ok: true }),
    streamStop: jest.fn().mockResolvedValue({ ok: true }),
  },
}));

jest.mock('@02-processes/measurements/services/measurement.service', () => ({
  stopMeasurementService: jest.fn().mockResolvedValue({ allCompleted: false }),
}));

// stopAll 은 MEASURING 세션을 직접 조회하므로 모델도 mock 함
jest.mock('@06-entities/sessions', () => ({
  Session: {
    find: jest
      .fn()
      .mockResolvedValue([{ subjectIndex: 1, status: 'MEASURING' }]),
  },
}));

jest.mock('@07-shared/middlewares/authenticate.middleware', () => ({
  authenticate: (
    req: import('@07-shared/types').AuthedRequest,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    req.user = { id: 'requester-1' };
    next();
  },
}));

import { assertGroupOwnership } from '@05-features/sessions';
import { engineProxyService } from '../services/engine-proxy.service';
import { stopMeasurementService } from '@02-processes/measurements/services/measurement.service';
import { AppError } from '@07-shared/errors';
import engineRouter from './engine.routes';

const app = express();
app.use(express.json());
app.use('/api/engine', engineRouter);
app.use(
  (
    err: Error & { statusCode?: number },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    res
      .status(err.statusCode ?? 500)
      .json({ status: 'fail', message: err.message });
  }
);

/** 소유권 검증이 거부하도록 만듦 */
function denyOwnership() {
  jest
    .mocked(assertGroupOwnership)
    .mockRejectedValueOnce(
      new AppError('해당 그룹에 대한 접근 권한이 없습니다.', 403)
    );
}

describe('engine 라우트 groupId 소유권 검증 (AUTH-W002)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(assertGroupOwnership).mockResolvedValue(undefined);
  });

  it('stream/stop — 무관한 사용자는 403이고 엔진을 부르지 않음', () => {
    denyOwnership();

    return request(app)
      .post('/api/engine/stream/stop')
      .send({ groupId: VALID_GROUP_ID, subjectIndex: 1 })
      .expect(403)
      .then(() => {
        expect(engineProxyService.streamStop).not.toHaveBeenCalled();
        expect(stopMeasurementService).not.toHaveBeenCalled();
      });
  });

  it('stream/stop — 소유권이 통과하면 엔진 종료와 세션 전이가 일어남', () => {
    return request(app)
      .post('/api/engine/stream/stop')
      .send({ groupId: VALID_GROUP_ID, subjectIndex: 1 })
      .expect(200)
      .then(() => {
        expect(assertGroupOwnership).toHaveBeenCalledWith(
          VALID_GROUP_ID,
          'requester-1'
        );
        expect(engineProxyService.streamStop).toHaveBeenCalledWith(
          VALID_GROUP_ID,
          1
        );
        expect(stopMeasurementService).toHaveBeenCalled();
      });
  });

  it('stream/stop-all — 무관한 사용자는 403이고 종료가 일어나지 않음 (한 호출로 그룹 전체를 끝내는 경로)', () => {
    denyOwnership();

    return request(app)
      .post('/api/engine/stream/stop-all')
      .send({ groupId: VALID_GROUP_ID })
      .expect(403)
      .then(() => {
        expect(engineProxyService.streamStop).not.toHaveBeenCalled();
        expect(stopMeasurementService).not.toHaveBeenCalled();
      });
  });

  it('stream/stop-all — 소유권이 통과하면 200을 반환함', () => {
    return request(app)
      .post('/api/engine/stream/stop-all')
      .send({ groupId: VALID_GROUP_ID })
      .expect(200)
      .then(() => {
        expect(assertGroupOwnership).toHaveBeenCalledWith(
          VALID_GROUP_ID,
          'requester-1'
        );
      });
  });

  it('stream/start — 무관한 사용자는 403이고 엔진을 부르지 않음', () => {
    denyOwnership();

    return request(app)
      .post('/api/engine/stream/start')
      .send({ groupId: VALID_GROUP_ID, subjectIndex: 1 })
      .expect(403)
      .then(() => {
        expect(engineProxyService.streamStart).not.toHaveBeenCalled();
      });
  });

  it('stream/start — 소유권이 통과하면 엔진에 그대로 전달함', () => {
    return request(app)
      .post('/api/engine/stream/start')
      .send({ groupId: VALID_GROUP_ID, subjectIndex: 2 })
      .expect(200)
      .then(() => {
        expect(engineProxyService.streamStart).toHaveBeenCalledWith(
          VALID_GROUP_ID,
          2
        );
      });
  });

  it('analyze/pipeline — 무관한 사용자는 403이고 분석 결과가 나가지 않음', () => {
    denyOwnership();

    return request(app)
      .post('/api/engine/analyze/pipeline')
      .send({
        groupId: VALID_GROUP_ID,
        subjectIndices: [1, 2],
        includeMarkdown: true,
      })
      .expect(403)
      .then(() => {
        expect(engineProxyService.analyzePipeline).not.toHaveBeenCalled();
      });
  });

  it('analyze/pipeline — 소유권이 통과하면 인자를 그대로 넘김', () => {
    return request(app)
      .post('/api/engine/analyze/pipeline')
      .send({
        groupId: VALID_GROUP_ID,
        subjectIndices: [1, 2],
        includeMarkdown: true,
      })
      .expect(200)
      .then(() => {
        expect(engineProxyService.analyzePipeline).toHaveBeenCalledWith(
          VALID_GROUP_ID,
          [1, 2],
          undefined,
          undefined,
          true
        );
      });
  });
});
