/**
 * session.aggregate.test.ts — SessionAggregate 단위 테스트
 *
 * Mongoose / Redis / mongodb-memory-server 의존 0건 — 순수 도메인 단위 테스트.
 * DOMAIN-MODEL-NOTES §3.1 정합 / PLAN rev.3 §6.2 시나리오 8건.
 */

import {
  SessionAggregate,
  type SessionAggregateDocumentFields,
} from './session.aggregate';
import {
  InvariantViolationError,
  InvalidStatusTransitionError,
} from './errors';

/** ADR-007 정합 — wall clock 의존 제거, 결정성 보장 */
const TEST_NOW = new Date('2026-05-13T10:00:00.000Z');

describe('SessionAggregate', () => {
  const baseParams = (
    override: Partial<Parameters<typeof SessionAggregate.create>[0]> = {}
  ) => ({
    id: 'session-id-1',
    groupId: 'A1B2C3D4',
    subjectIndex: 1,
    pairingToken: 'TOK001',
    operatorId: 'operator-1',
    mode: 'DUAL_2PC' as const,
    expiresAt: new Date(TEST_NOW.getTime() + 60_000), // TEST_NOW 기준 1분 뒤 만료
    ...override,
  });

  describe('create()', () => {
    test('1. happy path — DUAL_2PC 모드 + 유효 인자 → 상태 CREATED', () => {
      const aggregate = SessionAggregate.create(baseParams());
      expect(aggregate.status).toBe('CREATED');
      expect(aggregate.id).toBe('session-id-1');
      expect(aggregate.groupId).toBe('A1B2C3D4');
      expect(aggregate.subjectIndex).toBe(1);
      expect(aggregate.pairingToken).toBe('TOK001');
      expect(aggregate.operatorId).toBe('operator-1');
      expect(aggregate.mode).toBe('DUAL_2PC');
      expect(aggregate.userId).toBeNull();
      expect(aggregate.pairedAt).toBeNull();
    });

    test('2. invariant 위반 — empty pairingToken → InvariantViolationError', () => {
      expect(() =>
        SessionAggregate.create(baseParams({ pairingToken: '' }))
      ).toThrow(InvariantViolationError);
    });

    test('3. invariant 위반 — subjectIndex < 1 → InvariantViolationError', () => {
      expect(() =>
        SessionAggregate.create(baseParams({ subjectIndex: 0 }))
      ).toThrow(InvariantViolationError);
      expect(() =>
        SessionAggregate.create(baseParams({ subjectIndex: -1 }))
      ).toThrow(InvariantViolationError);
    });
  });

  describe('pair()', () => {
    test('4. happy path — CREATED + 미만료 → PAIRED + userId 바인딩 + pairedAt = now (참조 동등성)', () => {
      const aggregate = SessionAggregate.create(baseParams());
      const userId = 'user-bob';
      const now = TEST_NOW;
      aggregate.pair(userId, now);

      expect(aggregate.status).toBe('PAIRED');
      expect(aggregate.userId).toBe(userId);
      // ADR-007 정합 — _pairedAt이 주입된 now와 동일 객체 (참조 동등성)
      expect(aggregate.pairedAt).toBe(now);
    });

    test('5. 실패 — isExpired(now) === true → InvalidStatusTransitionError', () => {
      const expiresAt = new Date('2026-05-13T10:00:00.000Z');
      const now = new Date(expiresAt.getTime() + 1000); // 1초 후 (만료됨)
      const aggregate = SessionAggregate.create(baseParams({ expiresAt }));
      expect(() => aggregate.pair('user-bob', now)).toThrow(
        InvalidStatusTransitionError
      );
      // 상태는 그대로 CREATED (만료 처리는 별도 expire() 호출 책임)
      expect(aggregate.status).toBe('CREATED');
    });

    test('6. 실패 — status === PAIRED에서 재호출 → InvalidStatusTransitionError', () => {
      const aggregate = SessionAggregate.create(baseParams());
      const now = TEST_NOW;
      aggregate.pair('user-bob', now);
      expect(() => aggregate.pair('user-charlie', now)).toThrow(
        InvalidStatusTransitionError
      );
      // userId는 첫 페어링 그대로 유지됨
      expect(aggregate.userId).toBe('user-bob');
    });
  });

  describe('[TS-SESSION-12] markMeasuring() & cancel()', () => {
    test('7. markMeasuring() 실패 — CREATED에서 호출 → InvalidStatusTransitionError', () => {
      const aggregate = SessionAggregate.create(baseParams());
      expect(() => aggregate.markMeasuring()).toThrow(
        InvalidStatusTransitionError
      );
      expect(aggregate.status).toBe('CREATED');
    });

    test('8. cancel() happy — PAIRED에서 CANCELLED 전이', () => {
      const aggregate = SessionAggregate.create(baseParams());
      const now = TEST_NOW;
      aggregate.pair('user-bob', now);
      aggregate.cancel('ManualEarly');
      expect(aggregate.status).toBe('CANCELLED');
    });

    test('9. isExpired(now) — boundary 비교 (ADR-007 정합)', () => {
      const expiresAt = new Date('2026-05-13T10:00:00.000Z');
      const aggregate = SessionAggregate.create(baseParams({ expiresAt }));

      // boundary 직전 — 미만료
      const beforeBoundary = new Date(expiresAt.getTime() - 1);
      expect(aggregate.isExpired(beforeBoundary)).toBe(false);

      // boundary 정확 — expiresAt === now 시점은 미만료 (strict less than)
      expect(aggregate.isExpired(expiresAt)).toBe(false);

      // boundary 직후 — 만료
      const afterBoundary = new Date(expiresAt.getTime() + 1);
      expect(aggregate.isExpired(afterBoundary)).toBe(true);
    });
  });
});

describe('SessionAggregate.fromDocument invariant', () => {
  // SessionAggregateDocumentFields.subjectIndex 는 T1 후 number | null
  const baseDoc: SessionAggregateDocumentFields = {
    _id: 'sess-001',
    groupId: 'grp-001',
    subjectIndex: 1,
    pairingToken: 'ABC123',
    creatorId: null,
    experimentMode: 'DUAL_2PC',
    expiresAt: new Date(Date.now() + 60_000),
    status: 'CREATED',
    userId: null,
    pairedAt: null,
  };

  it('throws InvariantViolationError on empty pairingToken', () => {
    expect(() =>
      SessionAggregate.fromDocument({ ...baseDoc, pairingToken: '' })
    ).toThrow(InvariantViolationError);
  });

  it('throws InvariantViolationError on null subjectIndex', () => {
    expect(() =>
      SessionAggregate.fromDocument({ ...baseDoc, subjectIndex: null })
    ).toThrow(/subjectIndex must be >= 1, got null/);
  });

  it('throws InvariantViolationError on subjectIndex < 1', () => {
    expect(() =>
      SessionAggregate.fromDocument({ ...baseDoc, subjectIndex: 0 })
    ).toThrow(/subjectIndex must be >= 1, got 0/);
  });
});
