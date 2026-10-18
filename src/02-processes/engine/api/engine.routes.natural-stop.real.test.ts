/**
 * SESSION-W008 — 엔진 CSV 업로드 자연 종료를 실제 stopMeasurementService 로 검증.
 *
 * natural-stop.test.ts 는 전이 서비스를 가짜로 바꿔 경합만 봄. 여기서는 Mongo
 * 대신 메모리 세션 문서(canTransitionTo, save 포함)를 두고 실제 서비스가
 * 전이 규칙대로 두 세션을 끝내는지, DUAL_2PC 의 measurement-complete 가
 * 그룹당 한 번만 나가는지, 그룹 정리까지 하는지 확인함.
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const GROUP_ID = '65c9f0b2a1b2c3d4e5f6aaaa';
const SECRET = 'correct-engine-secret';

interface MemSession {
  _id: string;
  groupId: string;
  subjectIndex: number;
  status: string;
  stopReason: string | null;
  analysisTier: string | null;
  experimentMode: string;
  measuredAt: Date | null;
  measuredDurationSeconds: number | null;
  canTransitionTo(next: string): boolean;
  save(): Promise<void>;
}

const store: MemSession[] = [];

jest.mock('@07-shared/config/config', () => ({
  config: {
    env: 'test',
    isProduction: false,
    messageBus: 'redis',
    redis: { url: 'redis://localhost:6379' },
    dataEngine: {
      path: '/tmp/engine',
      baseUrl: 'http://localhost:5002',
      pythonBin: 'python',
      secretKey: 'correct-engine-secret',
    },
    // soloWaitMs 는 정지 유예 시간이기도 함. 테스트 시간을 줄이려고 100ms 로 둠
    dualPc: {
      timestampToleranceMs: 200,
      soloWaitMs: 100,
      registrationTimeoutMs: 60000,
    },
    measurement: { expectedSeconds: 600 },
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
        q: Record<string, unknown>,
        u: { $set: Record<string, unknown> }
      ) => {
        const hit = store.filter((s) =>
          Object.entries(q).every(
            ([k, v]) => (s as unknown as Record<string, unknown>)[k] === v
          )
        );
        hit.forEach((s) => Object.assign(s, u.$set));
        return { modifiedCount: hit.length };
      }
    ),
  },
}));

jest.mock('@07-shared/lib/socket', () => ({
  SocketService: { emitToGroup: jest.fn() },
  BrainSyncAllSchema: { safeParse: jest.fn() },
}));

jest.mock('@07-shared/lib/redis', () => ({
  redisService: { client: { duplicate: jest.fn() } },
}));

// aligner 는 실제 구현을 씀. 정지 시 남은 샘플 flush 를 이 경로로 검증함 (EEG-W008)

jest.mock(
  '@02-processes/measurements/services/stimulus-broadcaster.service',
  () => ({ stimulusBroadcasterService: { broadcast: jest.fn() } })
);

jest.mock('../services/session-coverage.service', () => ({
  MIN_COVERAGE_RATIO: 0.9,
  readCsvStats: jest.fn(() => ({ rows: 600, spanSeconds: 600 })),
  evaluateSubjectCoverage: jest.fn(() => ({
    valid: true,
    density: 1,
    completionRatio: 1,
    legacyCoverage: 1,
    reason: '',
  })),
}));

jest.mock('@02-processes/post-measurement', () => ({
  runPostMeasurementPipeline: jest.fn().mockResolvedValue(undefined),
  runBTIAnalysisPipeline: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/engine-proxy.service', () => ({
  engineProxyService: { streamStop: jest.fn().mockResolvedValue({ ok: true }) },
}));

jest.mock('@05-features/sessions', () => ({
  assertGroupOwnership: jest.fn().mockResolvedValue(undefined),
}));

import { SocketService } from '@07-shared/lib/socket';
import { Session } from '@06-entities/sessions';
import { engineRegistryService } from '../services/engine-registry.service';
import { timestampAlignerRegistry } from '@02-processes/measurements/services/timestamp-aligner.service';
import engineRouter from './engine.routes';

const app = express();
app.use('/api/engine', engineRouter);

const TEST_CSV_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-natural-real-'));

/** 세션 문서 하나를 실제 전이 규칙과 함께 생성함 */
function makeSession(subjectIndex: number): MemSession {
  return {
    _id: `s${subjectIndex}`,
    groupId: GROUP_ID,
    subjectIndex,
    status: 'MEASURING',
    stopReason: null,
    analysisTier: null,
    experimentMode: 'DUAL_2PC',
    measuredAt: new Date(Date.now() - 601 * 1000),
    measuredDurationSeconds: null,
    // session.schema.ts 의 MEASURING 전이 규칙과 같음
    canTransitionTo(next: string) {
      return this.status === 'MEASURING' && next === 'COMPLETED';
    },
    save: jest.fn().mockResolvedValue(undefined),
  };
}

