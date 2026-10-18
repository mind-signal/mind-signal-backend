import { Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { AnalysisResult } from '@06-entities/analysis-results';
import { Session } from '@06-entities/sessions';
import { AppError } from '@07-shared/errors';
import { AuthedRequest } from '@07-shared/types';

/** 그룹 분석 결과 조회 수행함 */
export const getAnalysisResult = async (
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const { groupId } = req.params;

    if (!req.user?.id) {
      throw new AppError('인증이 필요합니다.', 401);
    }

    // 소유권 검증: 요청자가 해당 그룹 참여자인지 확인함
    const sessions = await Session.find({ groupId }).populate('userId', 'name');
    if (sessions.length === 0) {
      throw new AppError('해당 그룹을 찾을 수 없습니다.', 404);
    }
    const isParticipant = sessions.some(
      (s) =>
        (s.userId && s.userId._id?.toString() === req.user!.id) ||
        s.creatorId?.toString() === req.user!.id
    );
    if (!isParticipant) {
      throw new AppError('해당 그룹에 대한 접근 권한이 없습니다.', 403);
    }

    const result = await AnalysisResult.findOne({ groupId }).populate(
      'user1Id user2Id',
      'name'
    );

    // 등급 판정 결과임. 판정 전이면 null 임 (SESSION-W008)
    const tier = sessions.find((s) => s.analysisTier)?.analysisTier ?? null;

    if (!result) {
      // ABORTED 처럼 결과가 만들어지지 않는 그룹도 등급은 알 수 있게 함
      return res.status(404).json({
        status: 'fail',
        message: '분석 결과를 찾을 수 없습니다.',
        tier,
      });
    }

    const user1 = result.user1Id as any;
    const user2 = result.user2Id as any;

    const isBTI =
      (user1 as any)?._id?.toString() === (user2 as any)?._id?.toString();
    const subjects = (result.pipelineResult as any)?.subjects;

    res.status(200).json({
      status: 'success',
      data: {
        groupId: result.groupId,
        tier,
        matchingScore: result.matchingScore,
        synchronyScore: result.synchronyScore,
        yScore: result.yScore,
        aiComment: result.aiComment,
        markdown: result.markdown,
        user1Name: user1?.name || null,
        user2Name: user2?.name || null,
        isBTI,
        metricsMean: subjects?.[0]?.metricsMean ?? null,
        wavesMean: subjects?.[0]?.wavesMean ?? null,
      },
    });
  } catch (error) {
    next(error);
  }
};

/** 내 분석 결과 목록 조회 수행함 */
export const getMyAnalysisResults = async (
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.user?.id) {
      throw new AppError('인증이 필요합니다.', 401);
    }

    const userId = new Types.ObjectId(req.user.id);

    // creatorId 또는 userId 기준으로 완료된 세션 조회함
    const sessions = await Session.find({
      $or: [{ userId }, { creatorId: userId }],
      status: 'COMPLETED',
    }).select('groupId');

    // 중복 groupId 제거함
    const groupIds = [...new Set(sessions.map((s) => s.groupId))];

    if (groupIds.length === 0) {
      return res.status(200).json({ status: 'success', data: [] });
    }

    /** lean() 조회용 분석 결과 타입 정의함 */
    interface LeanAnalysisResult {
      groupId: string;
      matchingScore: number;
      user1Id: { name: string } | null;
      user2Id: { name: string } | null;
      createdAt: Date;
    }

    // .lean()으로 조회하여 toJSON의 createdAt 삭제 회피함
    const results = await AnalysisResult.find({
      groupId: { $in: groupIds },
    })
      .populate('user1Id user2Id', 'name')
      .sort({ createdAt: -1 })
      .lean<LeanAnalysisResult[]>();

    const data = results.map((r) => ({
      groupId: r.groupId,
      matchingScore: r.matchingScore,
      user1Name: r.user1Id?.name || null,
      user2Name: r.user2Id?.name || null,
      createdAt: r.createdAt,
    }));

    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
};
