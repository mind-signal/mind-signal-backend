/**
 * AUTH-W003 회귀 방어 — registry-status 와 dual-trigger 의 인증과 소유권 검증.
 *
 * 두 라우트에는 authenticate 가 없었음. 토큰 없이도 남의 groupId 로 등록 현황을
 * 조회하거나 양쪽 엔진에 assign-group 을 발화할 수 있었음.
 *
 * authenticate 교체본은 헤더 유무만 구분함. 라우트에 미들웨어가 연결됐는지를
 * 보는 것이고, 토큰 검증 자체는 authenticate 의 몫임.
 */

import express from 'express';
import request from 'supertest';

const GROUP_ID = '65c9f0b2a1b2c3d4e5f67890';
const AUTH = { Authorization: 'Bearer test-token' };
const SUBJECTS: { groupId: string; url: string; subjectIndex: 1 | 2 }[] = [
  { groupId: GROUP_ID, url: 'http://pc-a:5002', subjectIndex: 1 },
  { groupId: GROUP_ID, url: 'http://pc-b:5002', subjectIndex: 2 },
];

jest.mock('@05-features/sessions', () => ({
  assertGroupOwnership: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/engine-proxy.service', () => ({
  engineProxyService: {},
}));

jest.mock('../services/dual-2pc-trigger.service', () => ({
  dualTriggerService: {
    getRegistryStatus: jest.fn(),
    collectPendingSubjects: jest.fn(),
    triggerAssignGroup: jest.fn(),
  },
}));

jest.mock('@02-processes/measurements/services/measurement.service', () => ({
  stopMeasurementService: jest.fn(),
}));

// 헤더가 없으면 401, 있으면 요청자를 주입함
jest.mock('@07-shared/middlewares/authenticate.middleware', () => ({
  authenticate: (
    req: import('@07-shared/types').AuthedRequest,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    const { AppError } = jest.requireActual('@07-shared/errors');
    if (!req.headers.authorization) {
      return next(new AppError('인증이 필요합니다.', 401));
    }
    req.user = { id: 'requester-1' };
    next();
  },
}));

import { assertGroupOwnership } from '@05-features/sessions';
import { dualTriggerService } from '../services/dual-2pc-trigger.service';
import type { RegistryStatus } from '../services/dual-2pc-trigger.service';
import { AppError } from '@07-shared/errors';
import engineRouter from './engine.routes';

const IDLE_STATUS: RegistryStatus = {
  ready: false,
  registered: 0,
  attempts: 0,
  inFlight: false,
};

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

/** 소유권 검증이 주어진 상태 코드로 거부하도록 만듦 */
function denyOwnership(statusCode: number) {
  jest
    .mocked(assertGroupOwnership)
    .mockRejectedValueOnce(new AppError('거부됨', statusCode));
}

