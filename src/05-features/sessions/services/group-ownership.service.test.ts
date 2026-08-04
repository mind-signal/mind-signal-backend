/**
 * AUTH-W002 회귀 방어 — groupId 소유권 검증.
 *
 * 이 백엔드에는 "요청자가 이 groupId 의 소유자인가"를 판정하는 계층이 없었음.
 * groupId 는 QR 과 대시보드에서 평문으로 다루는 값이라, 인증만 통과하면 아무
 * 계정이나 남의 그룹 측정을 시작하거나 중단하거나 분석 결과를 받아낼 수 있었음.
 *
 * 이 스위트를 지우거나 약화시키면 그 구멍이 조용히 되돌아옴.
 */

const mockFind = jest.fn();
const mockFindById = jest.fn();

jest.mock('@06-entities/sessions', () => ({
  Session: {
    find: (...args: unknown[]) => mockFind(...args),
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}));

import {
  assertGroupOwnership,
  assertSessionOwnership,
} from './group-ownership.service';
import { AppError } from '@07-shared/errors';

/** Session.find 결과를 지정함 */
function mockSessions(docs: unknown[]) {
  mockFind.mockResolvedValue(docs);
}

/** Session.findById 결과를 지정함 */
function mockSessionById(doc: unknown) {
  mockFindById.mockResolvedValue(doc);
}

describe('assertGroupOwnership (AUTH-W002)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('합류한 피실험자는 통과함', async () => {
    mockSessions([{ userId: 'user-1', creatorId: 'operator-9' }]);

    await expect(
      assertGroupOwnership('group-abc', 'user-1')
    ).resolves.toBeUndefined();
  });

  it('세션을 만든 운영자는 통과함', async () => {
    // 피실험자가 아직 합류하지 않아 userId 가 없는 상태도 운영자는 통과해야 함
    mockSessions([{ userId: null, creatorId: 'operator-9' }]);

    await expect(
      assertGroupOwnership('group-abc', 'operator-9')
    ).resolves.toBeUndefined();
  });

  it('2인 측정에서 상대 피실험자의 세션으로도 통과함', async () => {
    mockSessions([
      { userId: 'user-1', creatorId: 'operator-9' },
      { userId: 'user-2', creatorId: 'operator-9' },
    ]);

    await expect(
      assertGroupOwnership('group-abc', 'user-2')
    ).resolves.toBeUndefined();
  });

  it('무관한 사용자는 403으로 거부함', async () => {
    mockSessions([{ userId: 'user-1', creatorId: 'operator-9' }]);

    await expect(
      assertGroupOwnership('group-abc', 'attacker-7')
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('존재하지 않는 그룹은 404로 거부함', async () => {
    mockSessions([]);

    await expect(
      assertGroupOwnership('group-nope', 'user-1')
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      assertGroupOwnership('group-nope', 'user-1')
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('ObjectId 타입 필드도 문자열로 비교함', async () => {
    // 실제 문서의 userId 와 creatorId 는 ObjectId 라 === 비교가 성립하지 않음.
    // toString() 을 거치지 않으면 정당한 참여자가 403 을 맞음
    mockSessions([
      {
        userId: { toString: () => 'user-1' },
        creatorId: { toString: () => 'operator-9' },
      },
    ]);

    await expect(
      assertGroupOwnership('group-abc', 'user-1')
    ).resolves.toBeUndefined();
  });
});

describe('assertSessionOwnership (AUTH-W002)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('세션의 그룹 참여자는 통과함', async () => {
    mockSessionById({ groupId: 'group-abc' });
    mockSessions([{ userId: 'user-1', creatorId: 'operator-9' }]);

    await expect(
      assertSessionOwnership('session-1', 'user-1')
    ).resolves.toBeUndefined();
  });

  it('무관한 사용자는 403으로 거부함', async () => {
    mockSessionById({ groupId: 'group-abc' });
    mockSessions([{ userId: 'user-1', creatorId: 'operator-9' }]);

    await expect(
      assertSessionOwnership('session-1', 'attacker-7')
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('존재하지 않는 세션은 404로 거부함', async () => {
    mockSessionById(null);

    await expect(
      assertSessionOwnership('session-nope', 'user-1')
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
