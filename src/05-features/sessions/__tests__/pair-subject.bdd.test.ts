/**
 * pair-subject.bdd.test.ts — Phase G BDD 형식 인수 테스트
 *
 * Q1 LOCK — Jest 단독 + 서비스 직접 호출 (supertest / HTTP 라우트 / Express app import 0건).
 * Cucumber.js는 별도 spike 가지에서만 검증. 본 단계 정식 도구 = Jest.
 *
 * 비개발자(연구원·교수)가 시나리오 텍스트를 읽고 "그래, 그게 맞아"라고 판단할 수 있도록 작성함.
 * 5/26 교수 면담 시연용 — 한국어 자연어 시나리오 3건을 직접 낭독.
 *
 * 시나리오 3건 (PLAN rev.3 §7.2 + AppError 코드 실측 정합):
 *   1. 첫 페어링 성공 — CREATED → PAIRED + SessionPairedEvent 발행
 *   2. 만료된 토큰 — AppError 401 throw
 *   3. 이미 사용된 토큰 (status PAIRED) — AppError 400 throw
 */

import { Types } from 'mongoose';
import { SessionAggregate, SessionRepository } from '@06-entities/sessions';
import { AppError } from '@07-shared/errors';
import { FixedClock } from '@07-shared/clock';
import { PairSubjectService } from '../services/pair-subject.service';

/** BDD 시나리오 결정성용 고정 시각 — ADR-007 정합 */
const TEST_NOW = new Date('2026-05-13T10:00:00.000Z');

/**
 * 테스트 환경 헬퍼 — SessionRepository를 in-memory Map으로 모킹함.
 * 진짜 MongoDB 미연결 (CI 환경 + 본 프로젝트 통합 테스트 패턴 정합).
 */
const makeInMemoryRepo = () => {
  const store = new Map<string, SessionAggregate>();
  const tokenIndex = new Map<string, string>(); // pairingToken → id

  const repo: jest.Mocked<SessionRepository> = {
    findById: jest.fn(async (id: string) => store.get(id) ?? null),
    findByPairingToken: jest.fn(async (token: string) => {
      const id = tokenIndex.get(token);
      return id ? (store.get(id) ?? null) : null;
    }),
    save: jest.fn(async (aggregate: SessionAggregate) => {
      store.set(aggregate.id, aggregate);
    }),
    saveNew: jest.fn(async (aggregate: SessionAggregate) => {
      store.set(aggregate.id, aggregate);
      tokenIndex.set(aggregate.pairingToken, aggregate.id);
    }),
  } as unknown as jest.Mocked<SessionRepository>;

  return repo;
};

