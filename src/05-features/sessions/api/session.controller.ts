import { Request, Response, NextFunction } from 'express';
import {
  createGroupSessionProcess,
  firePairingCompleteListeners,
} from '@05-features/sessions/services/pairing.service';
import { submitConsentProcess } from '@05-features/sessions/services/submit-consent.service';
import { createOperatorInviteToken } from '@05-features/sessions/services/invite-operator.service';
import { joinAsOperator } from '@05-features/sessions/services/join-operator.service';
import { adminPairDeviceProcess } from '@05-features/sessions/services/admin-pair.service';
import { AppError } from '@07-shared/errors';
import {
  pairDeviceSchema,
  submitConsentSchema,
} from '@05-features/sessions/dto/session.dto';
import { Session } from '@06-entities/sessions';
import { AuthedRequest } from '@07-shared/types';
import { systemClock } from '@07-shared/clock';
import {
  sessionRepository,
  aggregateToPairingResponseDto,
} from '@06-entities/sessions';
import { PairSubjectService } from '@05-features/sessions/services/pair-subject.service';

/**
 * [Controller] 새로운 그룹 세션 또는 그룹 내 추가 세션 생성 수행함
 */
export const createSession = async (
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    // 기존 그룹 추가 시 groupId, DUAL_2PC 등 모드 지정 시 experimentMode를 본문에서 받음
    const { groupId, experimentMode } = req.body;

    // 비즈니스 프로세스 호출하여 세션 생성 수행함
    const newSession = await createGroupSessionProcess(
      groupId,
      req.user?.id,
      experimentMode
    );

    res.status(201).json({
      status: 'success',
      data: {
        id: newSession._id,
        groupId: newSession.groupId,
        subjectIndex: newSession.subjectIndex,
        pairingToken: newSession.pairingToken,
        expiresAt: newSession.expiresAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * [Controller] 특정 그룹의 모든 세션 참가 상태 조회 수행함
 */
export const checkGroupStatus = async (
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { groupId } = req.params;

    if (!req.user?.id) {
      throw new AppError('인증이 필요합니다.', 401);
    }

    // 해당 그룹 ID를 가진 모든 세션 조회 수행함 (userId populate)
    const sessions = await Session.find({ groupId }).populate(
      'userId',
      'name email'
    );

    if (sessions.length === 0) {
      throw new AppError('해당 그룹을 찾을 수 없습니다.', 404);
    }

    // 소유권 검증: 요청자가 해당 그룹 세션의 참여자인지 확인함
    // subject 합류 전(userId=null) 상태에서는 인증된 사용자 접근 허용 (operator 폴링)
    const hasBindings = sessions.some((s) => s.userId);
    if (hasBindings) {
      const isParticipant = sessions.some(
        (s) =>
          (s.userId && s.userId._id?.toString() === req.user!.id) ||
          s.creatorId?.toString() === req.user!.id
      );
      if (!isParticipant) {
        throw new AppError('해당 그룹에 대한 접근 권한이 없습니다.', 403);
      }
    }

    // 프론트엔드 위젯 표시를 위한 데이터 가공 수행함
    const status = sessions.map((s) => {
      const user = s.userId as any;
      return {
        subjectIndex: s.subjectIndex,
        status: s.status,
        guestJoined: s.status === 'PAIRED' || s.status === 'MEASURING',
        userName: user?.name || null,
        isMe: s.userId?._id?.toString() === req.user!.id,
      };
    });

    res.status(200).json({
      status: 'success',
      data: { groupId, sessions: status },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * [Controller] 모바일 기기 페어링 요청 처리함
 *
 * PairSubjectService request-scope factory + controller-level listener fire (ADR-008 §1, §3)
 */
export const pairDevice = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const validatedRequest = pairDeviceSchema.parse({ params: req.params });
    const { pairingToken } = validatedRequest.params;

    if (!req.user || !req.user.id) {
      throw new AppError('인증이 필요한 서비스입니다.', 401);
    }

    const userId = req.user.id;

    // Request-scope PS factory (recordedEvents buffer 누적 차단, ADR-008 §1)
    const pairSubjectService = new PairSubjectService(
      sessionRepository,
      systemClock
    );

    const result = await pairSubjectService.execute({ pairingToken, userId });

    // Controller-level listener fire (dual-fire atomic, ADR-008 §3)
    firePairingCompleteListeners(
      result.event.groupId,
      result.event.subjectIndex
    );

    res.status(200).json({
      status: 'success',
      data: aggregateToPairingResponseDto(result.session),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * [Controller] 관리자 강제 페어링 처리함.
 *
 * @throws AppError 401 — admin/타겟 user 미존재
 * @throws AppError 403 — 관리자 권한 없음
 * @throws AppError 404 — target email DB 미존재
 */
export const adminPairDevice = async (
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { pairingToken } = req.params;
    // validate middleware가 body를 adminPairSchema로 parse 후 교체함
    const { email } = req.body as { email: string };

    if (!req.user || !req.user.id) {
      throw new AppError('인증이 필요한 서비스입니다.', 401);
    }
    const adminId = req.user.id;

    const session = await adminPairDeviceProcess(pairingToken, email, adminId);

    res.status(200).json({ status: 'success', data: session });
  } catch (error) {
    next(error);
  }
};

/**
 * [Controller] operator invite 토큰 발급 처리함.
 * authenticate 미들웨어 적용 필수 (operator 인증 필요).
 */
export const createOperatorInviteHandler = async (
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { groupId } = req.params;

    const result = await createOperatorInviteToken(groupId);

    res.status(201).json({
      status: 'success',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * [Controller] operator join 처리함.
 * QR 직접 스캔 flow 지원 — authenticate 미들웨어 미적용, JWT body 검증만 수행함.
 */
export const joinAsOperatorHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { token } = req.body as { token: string };

    if (!token || typeof token !== 'string') {
      throw new AppError('token 필드가 필요합니다.', 400);
    }

    const result = await joinAsOperator(token);

    res.status(200).json({
      status: 'success',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * [Controller] 피실험자 동의서 제출 처리함
 */
export const submitConsent = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const validated = submitConsentSchema.parse({
      body: req.body,
      params: req.params,
    });
    const { sessionId } = validated.params;
    const { versionId, isResearchAgreed } = validated.body;

    if (!req.user) throw new AppError('인증이 필요합니다.', 401);

    const consent = await submitConsentProcess({
      sessionId,
      userId: req.user.id,
      versionId,
      isResearchAgreed,
    });

    res.status(201).json({ status: 'success', data: consent });
  } catch (error) {
    next(error);
  }
};
