/**
 * join-operator.service.ts — Unit 테스트
 *
 * 검증 항목:
 *   - 유효 JWT → groupId, experimentMode, socketToken 반환함
 *   - 만료 토큰 → AppError 401 발생함
 *   - 잘못된 서명 → AppError 401 발생함
 *   - 잘못된 type 클레임 → AppError 400 발생함
 *   - 세션 없음 → AppError 404 발생함
 */

import jwt from 'jsonwebtoken';
import {
  OPERATOR_SOCKET_TOKEN_TTL_SECONDS,
  OPERATOR_SOCKET_TOKEN_TYPE,
} from '@07-shared/constants/operator-socket-token';
import { joinAsOperator } from './join-operator.service';

// Session 모델 모킹 — MongoDB 의존 제거함
jest.mock('@06-entities/sessions', () => ({
  Session: {
    find: jest.fn(),
  },
}));

// config 모킹 — 테스트 전용 JWT 시크릿 주입함
jest.mock('@07-shared/config/config', () => ({
  config: {
    jwtSecret: { secret: 'test-secret-key', expiresIn: '5m' },
    dataEngine: { secretKey: 'engine-secret' },
  },
}));

import { Session } from '@06-entities/sessions';

const mockSession = Session as jest.Mocked<typeof Session>;

/** 테스트용 유효 토큰 생성 헬퍼 */
function makeValidToken(
  groupId: string,
  type: string = 'operator_invite'
): string {
  return jwt.sign({ groupId, type }, 'test-secret-key', { expiresIn: '5m' });
}

describe('joinAsOperator — join-operator.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('유효 JWT 시 소켓 인증 정보를 포함해 반환함', async () => {
    // Arrange
    const token = makeValidToken('group-abc');
    (mockSession.find as jest.Mock).mockResolvedValue([
      { groupId: 'group-abc' },
    ]);

    // Act
    const result = await joinAsOperator(token);

    // Assert
    expect(result.groupId).toBe('group-abc');
    expect(result.experimentMode).toBe('DUAL_2PC');
    expect(typeof result.socketToken).toBe('string');

    const decoded = jwt.verify(result.socketToken, 'test-secret-key');
    if (typeof decoded === 'string' || !decoded.exp || !decoded.iat) {
      throw new Error('소켓 토큰 claim을 확인할 수 없습니다.');
    }
    expect(decoded.groupId).toBe('group-abc');
    expect(decoded.type).toBe(OPERATOR_SOCKET_TOKEN_TYPE);
    expect(result.socketTokenExpiresAt).toBe(decoded.exp * 1000);
    expect(decoded.exp - decoded.iat).toBe(OPERATOR_SOCKET_TOKEN_TTL_SECONDS);
  });

  it('만료 토큰 → AppError 401 발생함', async () => {
    // Arrange — expiresIn: 0은 즉시 만료 처리됨
    const expiredToken = jwt.sign(
      { groupId: 'group-abc', type: 'operator_invite' },
      'test-secret-key',
      { expiresIn: 0 }
    );

    // Act & Assert
    await expect(joinAsOperator(expiredToken)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('잘못된 서명 → AppError 401 발생함', async () => {
    // Arrange — 다른 시크릿으로 서명된 토큰
    const wrongToken = jwt.sign(
      { groupId: 'group-abc', type: 'operator_invite' },
      'wrong-secret'
    );

    // Act & Assert
    await expect(joinAsOperator(wrongToken)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("type !== 'operator_invite' → AppError 400 발생함", async () => {
    // Arrange — 올바르지 않은 type 클레임
    const wrongTypeToken = makeValidToken('group-abc', 'user_token');

    // Act & Assert
    await expect(joinAsOperator(wrongTypeToken)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('세션 없음 → AppError 404 발생함', async () => {
    // Arrange — 세션 없음 시뮬레이션
    const token = makeValidToken('nonexistent-group');
    (mockSession.find as jest.Mock).mockResolvedValue([]);

    // Act & Assert
    await expect(joinAsOperator(token)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