describe('Feature: 피실험자가 QR을 스캔해 세션에 합류함', () => {
  describe('[TS-SESSION-03] Scenario: 첫 페어링이 성공함', () => {
    test(
      'Given operator alice가 세션을 생성했고, ' +
        'When subject bob (userId)이 pairingToken으로 합류 요청을 보내면, ' +
        'Then 세션 상태가 CREATED 에서 PAIRED 로 전이하고 ' +
        'SessionPairedEvent (userId/groupId/subjectIndex/mode 포함)가 발행됨',
      async () => {
        // Given — operator alice가 세션을 생성함
        const repo = makeInMemoryRepo();
        const operatorId = new Types.ObjectId().toString();
        const session = SessionAggregate.create({
          id: new Types.ObjectId().toString(),
          groupId: 'A1B2C3D4',
          subjectIndex: 1,
          pairingToken: 'TOK001',
          operatorId,
          mode: 'DUAL_2PC',
          expiresAt: new Date(TEST_NOW.getTime() + 60_000),
        });
        await repo.saveNew(session);

        // When — subject bob (userId)이 pairingToken 'TOK001'로 합류 요청을 보냄
        const userId = new Types.ObjectId().toString();
        const service = new PairSubjectService(repo, new FixedClock(TEST_NOW));
        const result = await service.execute({
          pairingToken: 'TOK001',
          userId,
        });

        // Then — 세션 상태가 PAIRED로 전이됨 + SessionPairedEvent 발행 검증
        const reloaded = await repo.findById(session.id);
        expect(reloaded).not.toBeNull();
        expect(reloaded!.status).toBe('PAIRED');
        expect(reloaded!.userId).toBe(userId);
        expect(reloaded!.pairedAt).not.toBeNull();

        // 이벤트 모양 검증 — userId / groupId / subjectIndex / mode 모두 포함됨
        expect(result.event.type).toBe('SessionPaired');
        expect(result.event.sessionId).toBe(session.id);
        expect(result.event.userId).toBe(userId);
        expect(result.event.groupId).toBe('A1B2C3D4');
        expect(result.event.subjectIndex).toBe(1);
        expect(result.event.mode).toBe('DUAL_2PC');
        expect(typeof result.event.occurredAt).toBe('string');

        // drainRecordedEvents observable (tdd-spec §2.1 #6 정합 — codex review R2-1)
        const firstDrain = service.drainRecordedEvents();
        expect(firstDrain).toHaveLength(1);
        expect(firstDrain[0].type).toBe('SessionPaired');
        expect(firstDrain[0].userId).toBe(userId);
        // 두 번째 drain은 빈 배열 (buffer 비움 동작 검증)
        expect(service.drainRecordedEvents()).toHaveLength(0);
      }
    );
  });

  describe('[TS-SESSION-02] Scenario: 만료된 토큰으로 페어링 시 실패함', () => {
    test(
      'Given 만료된 pairingToken을 가진 세션이 존재하고, ' +
        'When subject가 그 토큰으로 합류 시도하면, ' +
        'Then AppError 401 throw + 세션 status가 EXPIRED로 영속됨',
      async () => {
        // Given — 만료된 세션 (expiresAt < 현재 시각)
        const repo = makeInMemoryRepo();
        const operatorId = new Types.ObjectId().toString();
        const expiredSession = SessionAggregate.create({
          id: new Types.ObjectId().toString(),
          groupId: 'EXPIRED1',
          subjectIndex: 1,
          pairingToken: 'EXP001',
          operatorId,
          mode: 'DUAL_2PC',
          expiresAt: new Date(TEST_NOW.getTime() - 1000), // TEST_NOW 기준 1초 전 만료
        });
        await repo.saveNew(expiredSession);

        // When — subject가 만료된 토큰으로 합류 시도함
        const userId = new Types.ObjectId().toString();
        const service = new PairSubjectService(repo, new FixedClock(TEST_NOW));

        // Then — AppError 401 throw
        let captured: AppError | null = null;
        try {
          await service.execute({ pairingToken: 'EXP001', userId });
        } catch (err) {
          captured = err as AppError;
        }
        expect(captured).toBeInstanceOf(AppError);
        expect(captured!.statusCode).toBe(401);

        // 세션 status가 EXPIRED로 영속됨
        const reloaded = await repo.findById(expiredSession.id);
        expect(reloaded!.status).toBe('EXPIRED');

        // 만료 흐름은 event 발화 0건 (tdd-spec §2.2 #3 — codex review R2-1)
        expect(service.drainRecordedEvents()).toHaveLength(0);
      }
    );
  });

  describe('[TS-SESSION-04] Scenario: 이미 사용된 토큰으로 페어링 시 실패함', () => {
    test(
      'Given 이미 PAIRED 상태인 세션이 존재하고, ' +
        'When 다른 subject가 같은 토큰으로 합류 시도하면, ' +
        'Then AppError 400 throw + 기존 페어링 정보 보존됨',
      async () => {
        // Given — 이미 PAIRED 상태 세션
        const repo = makeInMemoryRepo();
        const operatorId = new Types.ObjectId().toString();
        const firstUserId = new Types.ObjectId().toString();
        const session = SessionAggregate.create({
          id: new Types.ObjectId().toString(),
          groupId: 'PAIRED01',
          subjectIndex: 1,
          pairingToken: 'PRD001',
          operatorId,
          mode: 'DUAL_2PC',
          expiresAt: new Date(TEST_NOW.getTime() + 60_000),
        });
        await repo.saveNew(session);

        // 첫 번째 페어링 성공
        const service = new PairSubjectService(repo, new FixedClock(TEST_NOW));
        await service.execute({
          pairingToken: 'PRD001',
          userId: firstUserId,
        });
        const afterFirst = await repo.findById(session.id);
        expect(afterFirst!.status).toBe('PAIRED');
        expect(afterFirst!.userId).toBe(firstUserId);
        const firstPairedAt = afterFirst!.pairedAt;
        expect(firstPairedAt).not.toBeNull();

        // 첫 페어링 event는 buffer drain 후 retry 시 새 event 발화 0건 검증 준비
        const firstDrain = service.drainRecordedEvents();
        expect(firstDrain).toHaveLength(1);
        expect(firstDrain[0].userId).toBe(firstUserId);

        // When — 두 번째 subject가 같은 토큰으로 합류 시도함
        const secondUserId = new Types.ObjectId().toString();
        let captured: AppError | null = null;
        try {
          await service.execute({
            pairingToken: 'PRD001',
            userId: secondUserId,
          });
        } catch (err) {
          captured = err as AppError;
        }

        // Then — AppError 400 throw + 기존 페어링 정보 보존됨
        expect(captured).toBeInstanceOf(AppError);
        expect(captured!.statusCode).toBe(400);

        const afterSecond = await repo.findById(session.id);
        expect(afterSecond!.status).toBe('PAIRED');
        expect(afterSecond!.userId).toBe(firstUserId); // 첫 페어링 그대로 유지됨
        // pairedAt unchanged (tdd-spec §2.3 #2 — codex review R2-1)
        expect(afterSecond!.pairedAt!.getTime()).toBe(firstPairedAt!.getTime());
        // retry 흐름은 새 event 발화 0건 (tdd-spec §2.3 #3)
        expect(service.drainRecordedEvents()).toHaveLength(0);
      }
    );
  });
});

