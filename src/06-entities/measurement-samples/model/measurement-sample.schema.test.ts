/* eslint-disable camelcase */
/**
 * measurement-sample.schema.test.ts — MeasurementSample 엔티티 + SampleEnvelopeSchema 검증
 *
 * 검증 항목:
 *   (a) SampleEnvelopeSchema가 유효한 envelope을 파싱함
 *   (b) de_ts_ns / proxy_ingress_ts_ns 비숫자 또는 22자리 이상 → 파싱 실패함
 *   (c) payload shape 불완전(band 누락) → 파싱 실패함
 *   (d) Mongoose measurement-sample.schema가 정상 도큐먼트를 검증하고
 *       de_ts_ns / proxy_ingress_ts_ns를 String으로 저장함
 */

import {
  SampleEnvelopeSchema,
  WavePowerSchema,
} from '@07-shared/schemas/measurement-envelope.schema';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// (a) SampleEnvelopeSchema — 유효한 envelope 파싱
// ============================================================

describe('SampleEnvelopeSchema — 유효한 envelope 파싱', () => {
  const validEnvelope = {
    group_id: 'abc123',
    subject_idx: 0,
    de_ts_ns: '1700000000000000000',
    proxy_ingress_ts_ns: '1700000000000000001',
    seq: 42,
    payload: {
      delta: 1.1,
      theta: 2.2,
      alpha: 3.3,
      beta: 4.4,
      gamma: 5.5,
    },
    sync_meta: { key: 'value' },
  };

  it('(a) 유효한 envelope을 파싱함', () => {
    const result = SampleEnvelopeSchema.safeParse(validEnvelope);
    expect(result.success).toBe(true);
  });

  it('(a) 파싱된 group_id, subject_idx, seq 타입 확인함', () => {
    const result = SampleEnvelopeSchema.safeParse(validEnvelope);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.group_id).toBe('abc123');
    expect(result.data.subject_idx).toBe(0);
    expect(result.data.seq).toBe(42);
  });
});

// ============================================================
// (b) de_ts_ns / proxy_ingress_ts_ns 유효성 검증
// ============================================================

