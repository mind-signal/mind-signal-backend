/**
 * SESSION-W008 — 엔진 자연 종료(csv-upload)와 수동 중지(stop-all)의 경합 검증.
 *
 * 엔진은 측정을 끝낼 때 CSV 를 올림. 백엔드는 그 업로드로 세션을 Natural 로
 * 끝내고, 운영자 `실험 중지`와 어느 순서로 와도 세션 전이와 등급 판정이
 * 한 번만 일어나야 함. 세션 모델과 stopMeasurementService 는 메모리 가짜로
 * 바꿈. 가짜 전이는 실제처럼 조회와 저장 사이에 한 틱을 양보해 경합을 드러냄.
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const GROUP_ID = '65c9f0b2a1b2c3d4e5f67890';
const SECRET = 'correct-engine-secret';

interface FakeSession {
  groupId: string;
  subjectIndex: number;
  status: string;
  stopReason: string | null;
  analysisTier: string | null;
}

// 메모리 세션 저장소임. 테스트마다 다시 채움
const store: FakeSession[] = [];
// subject 별 유효 판정값임
const validBySubject: Record<number, boolean> = { 1: true, 2: true };

jest.mock('@07-shared/config/config', () => ({
  config: {
    env: 'test',
    port: 5000,
    mongoUri: 'mongodb://localhost:27017/test',
    jwtSecret: { secret: 'test-secret', expiresIn: '5m' },
    isProduction: false,
    redis: { url: 'redis://localhost:6379' },
    dataEngine: {
      path: '/tmp/engine',
      baseUrl: 'http://localhost:5002',
      pythonBin: 'python',
      secretKey: 'correct-engine-secret',
    },
    dualPc: { timestampToleranceMs: 200, registrationTimeoutMs: 60000 },
  },
}));

jest.mock('@06-entities/sessions', () => ({
  Session: {
    findOne: jest.fn(
      async (q: { groupId: string; subjectIndex: number }) =>
        store.find(
          (s) => s.groupId === q.groupId && s.subjectIndex === q.subjectIndex
        ) ?? null
    ),
    find: jest.fn(async (q: { groupId: string; status?: string }) =>
      store.filter(
        (s) => s.groupId === q.groupId && (!q.status || s.status === q.status)
      )
    ),
    updateMany: jest.fn(
      async (
        q: { groupId: string; analysisTier: null },
        u: { $set: { analysisTier: string } }
      ) => {
        const hit = store.filter(
          (s) => s.groupId === q.groupId && s.analysisTier === null
        );
        hit.forEach((s) => (s.analysisTier = u.$set.analysisTier));
        return { modifiedCount: hit.length };
      }
    ),
  },
}));

jest.mock('@02-processes/measurements/services/measurement.service', () => ({
  stopMeasurementService: jest.fn(
    async (groupId: string, subjectIndex: number, stopReason: string) => {
      const s = store.find(
        (x) => x.groupId === groupId && x.subjectIndex === subjectIndex
      );
      if (!s) throw new Error('세션을 찾을 수 없습니다.');
      const canComplete = s.status === 'MEASURING';
      // 실제 서비스의 findOne 과 save 사이 양보를 흉내 냄
      await new Promise((r) => setImmediate(r));
      if (!canComplete) throw new Error(`현재 ${s.status} 상태`);
      s.status = 'COMPLETED';
      s.stopReason = stopReason;
      const group = store.filter((x) => x.groupId === groupId);
      return { allCompleted: group.every((x) => x.status === 'COMPLETED') };
    }
  ),
}));

jest.mock('../services/session-coverage.service', () => ({
  MIN_COVERAGE_RATIO: 0.9,
  readCsvStats: jest.fn((_g: string, subjectIndex: number) => ({
    rows: subjectIndex,
    spanSeconds: 0,
  })),
  evaluateSubjectCoverage: jest.fn((stats: { rows: number }) => ({
    valid: validBySubject[stats.rows],
    density: 1,
    completionRatio: 1,
    legacyCoverage: 1,
    reason: '테스트',
  })),
}));

jest.mock('@02-processes/post-measurement', () => ({
  runPostMeasurementPipeline: jest.fn().mockResolvedValue(undefined),
  runBTIAnalysisPipeline: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@07-shared/lib/socket', () => ({
  SocketService: { emitToGroup: jest.fn() },
}));

jest.mock('../services/engine-proxy.service', () => ({
  engineProxyService: { streamStop: jest.fn().mockResolvedValue({ ok: true }) },
}));

jest.mock('@05-features/sessions', () => ({
  assertGroupOwnership: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@07-shared/middlewares/authenticate.middleware', () => ({
  authenticate: (
    req: import('@07-shared/types').AuthedRequest,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    req.user = { id: 'operator-1' };
    next();
  },
}));

import { stopMeasurementService } from '@02-processes/measurements/services/measurement.service';
import { SocketService } from '@07-shared/lib/socket';
import { engineProxyService } from '../services/engine-proxy.service';
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
    res.status(err.statusCode ?? 500).json({ message: err.message });
  }
);

const TEST_CSV_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-natural-'));

/** 엔진 on_close 처럼 subject CSV 를 올림 */
function upload(subjectIndex: number) {
  return request(app)
    .post(
      `/api/engine/csv-upload?filename=subject_${subjectIndex}_${GROUP_ID}_20261018_120000.csv`
    )
    .set('x-engine-secret', SECRET)
    .set('Content-Type', 'text/csv')
    .send('time,alpha\n');
}

/** 운영자 `실험 중지` 를 누름 */
function stopAll() {
  return request(app)
    .post('/api/engine/stream/stop-all')
    .send({ groupId: GROUP_ID });
}

