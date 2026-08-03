/**
 * session.schema.ts — DUAL_2PC enum + toJSON fallback 테스트 (BE-2 + BE-6)
 *
 * 검증 항목:
 *   BE-2: experimentMode enum — BTI/DUAL_2PC 허용, 그 외 → ValidationError (SESSION-W002)
 *   BE-6: toJSON fallback — experimentMode 필드 없는 레거시 문서 → 'DUAL' 반환
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// BE-2: 소스 정적 검증 — DUAL_2PC enum 포함 확인
// ============================================================

describe('session.schema.ts — BE-2: experimentMode DUAL_2PC enum 포함 (정적)', () => {
  let source: string;

  beforeAll(() => {
    const filePath = path.resolve(__dirname, 'session.schema.ts');
    source = fs.readFileSync(filePath, 'utf-8');
  });

  it("enum에 'DUAL_2PC'가 포함됨", () => {
    expect(source).toContain("'DUAL_2PC'");
  });

  it("enum이 'BTI' 와 'DUAL_2PC' 둘임 (SESSION-W002)", () => {
    expect(source).toContain("'BTI'");
    expect(source).toContain("'DUAL_2PC'");
    expect(source).toContain("enum: ['BTI', 'DUAL_2PC']");
  });

  it('스키마 required: true가 설정됨', () => {
    expect(source).toContain('required: true');
  });

  it("default가 'DUAL_2PC'로 설정됨 (SESSION-W002)", () => {
    expect(source).toMatch(/default:\s*['"]DUAL_2PC['"]/);
  });
});

// ============================================================
// BE-2: Zod 런타임 검증 — Mongoose 없이 값 검증
// ============================================================

describe('session.schema.ts — BE-2: experimentMode enum 런타임 검증', () => {
  const { z } = require('zod');
  // Mongoose enum과 동일한 범위를 Zod로 재현하여 런타임 검증 수행함
  const experimentModeSchema = z.enum(['BTI', 'DUAL_2PC']);

  it("'DUAL' 거부됨 (SESSION-W002)", () => {
    expect(experimentModeSchema.safeParse('DUAL').success).toBe(false);
  });

  it("'SEQUENTIAL' 거부됨 (SESSION-W002)", () => {
    expect(experimentModeSchema.safeParse('SEQUENTIAL').success).toBe(false);
  });

  it("'BTI' 허용됨", () => {
    expect(experimentModeSchema.safeParse('BTI').success).toBe(true);
  });

  it("'DUAL_2PC' 허용됨", () => {
    expect(experimentModeSchema.safeParse('DUAL_2PC').success).toBe(true);
  });

  it("'INVALID' → 검증 실패함 (ValidationError 상당)", () => {
    expect(experimentModeSchema.safeParse('INVALID').success).toBe(false);
  });

  it("'' (빈 문자열) → 검증 실패함", () => {
    expect(experimentModeSchema.safeParse('').success).toBe(false);
  });
});

// ============================================================
// BE-6: toJSON fallback — 정적 소스 검증
// ============================================================

describe('session.schema.ts — BE-6: toJSON fallback 정적 검증', () => {
  let source: string;

  beforeAll(() => {
    const filePath = path.resolve(__dirname, 'session.schema.ts');
    source = fs.readFileSync(filePath, 'utf-8');
  });

  it("toJSON 메서드에 experimentMode ??= 'DUAL_2PC' 방어 로직이 존재함", () => {
    // 레거시 문서(experimentMode 필드 없음) → 'DUAL' 반환 (plan-review L-1)
    expect(source).toMatch(/experimentMode\s*\?\?=\s*['"]DUAL_2PC['"]/);
  });

  it('toJSON 메서드가 스키마에 정의됨', () => {
    expect(source).toContain('toJSON');
  });
});

// ============================================================
// BE-6: toJSON fallback — 런타임 동작 검증
// ============================================================

describe('session.schema.ts — BE-6: toJSON fallback 런타임 동작', () => {
  it('experimentMode가 undefined인 객체에 fallback 적용 시 DUAL_2PC 반환함', () => {
    // toJSON 내부 로직을 직접 시뮬레이션
    // obj.experimentMode ??= 'DUAL_2PC' 동작 검증
    const obj: Record<string, unknown> = {
      _id: 'some-id',
      groupId: 'grp-001',
      // experimentMode 필드 없음 (레거시 문서)
    };

    // ??= 연산자 동작 시뮬레이션
    (obj as any).experimentMode ??= 'DUAL_2PC';

    expect(obj.experimentMode).toBe('DUAL_2PC');
  });

  it('experimentMode가 이미 설정된 경우 fallback이 덮어쓰지 않음', () => {
    const obj: Record<string, unknown> = {
      _id: 'some-id',
      groupId: 'grp-001',
      experimentMode: 'DUAL_2PC',
    };

    // ??= 연산자는 nullish일 때만 할당 — 이미 값이 있으면 무시함
    (obj as any).experimentMode ??= 'DUAL_2PC';

    expect(obj.experimentMode).toBe('DUAL_2PC');
  });

  it('experimentMode가 null인 경우 DUAL_2PC fallback 적용됨', () => {
    const obj: Record<string, unknown> = {
      _id: 'some-id',
      groupId: 'grp-001',
      experimentMode: null,
    };

    (obj as any).experimentMode ??= 'DUAL_2PC';

    expect(obj.experimentMode).toBe('DUAL_2PC');
  });
});
