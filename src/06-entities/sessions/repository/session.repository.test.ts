/**
 * session.repository.test.ts — SessionRepository 통합 테스트
 *
 * Mongoose Model의 정적 메서드(findById / findOne / findByIdAndUpdate / create)를 Jest mock으로 격리함.
 * 기존 mind-signal-backend 통합 테스트 패턴 정합 (CI는 외부 MongoDB 미연결 — mock 의무, .claude/rules/test-modification.md).
 *
 * 진짜 MongoDB 통합 검증은 후속 인프라 정비 후 별도 PR (mongodb-memory-server 도입 시).
 * PLAN rev.3 §6.3 "mongodb-memory-server" 명시는 본 프로젝트 실제 패턴과 불일치로 mock 기반 통합 테스트로 채택함.
 *
 * 시나리오 3건:
 *   1. saveNew → findById 왕복 (같은 상태 복원)
 *   2. saveNew → findByPairingToken 왕복 (토큰 인덱스 정합)
 *   3. save 상태 전이 영속 (CREATED → PAIRED)
 */

import { Types } from 'mongoose';
import { Session } from '../model/session.schema';
import { SessionAggregate } from '../domain/session.aggregate';
import { SessionRepository } from './session.repository';
import { InvariantViolationError } from '../domain/errors';

jest.mock('../model/session.schema', () => ({
  Session: {
    findById: jest.fn(),
    findOne: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    create: jest.fn(),
  },
}));

type AnyMock = jest.Mock;
const SessionMock = Session as unknown as {
  findById: AnyMock;
  findOne: AnyMock;
  findByIdAndUpdate: AnyMock;
  create: AnyMock;
};

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
    expiresAt: new Date(Date.now() + 60_000),
    ...override,
  });
};

/**
 * Mongoose SessionDoc-like 객체 생성기 — Repository.toAggregate가 읽는 필드만 포함함.
 * 실제 Mongoose Hydration 결과를 mock 형태로 모사함.
 */
const makeDocLike = (
  aggregate: SessionAggregate,
  statusOverride?: SessionAggregate['status']
) => ({
  _id: aggregate.id,
  groupId: aggregate.groupId,
  subjectIndex: aggregate.subjectIndex,
  pairingToken: aggregate.pairingToken,
  creatorId: aggregate.operatorId,
  userId: aggregate.userId,
  experimentMode: aggregate.mode,
  expiresAt: aggregate.expiresAt,
  status: statusOverride ?? aggregate.status,
  pairedAt: aggregate.pairedAt,
});

