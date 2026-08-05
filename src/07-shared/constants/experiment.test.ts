/**
 * experiment.ts — EXPERIMENT_MODES 상수 및 ExperimentMode 타입 검증
 *
 * 검증 항목:
 *   - SEQUENTIAL 모드가 상수에 정의됨
 *   - DUAL, BTI 모드가 기존과 동일하게 유지됨
 *   - ExperimentMode 타입이 'SEQUENTIAL' 리터럴을 수용함
 */

import * as fs from 'fs';
import * as path from 'path';

describe('experiment.ts: EXPERIMENT_MODES 상수가 올바르게 정의됨', () => {
  let source: string;

  beforeAll(() => {
    const filePath = path.resolve(__dirname, 'experiment.ts');
    source = fs.readFileSync(filePath, 'utf-8');
  });

  it('EXPERIMENT_MODES에 BTI 모드가 정의됨', () => {
    expect(source).toContain("BTI: 'BTI'");
  });

  it('DUAL 과 SEQUENTIAL 이 제거됨 (SESSION-W002)', () => {
    expect(source).not.toContain("DUAL: 'DUAL'");
    expect(source).not.toContain("SEQUENTIAL: 'SEQUENTIAL'");
  });

  it('ExperimentMode 타입이 keyof typeof 방식으로 자동 파생됨', () => {
    // (typeof X)[keyof typeof X] 또는 typeof X[keyof typeof X] 두 형식 모두 허용함
    const hasParenForm = source.includes(
      '(typeof EXPERIMENT_MODES)[keyof typeof EXPERIMENT_MODES]'
    );
    const hasNonParenForm = source.includes(
      'typeof EXPERIMENT_MODES[keyof typeof EXPERIMENT_MODES]'
    );
    expect(hasParenForm || hasNonParenForm).toBe(true);
  });

  it('EXPERIMENT_MODES 객체가 as const로 선언됨', () => {
    expect(source).toContain('as const');
  });
});

describe('experiment.ts: EXPERIMENT_MODES 런타임 값 검증', () => {
  let EXPERIMENT_MODES: Record<string, string>;

  beforeAll(() => {
    // 파일이 생성된 후에만 require 실행함
    const filePath = path.resolve(__dirname, 'experiment.ts');
    const exists = fs.existsSync(filePath);
    if (exists) {
      // ts-jest 환경에서 직접 require 가능함
      EXPERIMENT_MODES = require('./experiment').EXPERIMENT_MODES;
    }
  });

  it('DUAL 과 SEQUENTIAL 키가 런타임에 없음 (SESSION-W002)', () => {
    expect('DUAL' in EXPERIMENT_MODES).toBe(false);
    expect('SEQUENTIAL' in EXPERIMENT_MODES).toBe(false);
  });

  it('EXPERIMENT_MODES.BTI 값이 문자열 BTI임', () => {
    expect(EXPERIMENT_MODES['BTI']).toBe('BTI');
  });
});
