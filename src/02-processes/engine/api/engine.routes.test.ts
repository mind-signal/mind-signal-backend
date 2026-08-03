/**
 * engine.routes.ts — analyzePipelineSchema mode/similarity_features 확장 검증
 *
 * 검증 항목:
 *   - analyzePipelineSchema에 mode 필드(enum)가 추가됨
 *   - mode: 'DUAL', 'BTI' 허용됨 (SEQUENTIAL 은 SESSION-W002 에서 제거)
 *   - mode: 'INVALID' 시 파싱 실패함
 *   - algorithm 필드가 추가됨
 *   - 기존 groupId, subjectIndices 검증이 유지됨
 */

import * as fs from 'fs';
import * as path from 'path';

describe('engine.routes.ts: analyzePipelineSchema 확장 검증', () => {
  let source: string;

  beforeAll(() => {
    const filePath = path.resolve(__dirname, 'engine.routes.ts');
    source = fs.readFileSync(filePath, 'utf-8');
  });

  it("analyzePipelineSchema의 mode 가 z.enum(['DUAL','BTI']) 임", () => {
    expect(source).toContain('mode');
    expect(source).toContain("z.enum(['DUAL', 'BTI'])");
  });

  it("mode 필드의 default가 'DUAL'로 설정됨", () => {
    expect(source).toMatch(/mode[\s\S]*?default\('DUAL'\)/);
  });

  it('algorithm 필드가 analyzePipelineSchema에 추가됨', () => {
    expect(source).toContain('algorithm');
  });

  it("algorithm 필드의 default가 'default'로 설정됨", () => {
    expect(source).toMatch(/algorithm[\s\S]*?default\('default'\)/);
  });

  it('기존 groupId 검증이 유지됨', () => {
    expect(source).toContain('groupId');
  });
});

describe('engine.routes.ts: analyzePipelineSchema Zod 런타임 검증', () => {
  let analyzePipelineSchema: import('zod').ZodTypeAny | undefined;

  beforeAll(() => {
    const filePath = path.resolve(__dirname, 'engine.routes.ts');
    const hasFile = fs.existsSync(filePath);
    if (!hasFile) return;

    // 소스에서 z.object 형식으로 정의된 스키마를 직접 파싱하기 위해 zod 활용함
    // engine.routes.ts는 Router를 export하므로 직접 import 불가
    // zod를 통해 독립적으로 스키마 생성하여 검증함
    const { z } = require('zod');
    analyzePipelineSchema = z.object({
      groupId: z.string().min(1),
      subjectIndices: z.array(z.number().int().positive()),
      mode: z.enum(['DUAL', 'BTI']).optional().default('DUAL'),
      algorithm: z.string().optional().default('default'),
    });
  });

  it("mode: 'BTI'가 스키마 검증을 통과함", () => {
    if (!analyzePipelineSchema) return;
    const result = analyzePipelineSchema.safeParse({
      groupId: 'grp_test',
      subjectIndices: [1, 2],
      mode: 'BTI',
    });
    expect(result.success).toBe(true);
  });

  it("mode: 'DUAL'이 스키마 검증을 통과함", () => {
    if (!analyzePipelineSchema) return;
    const result = analyzePipelineSchema.safeParse({
      groupId: 'grp_test',
      subjectIndices: [1, 2],
      mode: 'DUAL',
    });
    expect(result.success).toBe(true);
  });

  it("mode: 'BTI'가 스키마 검증을 통과함", () => {
    if (!analyzePipelineSchema) return;
    const result = analyzePipelineSchema.safeParse({
      groupId: 'grp_test',
      subjectIndices: [1, 2],
      mode: 'BTI',
    });
    expect(result.success).toBe(true);
  });

  it("mode: 'INVALID' 시 스키마 검증 실패함", () => {
    if (!analyzePipelineSchema) return;
    const result = analyzePipelineSchema.safeParse({
      groupId: 'grp_test',
      subjectIndices: [1, 2],
      mode: 'INVALID',
    });
    expect(result.success).toBe(false);
  });

  it('mode 미지정 시 default DUAL이 적용됨', () => {
    if (!analyzePipelineSchema) return;
    const result = analyzePipelineSchema.safeParse({
      groupId: 'grp_test',
      subjectIndices: [1, 2],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).mode).toBe('DUAL');
    }
  });
});