/**
 * 시나리오 4·5 (Scenario 4: Clock seam race A-7 / Scenario 5: Single observed now)
 *
 * Phase H deep-module-poc PAAR Step 5 tdd-spec §2.4 + §2.5 정합.
 * ADR-007 Clock port 도입 후 race 차단 + 결정성 입증 — `red→green evidence`.
 * 본 시나리오 4 Context C는 race trigger 시점에서도 AppError 400 wrapping + 영속 PAIRED 불변
 * 임을 입증하여 InvalidStatusTransitionError 외부 raw 노출이 차단됨을 확정함.
 */

/** 매번 fresh aggregate + repo 시드 헬퍼 (plan-review I-4 — Scenario 5 state 오염 차단) */
const makeStubRepoWithCreatedSession = async (params: {
  pairingToken: string;
  expiresAt: Date;
}) => {
  const repo = makeInMemoryRepo();
  const aggregate = SessionAggregate.create({
    id: new Types.ObjectId().toString(),
    groupId: new Types.ObjectId().toString(),
    subjectIndex: 1,
    pairingToken: params.pairingToken,
    operatorId: new Types.ObjectId().toString(),
    mode: 'DUAL_2PC',
    expiresAt: params.expiresAt,
  });
  await repo.saveNew(aggregate);
  return { repo, aggregate };
};

