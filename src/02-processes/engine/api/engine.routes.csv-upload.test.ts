/**
 * engine.routes.ts — POST /api/engine/csv-upload supertest 런타임 검증 (2-PC CSV 집계)
 *
 * 배경: DUAL_2PC에서 노트북 B DE가 자기 subject_2 CSV를 operator BE로 업로드함.
 * operator의 csv 폴더(분석이 읽는 위치)에 저장되어야 두 subject 분석이 가능함.
 *
 * 검증 항목:
 *   - 유효 secret + 유효 filename + CSV 본문 → 200 + 파일이 CSV_STORAGE_DIR에 저장됨
 *   - secret 불일치 → 403
 *   - filename 패턴 위반(path traversal 등) → 400
 *   - 같은 filename 재업로드 → 200 (멱등 overwrite)
 */

import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// config 모킹 — dataEngine.secretKey 고정값 주입
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
    dualPc: {
      timestampToleranceMs: 200,
      registrationTimeoutMs: 60000,
    },
  },
}));

import engineRouter from './engine.routes';

// 테스트용 CSV 저장 디렉토리 — 실제 Team-project/csv 오염 방지
const TEST_CSV_DIR = path.join(os.tmpdir(), 'ms-csv-upload-test');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/engine', engineRouter);
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      res.status(err.statusCode || 500).json({
        status: err.status || 'error',
        message: err.message,
      });
    }
  );
  return app;
}

const VALID_FILENAME = 'subject_2_6a413cef58664859f44ee519_20260629_002612.csv';
const CSV_BODY =
  'time,delta,theta,alpha,beta,gamma\n2026-06-29 00:26:12,0.1,0.2,0.3,0.4,0.5\n';

describe('POST /api/engine/csv-upload — 2-PC subject CSV 업로드', () => {
  const app = buildApp();

  beforeEach(() => {
    process.env.CSV_STORAGE_DIR = TEST_CSV_DIR;
    fs.rmSync(TEST_CSV_DIR, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_CSV_DIR, { recursive: true, force: true });
    delete process.env.CSV_STORAGE_DIR;
  });

  it('유효 secret + 유효 filename + CSV 본문 → 200 + 파일 저장됨', async () => {
    const res = await request(app)
      .post(`/api/engine/csv-upload?filename=${VALID_FILENAME}`)
      .set('x-engine-secret', 'correct-engine-secret')
      .set('Content-Type', 'text/csv')
      .send(CSV_BODY);

    expect(res.status).toBe(200);

    const saved = path.join(TEST_CSV_DIR, VALID_FILENAME);
    expect(fs.existsSync(saved)).toBe(true);
    expect(fs.readFileSync(saved, 'utf-8')).toBe(CSV_BODY);
  });

  it('secret 불일치 → 403', async () => {
    const res = await request(app)
      .post(`/api/engine/csv-upload?filename=${VALID_FILENAME}`)
      .set('x-engine-secret', 'wrong-secret')
      .set('Content-Type', 'text/csv')
      .send(CSV_BODY);

    expect(res.status).toBe(403);
  });

  it('filename path traversal → 400 (파일 미저장)', async () => {
    const evil = encodeURIComponent('../../evil.csv');
    const res = await request(app)
      .post(`/api/engine/csv-upload?filename=${evil}`)
      .set('x-engine-secret', 'correct-engine-secret')
      .set('Content-Type', 'text/csv')
      .send(CSV_BODY);

    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(os.tmpdir(), 'evil.csv'))).toBe(false);
  });

  it('같은 filename 재업로드 → 200 (멱등 overwrite)', async () => {
    await request(app)
      .post(`/api/engine/csv-upload?filename=${VALID_FILENAME}`)
      .set('x-engine-secret', 'correct-engine-secret')
      .set('Content-Type', 'text/csv')
      .send('old\n');

    const res = await request(app)
      .post(`/api/engine/csv-upload?filename=${VALID_FILENAME}`)
      .set('x-engine-secret', 'correct-engine-secret')
      .set('Content-Type', 'text/csv')
      .send(CSV_BODY);

    expect(res.status).toBe(200);
    const saved = path.join(TEST_CSV_DIR, VALID_FILENAME);
    expect(fs.readFileSync(saved, 'utf-8')).toBe(CSV_BODY);
  });
});