describe('registry-status, dual-trigger 인증과 소유권 검증 (AUTH-W003)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(assertGroupOwnership).mockReset().mockResolvedValue(undefined);
    jest
      .mocked(dualTriggerService.getRegistryStatus)
      .mockReturnValue(IDLE_STATUS);
    jest
      .mocked(dualTriggerService.collectPendingSubjects)
      .mockResolvedValue(SUBJECTS);
    jest
      .mocked(dualTriggerService.triggerAssignGroup)
      .mockResolvedValue({ status: 'triggered' });
  });

  it('E1 — registry-status 토큰 없음은 401이고 조회하지 않음', async () => {
    const res = await request(app)
      .get('/api/engine/registry-status')
      .query({ groupId: GROUP_ID });

    expect(res.status).toBe(401);
    expect(dualTriggerService.getRegistryStatus).not.toHaveBeenCalled();
  });

  it('E2 — registry-status 무관한 사용자는 403이고 조회하지 않음', async () => {
    denyOwnership(403);

    const res = await request(app)
      .get('/api/engine/registry-status')
      .set(AUTH)
      .query({ groupId: GROUP_ID });

    expect(res.status).toBe(403);
    expect(dualTriggerService.getRegistryStatus).not.toHaveBeenCalled();
  });

  it('E3 — registry-status 소유자는 200이고 상태를 그대로 받음', async () => {
    const res = await request(app)
      .get('/api/engine/registry-status')
      .set(AUTH)
      .query({ groupId: GROUP_ID });

    expect(res.status).toBe(200);
    expect(assertGroupOwnership).toHaveBeenCalledWith(GROUP_ID, 'requester-1');
    expect(res.body).toEqual(IDLE_STATUS);
  });

  it('E4 — registry-status groupId 없음은 400이고 소유권을 보지 않음', async () => {
    const res = await request(app).get('/api/engine/registry-status').set(AUTH);

    expect(res.status).toBe(400);
    expect(assertGroupOwnership).not.toHaveBeenCalled();
  });

  it('E5 — dual-trigger 토큰 없음은 401이고 엔진을 찾지 않음', async () => {
    const res = await request(app)
      .post('/api/engine/dual-trigger')
      .send({ groupId: GROUP_ID });

    expect(res.status).toBe(401);
    expect(dualTriggerService.collectPendingSubjects).not.toHaveBeenCalled();
  });

  it('E6 — dual-trigger 무관한 사용자는 403이고 발화하지 않음', async () => {
    denyOwnership(403);

    const res = await request(app)
      .post('/api/engine/dual-trigger')
      .set(AUTH)
      .send({ groupId: GROUP_ID });

    expect(res.status).toBe(403);
    expect(dualTriggerService.collectPendingSubjects).not.toHaveBeenCalled();
    expect(dualTriggerService.triggerAssignGroup).not.toHaveBeenCalled();
  });

  it('E7 — dual-trigger 소유자는 200이고 두 엔진에 발화함', async () => {
    const res = await request(app)
      .post('/api/engine/dual-trigger')
      .set(AUTH)
      .send({ groupId: GROUP_ID });

    expect(res.status).toBe(200);
    expect(assertGroupOwnership).toHaveBeenCalledWith(GROUP_ID, 'requester-1');
    expect(dualTriggerService.triggerAssignGroup).toHaveBeenCalledWith(
      GROUP_ID,
      SUBJECTS
    );
  });

  it('E8 — dual-trigger body 에 groupId 없음은 400이고 소유권을 보지 않음', async () => {
    const res = await request(app)
      .post('/api/engine/dual-trigger')
      .set(AUTH)
      .send({});

    expect(res.status).toBe(400);
    expect(assertGroupOwnership).not.toHaveBeenCalled();
  });

  it('E9 — registry-status 세션 없는 그룹은 404이고 조회하지 않음', async () => {
    denyOwnership(404);

    const res = await request(app)
      .get('/api/engine/registry-status')
      .set(AUTH)
      .query({ groupId: GROUP_ID });

    expect(res.status).toBe(404);
    expect(dualTriggerService.getRegistryStatus).not.toHaveBeenCalled();
  });

  it('E10 — dual-trigger 대기 엔진이 2대가 아니면 503이고 발화하지 않음', async () => {
    jest
      .mocked(dualTriggerService.collectPendingSubjects)
      .mockResolvedValue([SUBJECTS[0]]);

    const res = await request(app)
      .post('/api/engine/dual-trigger')
      .set(AUTH)
      .send({ groupId: GROUP_ID });

    expect(res.status).toBe(503);
    expect(dualTriggerService.triggerAssignGroup).not.toHaveBeenCalled();
  });

  it('E11 — registry-status 토큰도 groupId 도 없으면 401임', async () => {
    const res = await request(app).get('/api/engine/registry-status');

    expect(res.status).toBe(401);
  });

  it('E12 — registry-status groupId 가 배열이면 400이고 소유권을 보지 않음', async () => {
    const res = await request(app)
      .get('/api/engine/registry-status')
      .set(AUTH)
      .query(`groupId=${GROUP_ID}&groupId=${GROUP_ID}`);

    expect(res.status).toBe(400);
    expect(assertGroupOwnership).not.toHaveBeenCalled();
  });
});