describe('Feature: Clock seam race 차단 (A-7) + single observed now (ADR-007)', () => {
  describe('[TS-SESSION-07][TS-SESSION-08] Scenario 4 — Clock seam race (Context A/B/C)', () => {
    test('Context A: FixedClock T-1ms + status=CREATED → paired (결정적)', async () => {
      const T = new Date('2026-05-13T11:00:00.000Z');
      const { repo, aggregate } = await makeStubRepoWithCreatedSession({
        pairingToken: 'TOK-BND-A',
        expiresAt: T,
      });
      const clock = new FixedClock(new Date(T.getTime() - 1));

      const service = new PairSubjectService(repo, clock);
      const userId = new Types.ObjectId().toString();
      const result = await service.execute({
        pairingToken: 'TOK-BND-A',
        userId,
      });

      expect(result.session.status).toBe('PAIRED');
      const reloaded = await repo.findById(aggregate.id);
      expect(reloaded!.status).toBe('PAIRED');
      expect(reloaded!.userId).toBe(userId);
    });

    test('Context B: FixedClock T+1ms + status=CREATED → AppError 401 + 영속 EXPIRED', async () => {
      const T = new Date('2026-05-13T11:00:00.000Z');
      const { repo, aggregate } = await makeStubRepoWithCreatedSession({
        pairingToken: 'TOK-BND-B',
        expiresAt: T,
      });
      const clock = new FixedClock(new Date(T.getTime() + 1));

      const service = new PairSubjectService(repo, clock);

      let captured: AppError | null = null;
      try {
        await service.execute({
          pairingToken: 'TOK-BND-B',
          userId: new Types.ObjectId().toString(),
        });
      } catch (err) {
        captured = err as AppError;
      }

      expect(captured).toBeInstanceOf(AppError);
      expect(captured!.statusCode).toBe(401);
      const reloaded = await repo.findById(aggregate.id);
      expect(reloaded!.status).toBe('EXPIRED');
    });

    test(
      'Context C (A-7 race trigger): status=PAIRED + FixedClock T-1ms + expiresAt=T → ' +
        'AppError 400 + 영속 PAIRED 불변 + InvalidStatusTransitionError 외부 노출 0건',
      async () => {
        const T = new Date('2026-05-13T11:00:00.000Z');
        const { repo, aggregate } = await makeStubRepoWithCreatedSession({
          pairingToken: 'TOK-BND-C',
          expiresAt: T,
        });

        // 사전 페어링 — PAIRED 상태로 전이 (이전 user 박제)
        const previousUserId = new Types.ObjectId().toString();
        aggregate.pair(previousUserId, new Date(T.getTime() - 1000));
        await repo.save(aggregate);
        expect(aggregate.status).toBe('PAIRED');

        // Approach A 미적용 상태에선 race trigger 시점 (T-1ms boundary).
        // Approach A 적용 후 같은 now가 pair() 내부 isExpired와 catch 분기 isExpired에 전달되어
        // race 차단 + AppError 400 wrapping 유지함.
        const clock = new FixedClock(new Date(T.getTime() - 1));
        const service = new PairSubjectService(repo, clock);

        let captured: AppError | null = null;
        try {
          await service.execute({
            pairingToken: 'TOK-BND-C',
            userId: new Types.ObjectId().toString(),
          });
        } catch (err) {
          captured = err as AppError;
        }

        expect(captured).toBeInstanceOf(AppError);
        expect(captured!.statusCode).toBe(400);
        expect(captured!.message).toContain('현재 세션 상태(PAIRED)에서는');

        const reloaded = await repo.findById(aggregate.id);
        expect(reloaded!.status).toBe('PAIRED'); // 영속 불변
        expect(reloaded!.userId).toBe(previousUserId); // 덮어쓰기 0
      }
    );
  });

  describe('Scenario 5 — Single observed now', () => {
    test('wall clock 진행과 무관하게 FixedClock 결과 결정적 (N=5 반복, 매번 fresh seed)', async () => {
      const T0 = new Date('2026-05-13T12:00:00.000Z');
      const clock = new FixedClock(T0);

      // plan-review I-4 정합 — 매번 fresh repo + fresh aggregate (state 오염 차단)
      for (let i = 0; i < 5; i++) {
        const token = `TOK-SON-${i}`;
        const { repo } = await makeStubRepoWithCreatedSession({
          pairingToken: token,
          expiresAt: new Date(T0.getTime() + 1), // boundary 직전
        });
        const service = new PairSubjectService(repo, clock);
        const result = await service.execute({
          pairingToken: token,
          userId: new Types.ObjectId().toString(),
        });
        expect(result.session.status).toBe('PAIRED'); // 5회 모두 동일
      }
    });

    test('boundary 직후 FixedClock 주입 시 결정적 expired (boundary 반대 케이스)', async () => {
      const T0 = new Date('2026-05-13T12:00:00.000Z');
      const expiresAt = T0;
      const clock = new FixedClock(new Date(T0.getTime() + 1)); // boundary 직후

      const { repo, aggregate } = await makeStubRepoWithCreatedSession({
        pairingToken: 'TOK-SON-AFTER',
        expiresAt,
      });
      const service = new PairSubjectService(repo, clock);

      let captured: AppError | null = null;
      try {
        await service.execute({
          pairingToken: 'TOK-SON-AFTER',
          userId: new Types.ObjectId().toString(),
        });
      } catch (err) {
        captured = err as AppError;
      }

      expect(captured).toBeInstanceOf(AppError);
      expect(captured!.statusCode).toBe(401);
      const reloaded = await repo.findById(aggregate.id);
      expect(reloaded!.status).toBe('EXPIRED');
    });
  });
});
