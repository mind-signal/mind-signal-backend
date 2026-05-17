/* eslint-disable camelcase */
/**
 * session.schema.ts — experimentMode 필드 추가 검증
 *
 * 검증 항목:
 *   - Session 인터페이스에 experimentMode 필드가 추가됨
 *   - Mongoose 스키마에 experimentMode 필드 정의 존재함
 *   - enum 값으로 DUAL, SEQUENTIAL, BTI가 정의됨
 *   - default 값이 'DUAL'로 설정됨
 *   - required: true가 설정됨
 */

import * as fs from 'fs';
import * as path from 'path';
import { Session } from './session.schema';

describe('session.schema.ts: experimentMode 필드가 올바르게 추가됨', () => {
  let source: string;

  beforeAll(() => {
    const filePath = path.resolve(__dirname, 'session.schema.ts');
    source = fs.readFileSync(filePath, 'utf-8');
  });

  it('Session 인터페이스에 experimentMode 필드가 존재함', () => {
    expect(source).toContain('experimentMode');
  });

  it('Session 인터페이스에 DUAL | SEQUENTIAL | BTI 유니온 타입이 포함됨', () => {
    expect(source).toContain('SEQUENTIAL');
    expect(source).toContain('DUAL');
    expect(source).toContain('BTI');
  });

  it('Mongoose 스키마에 experimentMode 필드 정의가 존재함', () => {
    // 스키마 객체 내에 experimentMode 키 존재함
    expect(source).toContain('experimentMode:');
  });

  it("스키마 enum에 'SEQUENTIAL'이 포함됨", () => {
    expect(source).toContain("'SEQUENTIAL'");
  });

  it("스키마 enum에 'DUAL'이 포함됨", () => {
    // 'DUAL' 리터럴이 schema enum 배열에 존재함
    expect(source).toContain("'DUAL'");
  });

  it("스키마 enum에 'BTI'이 포함됨", () => {
    expect(source).toContain("'BTI'");
  });

  it("스키마 default가 'DUAL'로 설정됨", () => {
    // experimentMode 필드 default 값 확인함
    // "default: 'DUAL'" 또는 `default: "DUAL"` 형식으로 존재해야 함
    expect(source).toMatch(/default:\s*['"]DUAL['"]/);
  });

  it('스키마 required가 true로 설정됨', () => {
    expect(source).toContain('required: true');
  });
});

// ============================================================
// single_host_mode 옵션 동작 회귀 테스트
// — 컴파일된 Mongoose 스키마 객체 실제 행위 검증함
// — DB 연결 없이 인메모리 validateSync() 사용함
// ============================================================

describe('session.schema.ts — single_host_mode 옵션 필드 동작 회귀 (R2-5 / R7)', () => {
  // 최소 필수 필드 세트 — single_host_mode 제외한 기본 도큐먼트 생성용 상수임
  const BASE_DOC = {
    groupId: 'grp-shm-test',
    pairingToken: 'TOK-SHM-001',
    expiresAt: new Date(Date.now() + 60_000),
    experimentMode: 'DUAL',
  } as const;

  describe('스키마 경로 인트로스펙션 — 컴파일된 스키마 객체 검사함', () => {
    it('single_host_mode 경로가 스키마에 정의됨', () => {
      // Session.schema.path()가 undefined 반환 시 → 필드 제거 변이 회귀 감지함
      const pathDef = Session.schema.path('single_host_mode');
      expect(pathDef).toBeDefined();
    });

    it('single_host_mode 타입이 Boolean 인스턴스임', () => {
      // instance !== 'Boolean' 시 → 타입 변경 변이 회귀 감지함
      const pathDef = Session.schema.path('single_host_mode');
      expect(pathDef.instance).toBe('Boolean');
    });

    it('single_host_mode는 required가 아님 — 옵션 필드 계약 보존함', () => {
      // isRequired truthy 시 → required: true 추가 변이 회귀 감지함 (R7 하위 호환)
      const pathDef = Session.schema.path('single_host_mode');
      expect(pathDef.isRequired).toBeFalsy();
    });

    it('single_host_mode에 default 없음 — 미설정 시 undefined 유지함', () => {
      // defaultValue 존재 시 → default 추가 변이 회귀 감지함
      const pathDef = Session.schema.path('single_host_mode') as any; // Mongoose SchemaType.defaultValue 공개 타입 미포함 — as any 불가피함
      expect(pathDef.defaultValue).toBeUndefined();
    });
  });

  describe('validateSync 행위 검증 — DB 없이 인메모리 동작 확인함', () => {
    it('single_host_mode 미설정 시 doc.single_host_mode가 undefined임', () => {
      // Arrange: single_host_mode 없이 도큐먼트 생성함
      const doc = new Session(BASE_DOC);

      // Assert: 필드 미설정 → undefined 보존함 (default 추가 변이 감지)
      expect(doc.single_host_mode).toBeUndefined();
    });

    it('single_host_mode 미설정 시 validateSync()에 single_host_mode 에러 없음', () => {
      // Arrange: single_host_mode 없이 도큐먼트 생성함
      const doc = new Session(BASE_DOC);

      // Act: 동기 유효성 검사 실행함
      const err = doc.validateSync();

      // Assert: single_host_mode 경로에 에러 없음 — optional 계약 유지함
      // (required: true 추가 변이 시 이 단언이 실패함)
      expect(err?.errors?.['single_host_mode']).toBeUndefined();
    });

    it('single_host_mode: true 설정 시 doc.single_host_mode === true 보존됨', () => {
      // Arrange: single_host_mode: true 포함한 도큐먼트 생성함
      const doc = new Session({
        ...BASE_DOC,
        single_host_mode: true,
      });

      // Assert: Boolean 값 보존 확인함 (타입 강제 변환 / 드롭 변이 감지)
      expect(doc.single_host_mode).toBe(true);
    });

    it('single_host_mode: false 설정 시 doc.single_host_mode === false 보존됨', () => {
      // Arrange: single_host_mode: false 포함한 도큐먼트 생성함
      const doc = new Session({
        ...BASE_DOC,
        single_host_mode: false,
      });

      // Assert: false 값도 정상 보존됨 (Boolean 타입 정합)
      expect(doc.single_host_mode).toBe(false);
    });
  });
});