/** fire-and-forget 등급 판정이 끝나기를 기다림 */
const settle = () => new Promise((r) => setTimeout(r, 30));

/** analysis-status emit 목록 반환함 */
function tierEvents() {
  return jest
    .mocked(SocketService.emitToGroup)
    .mock.calls.filter(([, event]) => event === 'analysis-status')
    .map(([, , payload]) => (payload as { tier: string }).tier);
}

function reasons() {
  return store.map((s) => `${s.subjectIndex}:${s.status}:${s.stopReason}`);
}

describe('csv-upload 자연 종료와 stop-all 경합 (SESSION-W008)', () => {
  beforeAll(() => {
    process.env.CSV_STORAGE_DIR = TEST_CSV_DIR;
  });

  afterAll(() => {
    fs.rmSync(TEST_CSV_DIR, { recursive: true, force: true });
    delete process.env.CSV_STORAGE_DIR;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    store.length = 0;
    for (const subjectIndex of [1, 2]) {
      store.push({
        groupId: GROUP_ID,
        subjectIndex,
        status: 'MEASURING',
        stopReason: null,
        analysisTier: null,
      });
    }
    validBySubject[1] = true;
    validBySubject[2] = true;
    jest.mocked(engineProxyService.streamStop).mockResolvedValue({ ok: true });
  });

  it.each([
    [1, 2],
    [2, 1],
  ])(
    '자연 종료 — subject %i 다음 %i 업로드로 두 세션이 Natural 로 끝나고 VALID 가 한 번 나감',
    async (first, second) => {
      await upload(first).expect(200);
      expect(tierEvents()).toEqual([]);
      await upload(second).expect(200);
      await settle();

      expect(reasons()).toEqual(['1:COMPLETED:Natural', '2:COMPLETED:Natural']);
      expect(store.map((s) => s.analysisTier)).toEqual(['VALID', 'VALID']);
      expect(tierEvents()).toEqual(['VALID']);
    }
  );

  it('자연 종료 뒤 수동 중지 — stop-all 은 200 이고 전이와 판정을 다시 하지 않음', async () => {
    await upload(1);
    await upload(2);
    await settle();

    const res = await stopAll().expect(200);
    await settle();

    expect(res.body).toMatchObject({ stoppedCount: 0, allCompleted: true });
    expect(stopMeasurementService).toHaveBeenCalledTimes(2);
    expect(reasons()).toEqual(['1:COMPLETED:Natural', '2:COMPLETED:Natural']);
    expect(tierEvents()).toEqual(['VALID']);
  });

  it('수동 중지 뒤 업로드 — 세션은 ManualEarly 로 남고 업로드는 CSV 만 저장함', async () => {
    await stopAll().expect(200);
    await upload(1).expect(200);
    await upload(2).expect(200);
    await settle();

    expect(stopMeasurementService).toHaveBeenCalledTimes(2);
    expect(reasons()).toEqual([
      '1:COMPLETED:ManualEarly',
      '2:COMPLETED:ManualEarly',
    ]);
    expect(tierEvents()).toEqual(['VALID']);
  });

  it('수동 중지 중 엔진이 업로드 — 업로드가 세션을 Natural 로 바꾸지 않음', async () => {
    // 실제 엔진은 stop_stream 으로 멈추며 on_close 에서 CSV 를 올림
    jest
      .mocked(engineProxyService.streamStop)
      .mockImplementation(async (_g, subjectIndex) => {
        await upload(subjectIndex).expect(200);
        return { ok: true };
      });

    await stopAll().expect(200);
    await settle();

    expect(stopMeasurementService).toHaveBeenCalledTimes(2);
    expect(reasons()).toEqual([
      '1:COMPLETED:ManualEarly',
      '2:COMPLETED:ManualEarly',
    ]);
    expect(tierEvents()).toEqual(['VALID']);
  });

  it('업로드와 stop-all 이 동시에 와도 세션 전이와 판정은 한 번씩임', async () => {
    const [, , stop] = await Promise.all([upload(1), upload(2), stopAll()]);
    await settle();

    expect(stop.status).toBe(200);
    expect(store.every((s) => s.status === 'COMPLETED')).toBe(true);
    expect(stopMeasurementService).toHaveBeenCalledTimes(2);
    expect(tierEvents()).toEqual(['VALID']);
  });

  it('MEASURING 이 아닌 세션의 업로드는 상태를 바꾸지 않음', async () => {
    store.forEach((s) => (s.status = 'PAIRED'));

    await upload(1).expect(200);
    await settle();

    expect(store.map((s) => s.status)).toEqual(['PAIRED', 'PAIRED']);
    expect(tierEvents()).toEqual([]);
  });

  it('잘못된 시크릿의 업로드는 403 이고 세션을 건드리지 않음', async () => {
    await request(app)
      .post(
        `/api/engine/csv-upload?filename=subject_1_${GROUP_ID}_20261018_120000.csv`
      )
      .set('x-engine-secret', 'wrong')
      .set('Content-Type', 'text/csv')
      .send('time,alpha\n')
      .expect(403);

    expect(stopMeasurementService).not.toHaveBeenCalled();
  });

  it.each([
    [true, false, 'PARTIAL'],
    [false, false, 'ABORTED'],
  ])(
    '등급 저장 — subject1 유효=%s, subject2 유효=%s 이면 %s 를 저장하고 알림',
    async (v1, v2, tier) => {
      validBySubject[1] = v1;
      validBySubject[2] = v2;

      await upload(1);
      await upload(2);
      await settle();

      expect(store.map((s) => s.analysisTier)).toEqual([tier, tier]);
      expect(tierEvents()).toEqual([tier]);
    }
  );
});