function upload(subjectIndex: number) {
  return request(app)
    .post(
      `/api/engine/csv-upload?filename=subject_${subjectIndex}_${GROUP_ID}_20261018_120000.csv`
    )
    .set('x-engine-secret', SECRET)
    .set('Content-Type', 'text/csv')
    .send('time,alpha\n');
}

function events(name: string) {
  return jest
    .mocked(SocketService.emitToGroup)
    .mock.calls.filter(([, event]) => event === name);
}

describe('csv-upload 자연 종료 — 실제 stopMeasurementService 경유 (SESSION-W008)', () => {
  beforeAll(() => {
    process.env.CSV_STORAGE_DIR = TEST_CSV_DIR;
  });

  afterAll(() => {
    fs.rmSync(TEST_CSV_DIR, { recursive: true, force: true });
    delete process.env.CSV_STORAGE_DIR;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    timestampAlignerRegistry.__resetForTest__();
    store.length = 0;
    store.push(makeSession(1), makeSession(2));
    for (const subjectIndex of [1, 2]) {
      engineRegistryService.registerDual(
        GROUP_ID,
        subjectIndex,
        `http://engine-${subjectIndex}`,
        SECRET
      );
    }
  });

  it('두 업로드로 두 세션이 Natural COMPLETED 가 되고 measurement-complete 는 한 번 나감', async () => {
    await upload(1).expect(200);
    expect(events('measurement-complete')).toHaveLength(0);

    await upload(2).expect(200);
    // 같은 subject 재업로드는 전이도 emit 도 다시 하지 않음
    await upload(2).expect(200);
    await new Promise((r) => setTimeout(r, 30));

    expect(
      store.map((s) => [s.status, s.stopReason, s.measuredDurationSeconds])
    ).toEqual([
      ['COMPLETED', 'Natural', expect.any(Number)],
      ['COMPLETED', 'Natural', expect.any(Number)],
    ]);
    expect(events('measurement-complete')).toHaveLength(1);
    expect(events('measurement-complete')[0][2]).toMatchObject({
      groupId: GROUP_ID,
      stopReason: 'Natural',
    });
    // 그룹 종료 정리로 엔진 등록이 지워짐
    expect(engineRegistryService.getByGroup(GROUP_ID)).toBeUndefined();
    expect(store.map((s) => s.analysisTier)).toEqual(['VALID', 'VALID']);
  });

  it('정지 시 aligner 에 남은 쌍과 미매칭 샘플을 measurement-complete 전에 내보냄 (EEG-W008)', async () => {
    // 100ms flush 주기 사이에 마지막 샘플이 들어온 채 정지가 오는 상황임
    const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
    const sample = (v: number) => ({
      waves: { delta: v, theta: v, alpha: v, beta: v, gamma: v },
    });
    timestampAlignerRegistry.getOrCreate(GROUP_ID, 200, 1000);
    const now = Date.now();
    timestampAlignerRegistry.ingest(GROUP_ID, 1, sample(1), now, ns(1000));
    timestampAlignerRegistry.ingest(GROUP_ID, 2, sample(10), now, ns(1010));
    timestampAlignerRegistry.ingest(GROUP_ID, 1, sample(2), now, ns(5000));

    await upload(1).expect(200);
    await upload(2).expect(200);
    await new Promise((r) => setTimeout(r, 30));

    const calls = jest.mocked(SocketService.emitToGroup).mock.calls;
    const order = calls
      .map(([, event]) => event)
      .filter((e) => e === 'aligned_pair' || e === 'measurement-complete');
    expect(order).toEqual([
      'aligned_pair',
      'aligned_pair',
      'measurement-complete',
    ]);
    const pairs = events('aligned_pair').map(([, , p]) => {
      const a = p as {
        subject_1: { waves: { delta: number } } | null;
        subject_2: { waves: { delta: number } } | null;
      };
      return [
        a.subject_1?.waves.delta ?? null,
        a.subject_2?.waves.delta ?? null,
      ];
    });
    expect(pairs).toEqual([
      [1, 10],
      [2, null],
    ]);
    // 정지 뒤 aligner 는 제거되어 다시 flush 해도 아무것도 나가지 않음
    expect(timestampAlignerRegistry.flush(GROUP_ID)).toEqual([]);
  });

  it('정지 처리 시작 뒤 유예 안에 도착한 마지막 샘플도 measurement-complete 전에 짝을 맞춰 나감 (EEG-W008)', async () => {
    // 하네스 redis 버스, subject 2 지연 300ms: 엔진 2 의 CSV 업로드가 중계기에
    // 걸린 마지막 샘플보다 먼저 와서, 그 샘플이 drain 뒤 publish 되어 사라졌음
    const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
    const sample = (v: number) => ({
      waves: { delta: v, theta: v, alpha: v, beta: v, gamma: v },
    });
    timestampAlignerRegistry.getOrCreate(GROUP_ID, 200, 100);
    timestampAlignerRegistry.ingest(
      GROUP_ID,
      1,
      sample(1),
      Date.now(),
      ns(1000)
    );

    // 두 세션이 모두 COMPLETED 로 보인 직후(allCompleted 판정 시점)에서 20ms 뒤
    // subject 2 의 마지막 샘플이 도착하게 함
    // 위 jest.mock 의 메모리 구현을 감쌈. mongoose Query 타입이 아니라 Promise 를
    // 돌려주는 가짜라 jest.Mock 으로 다룸
    const findMock = Session.find as unknown as jest.Mock;
    const findImpl = findMock.getMockImplementation()!;
    let scheduled = false;
    findMock.mockImplementation(async (q: { groupId: string }) => {
      const result = await findImpl(q);
      if (!scheduled && store.every((x) => x.status === 'COMPLETED')) {
        scheduled = true;
        setTimeout(() => {
          timestampAlignerRegistry.ingest(
            GROUP_ID,
            2,
            sample(10),
            Date.now(),
            ns(1010)
          );
        }, 20);
      }
      return result;
    });

    await upload(1).expect(200);
    await upload(2).expect(200);
    await new Promise((r) => setTimeout(r, 30));
    findMock.mockImplementation(findImpl);

    const order = jest
      .mocked(SocketService.emitToGroup)
      .mock.calls.map(([, event, p]) => {
        if (event !== 'aligned_pair') return event;
        const a = p as {
          subject_1: { waves: { delta: number } } | null;
          subject_2: { waves: { delta: number } } | null;
        };
        return [
          a.subject_1?.waves.delta ?? null,
          a.subject_2?.waves.delta ?? null,
        ];
      })
      .filter((e) => Array.isArray(e) || e === 'measurement-complete');
    expect(scheduled).toBe(true);
    expect(order).toEqual([[1, 10], 'measurement-complete']);
  });
});