describe('SampleEnvelopeSchema — de_ts_ns / proxy_ingress_ts_ns 유효성 검증', () => {
  const base = {
    group_id: 'grp1',
    subject_idx: 1,
    seq: 0,
    payload: { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 },
    sync_meta: {},
  };

  it('(b) de_ts_ns 비숫자 포함 → 파싱 실패함', () => {
    const result = SampleEnvelopeSchema.safeParse({
      ...base,
      de_ts_ns: '170000abc000',
      proxy_ingress_ts_ns: '1700000000000000001',
    });
    expect(result.success).toBe(false);
  });

  it('(b) de_ts_ns 22자리(>21) → 파싱 실패함', () => {
    const result = SampleEnvelopeSchema.safeParse({
      ...base,
      de_ts_ns: '9'.repeat(22),
      proxy_ingress_ts_ns: '1700000000000000001',
    });
    expect(result.success).toBe(false);
  });

  it('(b) proxy_ingress_ts_ns 비숫자 포함 → 파싱 실패함', () => {
    const result = SampleEnvelopeSchema.safeParse({
      ...base,
      de_ts_ns: '1700000000000000000',
      proxy_ingress_ts_ns: '170000abc000',
    });
    expect(result.success).toBe(false);
  });

  it('(b) proxy_ingress_ts_ns 22자리(>21) → 파싱 실패함', () => {
    const result = SampleEnvelopeSchema.safeParse({
      ...base,
      de_ts_ns: '1700000000000000000',
      proxy_ingress_ts_ns: '9'.repeat(22),
    });
    expect(result.success).toBe(false);
  });

  it('(b) de_ts_ns 21자리(경계 최대값) → 파싱 성공함', () => {
    const result = SampleEnvelopeSchema.safeParse({
      ...base,
      de_ts_ns: '9'.repeat(21),
      proxy_ingress_ts_ns: '1700000000000000001',
    });
    expect(result.success).toBe(true);
  });

  it('(b) de_ts_ns 1자리(경계 최소값) → 파싱 성공함', () => {
    const result = SampleEnvelopeSchema.safeParse({
      ...base,
      de_ts_ns: '0',
      proxy_ingress_ts_ns: '1',
    });
    expect(result.success).toBe(true);
  });

  it('(b) de_ts_ns 빈 문자열 → 파싱 실패함', () => {
    const result = SampleEnvelopeSchema.safeParse({
      ...base,
      de_ts_ns: '',
      proxy_ingress_ts_ns: '1700000000000000001',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================
// (c) payload shape 불완전(band 누락) → 파싱 실패
// ============================================================

describe('SampleEnvelopeSchema — payload 유효성 검증', () => {
  const base = {
    group_id: 'grp1',
    subject_idx: 1,
    de_ts_ns: '1700000000000000000',
    proxy_ingress_ts_ns: '1700000000000000001',
    seq: 0,
    sync_meta: {},
  };

  it('(c) payload에서 gamma 누락 → 파싱 실패함', () => {
    const result = SampleEnvelopeSchema.safeParse({
      ...base,
      payload: { delta: 0, theta: 0, alpha: 0, beta: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('(c) payload에서 alpha 누락 → 파싱 실패함', () => {
    const result = SampleEnvelopeSchema.safeParse({
      ...base,
      payload: { delta: 0, theta: 0, beta: 0, gamma: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('(c) payload가 null → 파싱 실패함', () => {
    const result = SampleEnvelopeSchema.safeParse({
      ...base,
      payload: null,
    });
    expect(result.success).toBe(false);
  });

  it('(c) WavePowerSchema 단독 — 5밴드 모두 number → 파싱 성공함', () => {
    const result = WavePowerSchema.safeParse({
      delta: 1.0,
      theta: 2.0,
      alpha: 3.0,
      beta: 4.0,
      gamma: 5.0,
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================
// (d) Mongoose schema — 정적 소스 검증
// ============================================================

describe('measurement-sample.schema.ts — Mongoose 스키마 정적 검증', () => {
  let source: string;

  beforeAll(() => {
    const filePath = path.resolve(__dirname, 'measurement-sample.schema.ts');
    source = fs.readFileSync(filePath, 'utf-8');
  });

  it('(d) de_ts_ns 필드가 String 타입으로 정의됨', () => {
    expect(source).toContain('de_ts_ns');
    expect(source).toMatch(/de_ts_ns[\s\S]*?type:\s*String/);
  });

  it('(d) proxy_ingress_ts_ns 필드가 String 타입으로 정의됨', () => {
    expect(source).toContain('proxy_ingress_ts_ns');
    expect(source).toMatch(/proxy_ingress_ts_ns[\s\S]*?type:\s*String/);
  });

  it('(d) network_delay_ms 필드가 Number 타입으로 정의됨', () => {
    expect(source).toContain('network_delay_ms');
    expect(source).toMatch(/network_delay_ms[\s\S]*?type:\s*Number/);
  });

  it('(d) Schema.Types.Long 미사용 — String 사용함', () => {
    expect(source).not.toContain('Schema.Types.Long');
  });

  it('(d) 복합 유니크 인덱스(group_id, subject_idx, seq) 선언됨', () => {
    expect(source).toContain('group_id');
    expect(source).toContain('subject_idx');
    expect(source).toContain('seq');
    // 복합 인덱스 선언 확인함
    expect(source).toContain('unique: true');
  });

  it('(d) sync_meta가 Schema.Types.Mixed로 정의됨', () => {
    expect(source).toContain('sync_meta');
    expect(source).toContain('Schema.Types.Mixed');
  });
});

// ============================================================
// (d-runtime) Mongoose MeasurementSampleModel — 실제 행위 검증
// validateSync()는 DB 연결 없이 인메모리 도큐먼트에서 동작함
// ============================================================

import { MeasurementSampleModel } from './measurement-sample.schema';

describe('MeasurementSampleModel — validateSync 행위 검증', () => {
  it('(d-runtime) 유효한 필드 → validateSync() 에러 없음', () => {
    // Arrange: 모든 required 필드를 포함한 도큐먼트 생성함
    const doc = new MeasurementSampleModel({
      group_id: 'grp-test-01',
      subject_idx: 1,
      de_ts_ns: '1700000000000000000',
      proxy_ingress_ts_ns: '1700000000000000001',
      seq: 0,
      sync_meta: {},
    });

    // Act
    const err = doc.validateSync();

    // Assert: 유효한 도큐먼트 → 검증 에러 없음
    expect(err).toBeUndefined();
  });

  it('(d-runtime) de_ts_ns 누락 → validateSync()가 해당 경로에 ValidationError 반환함', () => {
    // Arrange: de_ts_ns 필드 누락한 도큐먼트 생성함
    const doc = new MeasurementSampleModel({
      group_id: 'grp-test-02',
      subject_idx: 1,
      // de_ts_ns 누락
      proxy_ingress_ts_ns: '1700000000000000001',
      seq: 0,
      sync_meta: {},
    });

    // Act
    const err = doc.validateSync();

    // Assert: de_ts_ns 경로에 ValidationError 존재함
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('de_ts_ns');
  });

  it('(d-runtime) proxy_ingress_ts_ns 누락 → validateSync()가 해당 경로에 ValidationError 반환함', () => {
    // Arrange: proxy_ingress_ts_ns 필드 누락한 도큐먼트 생성함
    const doc = new MeasurementSampleModel({
      group_id: 'grp-test-03',
      subject_idx: 1,
      de_ts_ns: '1700000000000000000',
      // proxy_ingress_ts_ns 누락
      seq: 0,
      sync_meta: {},
    });

    // Act
    const err = doc.validateSync();

    // Assert: proxy_ingress_ts_ns 경로에 ValidationError 존재함
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('proxy_ingress_ts_ns');
  });

  it('(d-runtime) de_ts_ns / proxy_ingress_ts_ns가 String으로 저장됨', () => {
    // Arrange: 유효한 도큐먼트 생성함
    const doc = new MeasurementSampleModel({
      group_id: 'grp-test-04',
      subject_idx: 0,
      de_ts_ns: '1700000000000000000',
      proxy_ingress_ts_ns: '1700000000000000001',
      seq: 42,
      sync_meta: { key: 'val' },
    });

    // Assert: Mongoose가 String 타입으로 캐스트하여 저장함
    expect(typeof doc.de_ts_ns).toBe('string');
    expect(typeof doc.proxy_ingress_ts_ns).toBe('string');
    expect(doc.de_ts_ns).toBe('1700000000000000000');
    expect(doc.proxy_ingress_ts_ns).toBe('1700000000000000001');
  });
});
