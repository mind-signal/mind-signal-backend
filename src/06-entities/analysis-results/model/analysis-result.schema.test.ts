/**
 * analysis-result.schema.ts — analysis_mode + similarity_features 필드 검증
 *
 * 검증 항목:
 *   - analysis_mode 필드가 스키마에 정의됨
 *   - similarity_features 필드가 Mixed 타입으로 정의됨
 *   - 기존 생성 경로(bti-analysis, post-measurement)에서 analysis_mode 미지정 시
 *     Mongoose default 'DUAL'이 적용됨 (정적 소스 검증)
 *
 * cosine_pearson_faa Zod 스키마 검증 블록은 SESSION-W002(2026-08-04)에서
 * 스키마 파일과 함께 제거함. 그 스키마는 SEQUENTIAL 전용이었음
 */

import * as fs from 'fs';
import * as path from 'path';

describe('analysis-result.schema.ts: analysis_mode 필드가 올바르게 추가됨', () => {
  let source: string;

  beforeAll(() => {
    const filePath = path.resolve(__dirname, 'analysis-result.schema.ts');
    source = fs.readFileSync(filePath, 'utf-8');
  });

  it('AnalysisResult 인터페이스에 analysis_mode 필드가 존재함', () => {
    expect(source).toContain('analysis_mode');
  });

  it("인터페이스 analysis_mode에 'DUAL' | 'SEQUENTIAL' | 'BTI' 유니온이 포함됨", () => {
    expect(source).toContain('DUAL');
    expect(source).toContain('SEQUENTIAL');
    expect(source).toContain('BTI');
  });

  it('Mongoose 스키마에 analysis_mode 필드 정의가 존재함', () => {
    expect(source).toContain('analysis_mode:');
  });

  it("스키마 analysis_mode enum에 'DUAL', 'SEQUENTIAL', 'BTI'가 포함됨", () => {
    expect(source).toContain("'DUAL'");
    expect(source).toContain("'SEQUENTIAL'");
    expect(source).toContain("'BTI'");
  });

  it("스키마 analysis_mode default가 'DUAL'로 설정됨", () => {
    expect(source).toMatch(/default:\s*['"]DUAL['"]/);
  });

  it('인터페이스에 similarity_features 필드가 존재함', () => {
    expect(source).toContain('similarity_features');
  });

  it('스키마에 similarity_features가 Schema.Types.Mixed로 정의됨', () => {
    expect(source).toContain('Schema.Types.Mixed');
  });

  it('기존 AnalysisResult.create 호출 시 analysis_mode 미지정이 허용됨 (optional 또는 default)', () => {
    // analysis_mode는 인터페이스에서 optional(?)이거나 Mongoose default로 채워짐
    // 인터페이스 필드에 '?'(optional) 또는 default 선언 확인함
    const hasOptionalInInterface = source.match(/analysis_mode\s*\?:/);
    const hasDefaultInSchema = source.match(
      /analysis_mode:[\s\S]*?default:\s*['"]DUAL['"]/
    );
    expect(hasOptionalInInterface || hasDefaultInSchema).toBeTruthy();
  });
});
