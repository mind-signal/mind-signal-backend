/**
 * pair-subject.service.test.ts — PairSubjectService 단위 테스트
 *
 * SessionRepository는 jest.fn() mock으로 격리함 — 진짜 DB 미연결.
 * PLAN rev.3 §7.1 시나리오 4건 (AppError 400/401/404 실측 정합).
 */

import { Types } from 'mongoose';
import { SessionAggregate, SessionRepository } from '@06-entities/sessions';
import { AppError } from '@07-shared/errors';
import { FixedClock } from '@07-shared/clock';
import { PairSubjectService } from './pair-subject.service';

const TEST_NOW = new Date('2026-05-13T10:00:00.000Z');

const makeAggregate = (
  override: Partial<Parameters<typeof SessionAggregate.create>[0]> = {}
) => {
  return SessionAggregate.create({
    id: new Types.ObjectId().toString(),
    groupId: 'A1B2C3D4',
    subjectIndex: 1,
    pairingToken: 'TOK001',
    operatorId: new Types.ObjectId().toString(),
    mode: 'DUAL_2PC',
    expiresAt: new Date(TEST_NOW.getTime() + 60_000),
    ...override,
  });
};

const makeRepoMock = () => {
  return {
    findById: jest.fn(),
    findByPairingToken: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
    saveNew: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<SessionRepository> & {
    findByPairingToken: jest.Mock;
    save: jest.Mock;
  };
};

describe('PairSubjectService', () => {
  test('1. happy path — 유효 토큰 + 유효 userId → CREATED → PAIRED + 이벤트 발행', async () => {
    const aggregate = makeAggregate();
    const userId = new Types.ObjectId().toString();
    const repo = makeRepoMock();
    repo.findByPairingToken.mockResolvedValueOnce(aggregate);

    const service = new PairSubjectService(repo, new FixedClock(TEST_NOW));
    const result = await service.execute({
      pairingToken: 'TOK001',
      userId,
    });

    expect(repo.findByPairingToken).toHaveBeenCalledWith('TOK001');
    expect(repo.save).toHaveBeenCalledTimes(1);
    expect(result.session.status).toBe('PAIRED');
    expect(result.session.userId).toBe(userId);
    expect(result.event.type).toBe('SessionPaired');
    expect(result.event.userId).toBe(userId);
    expect(result.event.groupId).toBe('A1B2C3D4');
    expect(result.event.subjectIndex).toBe(1);
    expect(result.event.mode).toBe('DUAL_2PC');

    // 메모리 기록 확인
    const events = service.drainRecordedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('SessionPaired');
  });

  test('2. 만료 토큰 → AppError 401 throw + 세션 status EXPIRED 영속', async () => {
    const expired = makeAggregate({
      expiresAt: new Date(TEST_NOW.getTime() - 1000), // TEST_NOW 기준 1초 전 만료
    });
    const userId = new Types.ObjectId().toString();
    const repo = makeRepoMock();
    repo.findByPairingToken.mockResolvedValueOnce(expired);

    const service = new PairSubjectService(repo, new FixedClock(TEST_NOW));

    let captured: AppError | null = null;
    try {
      await service.execute({ pairingToken: 'TOK001', userId });
    } catch (err) {
      captured = err as AppError;
    }

    expect(captured).toBeInstanceOf(AppError);
    expect(captured!.statusCode).toBe(401);
    // expire()로 status 변경 + repo.save 호출 검증
    expect(expired.status).toBe('EXPIRED');
    expect(repo.save).toHaveBeenCalled();
  });

  test('3. 이미 PAIRED 상태 토큰 → AppError 400 throw', async () => {
    const aggregate = makeAggregate();
    aggregate.pair(new Types.ObjectId().toString(), TEST_NOW); // 사전 페어링 완료 (plan-review I-2: Date 인자 추가)
    expect(aggregate.status).toBe('PAIRED');

    const userId = new Types.ObjectId().toString();
    const repo = makeRepoMock();
    repo.findByPairingToken.mockResolvedValueOnce(aggregate);

    const service = new PairSubjectService(repo, new FixedClock(TEST_NOW));

    let captured: AppError | null = null;
    try {
      await service.execute({ pairingToken: 'TOK001', userId });
    } catch (err) {
      captured = err as AppError;
    }

    expect(captured).toBeInstanceOf(AppError);
    expect(captured!.statusCode).toBe(400);
    // 이미 PAIRED 상태에서는 save 호출 0건 (전이 불가 시 expire/save 분기 안 탐)
    expect(repo.save).not.toHaveBeenCalled();
  });

  test('4. 존재하지 않는 토큰 → AppError 404 throw', async () => {
    const userId = new Types.ObjectId().toString();
    const repo = makeRepoMock();
    repo.findByPairingToken.mockResolvedValueOnce(null);

    const service = new PairSubjectService(repo, new FixedClock(TEST_NOW));

    let captured: AppError | null = null;
    try {
      await service.execute({ pairingToken: 'NOPE000', userId });
    } catch (err) {
      captured = err as AppError;
    }

    expect(captured).toBeInstanceOf(AppError);
    expect(captured!.statusCode).toBe(404);
    expect(repo.save).not.toHaveBeenCalled();
  });

  test('보조: userId 형식 부정합 → AppError 400 throw + repo 호출 0건', async () => {
    const repo = makeRepoMock();
    const service = new PairSubjectService(repo, new FixedClock(TEST_NOW));

    let captured: AppError | null = null;
    try {
      await service.execute({
        pairingToken: 'TOK001',
        userId: 'not-an-objectid',
      });
    } catch (err) {
      captured = err as AppError;
    }

    expect(captured).toBeInstanceOf(AppError);
    expect(captured!.statusCode).toBe(400);
    // userId 검증 실패 시 토큰 조회 0건
    expect(repo.findByPairingToken).not.toHaveBeenCalled();
  });
});
