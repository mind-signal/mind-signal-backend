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
  // 운영 스키마를 그대로 가져와 검증함. 예전에는 같은 모양을 복제해 썼는데
  // 그러면 운영 코드가 SEQUENTIAL 을 다시 허용해도 이 테스트가 통과함
  const { analyzePipelineSchema } = require('./engine.routes');

  const base = { groupId: 'grp_test', subjectIndices: [1, 2] };

  it("mode: 'DUAL' 이 스키마 검증을 통과함", () => {
    expect(
      analyzePipelineSchema.safeParse({ ...base, mode: 'DUAL' }).success
    ).toBe(true);
  });

  it("mode: 'BTI' 가 스키마 검증을 통과함", () => {
    expect(
      analyzePipelineSchema.safeParse({ ...base, mode: 'BTI' }).success
    ).toBe(true);
  });

  it("제거된 mode: 'SEQUENTIAL' 이 스키마 검증에 실패함", () => {
    // SESSION-W002 가 지운 값이 런타임에서도 거부되는지 확인함.
    // 이 PR 의 핵심 주장을 지키는 단언임
    expect(
      analyzePipelineSchema.safeParse({ ...base, mode: 'SEQUENTIAL' }).success
    ).toBe(false);
  });

  it("mode: 'INVALID' 시 스키마 검증 실패함", () => {
    expect(
      analyzePipelineSchema.safeParse({ ...base, mode: 'INVALID' }).success
    ).toBe(false);
  });

  it('mode 미지정 시 default DUAL 이 적용됨', () => {
    const result = analyzePipelineSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('DUAL');
    }
  });
});