describe('SessionRepository (통합 — Mongoose Model mock)', () => {
  let repo: SessionRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new SessionRepository();
  });

  test('1. saveNew → findById 왕복 (같은 상태 복원)', async () => {
    const original = makeAggregate();
    const docLike = makeDocLike(original);

    SessionMock.create.mockResolvedValueOnce(docLike);
    SessionMock.findById.mockResolvedValueOnce(docLike);

    await repo.saveNew(original);
    const restored = await repo.findById(original.id);

    expect(SessionMock.create).toHaveBeenCalledTimes(1);
    expect(SessionMock.findById).toHaveBeenCalledWith(original.id);
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe(original.id);
    expect(restored!.groupId).toBe('A1B2C3D4');
    expect(restored!.subjectIndex).toBe(1);
    expect(restored!.pairingToken).toBe('TOK001');
    expect(restored!.mode).toBe('DUAL_2PC');
    expect(restored!.status).toBe('CREATED');
  });

  test('2. saveNew → findByPairingToken 왕복 (토큰 인덱스 정합)', async () => {
    const original = makeAggregate({ pairingToken: 'TOK999' });
    const docLike = makeDocLike(original);

    SessionMock.create.mockResolvedValueOnce(docLike);
    SessionMock.findOne.mockResolvedValueOnce(docLike);

    await repo.saveNew(original);
    const restored = await repo.findByPairingToken('TOK999');

    expect(SessionMock.findOne).toHaveBeenCalledWith({
      pairingToken: 'TOK999',
    });
    expect(restored).not.toBeNull();
    expect(restored!.pairingToken).toBe('TOK999');
    expect(restored!.id).toBe(original.id);
  });

  test('3. save 상태 전이 영속 (CREATED → PAIRED)', async () => {
    const aggregate = makeAggregate();
    const userId = new Types.ObjectId().toString();
    aggregate.pair(userId, new Date()); // ADR-007 정합 — Date 인자 전달

    SessionMock.findByIdAndUpdate.mockResolvedValueOnce(makeDocLike(aggregate));
    await repo.save(aggregate);

    expect(SessionMock.findByIdAndUpdate).toHaveBeenCalledTimes(1);
    const callArgs = SessionMock.findByIdAndUpdate.mock.calls[0];
    expect(callArgs[0]).toBe(aggregate.id);

    const fields = callArgs[1] as {
      status: string;
      userId: Types.ObjectId | null;
      pairedAt: Date | null;
      groupId: string;
      subjectIndex: number;
    };
    expect(fields.status).toBe('PAIRED');
    expect(fields.userId).not.toBeNull();
    expect(String(fields.userId)).toBe(userId);
    expect(fields.pairedAt).not.toBeNull();
    expect(fields.groupId).toBe('A1B2C3D4');
    expect(fields.subjectIndex).toBe(1);

    const options = callArgs[2] as { upsert: boolean };
    expect(options.upsert).toBe(false);
  });

  test('보조: findById 미존재 시 null 반환', async () => {
    SessionMock.findById.mockResolvedValueOnce(null);
    const result = await repo.findById('does-not-exist');
    expect(result).toBeNull();
  });

  test('보조: findByPairingToken 미존재 시 null 반환', async () => {
    SessionMock.findOne.mockResolvedValueOnce(null);
    const result = await repo.findByPairingToken('NOPE000');
    expect(result).toBeNull();
  });
});

describe('SessionRepository.findByPairingToken — null hydration', () => {
  let repo: SessionRepository;
  beforeEach(() => {
    jest.clearAllMocks();
    repo = new SessionRepository();
  });
  afterEach(() => {
    // L1 amend: jest.spyOn 누수 차단 — assertion 실패 시에도 static fromDocument 복원
    jest.restoreAllMocks();
  });

  it('toAggregate passes null subjectIndex through to fromDocument (spy 검증)', async () => {
    const fromDocSpy = jest.spyOn(SessionAggregate, 'fromDocument');
    const legacyDoc = {
      _id: 'sess-legacy',
      groupId: 'grp-legacy',
      subjectIndex: null,
      pairingToken: 'LEGACY01',
      creatorId: null,
      experimentMode: 'DUAL',
      expiresAt: new Date(Date.now() + 60_000),
      status: 'CREATED',
      userId: null,
      pairedAt: null,
    };
    (Session.findOne as jest.Mock).mockResolvedValue(legacyDoc);

    await expect(repo.findByPairingToken('LEGACY01')).rejects.toThrow(
      InvariantViolationError
    );

    expect(fromDocSpy).toHaveBeenCalledWith(
      expect.objectContaining({ subjectIndex: null })
    );
    // afterEach jest.restoreAllMocks()가 spy 복원 담당
  });

  it('findByPairingToken happy path — subjectIndex >= 1 doc returns Aggregate', async () => {
    const validDoc = {
      _id: 'sess-001',
      groupId: 'grp-001',
      subjectIndex: 1,
      pairingToken: 'VALID01',
      creatorId: null,
      experimentMode: 'DUAL',
      expiresAt: new Date(Date.now() + 60_000),
      status: 'CREATED',
      userId: null,
      pairedAt: null,
    };
    (Session.findOne as jest.Mock).mockResolvedValue(validDoc);

    const aggregate = await repo.findByPairingToken('VALID01');
    expect(aggregate).toBeInstanceOf(SessionAggregate);
    expect(aggregate?.subjectIndex).toBe(1);
  });
});
