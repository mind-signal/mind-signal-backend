import jwt from 'jsonwebtoken';
import type { JwtPayload } from 'jsonwebtoken';
import { Session } from '@06-entities/sessions';
import { AppError } from '@07-shared/errors';
import { config } from '@07-shared/config/config';
import {
  OPERATOR_SOCKET_TOKEN_TTL_SECONDS,
  OPERATOR_SOCKET_TOKEN_TYPE,
} from '@07-shared/constants/operator-socket-token';

// ===== operator join 완료 listener registry =====

type OperatorJoinCallback = (data: { groupId: string }) => void | Promise<void>;
const operatorJoinListeners = new Set<OperatorJoinCallback>();

/**
 * operator join 완료 시 호출될 콜백 등록함.
 *
 * @param cb - groupId를 받는 콜백 함수
 */
export function addOperatorJoinListener(cb: OperatorJoinCallback): void {
  operatorJoinListeners.add(cb);
}

/**
 * [Service] operator join 프로세스 수행함.
 *
 * invite JWT 토큰을 검증하여 groupId, experimentMode와 소켓 토큰을 반환함.
 * QR 직접 스캔 flow를 지원하므로 authenticate 미들웨어 없이 호출 가능함.
 *
 * @param token - createOperatorInviteToken이 발급한 JWT
 * @returns groupId, experimentMode와 운영자 소켓 인증 정보 반환
 * @throws AppError 401 — 토큰 서명 오류 또는 만료
 * @throws AppError 400 — 잘못된 토큰 타입
 * @throws AppError 404 — 해당 groupId 세션 없음
 */
export async function joinAsOperator(token: string): Promise<{
  groupId: string;
  experimentMode: 'DUAL_2PC';
  socketToken: string;
  socketTokenExpiresAt: number;
}> {
  let payload: JwtPayload;
  try {
    // JWT 서명 및 만료 검증 수행함
    payload = jwt.verify(
      token,
      config.jwtSecret.secret as string
    ) as JwtPayload;
  } catch {
    throw new AppError('토큰이 유효하지 않거나 만료되었습니다.', 401);
  }

  // 토큰 타입 검증 수행함
  if (payload.type !== 'operator_invite') {
    throw new AppError('올바르지 않은 토큰 타입입니다.', 400);
  }

  const groupId = payload.groupId as string;

  // 세션 존재 및 experimentMode 재확인 수행함
  const sessions = await Session.find({ groupId });
  if (sessions.length === 0) {
    throw new AppError('세션을 찾을 수 없습니다.', 404);
  }

  const issuedAtSeconds = Math.floor(Date.now() / 1000);
  const socketTokenExpiresAt =
    (issuedAtSeconds + OPERATOR_SOCKET_TOKEN_TTL_SECONDS) * 1000;
  const socketToken = jwt.sign(
    {
      groupId,
      type: OPERATOR_SOCKET_TOKEN_TYPE,
      iat: issuedAtSeconds,
    },
    config.jwtSecret.secret,
    { expiresIn: OPERATOR_SOCKET_TOKEN_TTL_SECONDS }
  );

  // operator join 완료 listener 호출 (LD-12 대안 D)
  // fire-and-forget — listener 내부 retry/timeout이 응답 블로킹 방지함
  for (const cb of operatorJoinListeners) {
    void Promise.resolve(cb({ groupId })).catch((err) => {
      console.error('operatorJoinListener 에러:', err);
    });
  }

  return {
    groupId,
    experimentMode: 'DUAL_2PC',
    socketToken,
    socketTokenExpiresAt,
  };
}
