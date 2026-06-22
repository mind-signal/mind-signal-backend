import { Request, Response, NextFunction } from 'express';
import * as measurementService from '@02-processes/measurements/services/measurement.service';

const measurementController = {
  /**
   * 뇌파 측정 시작 핸들러.
   * DUAL_2PC: 202 Accepted + Socket.io dual-session-ready 이벤트 대기 안내 반환함.
   * 그 외: 200 OK + measuredAt 반환함 (v4 N-8 + v5 N-9 반영).
   */
  startStreaming: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sessionId } = req.params;

      // 서비스 로직 호출 — discriminated union 반환
      const result =
        await measurementService.startMeasurementService(sessionId);

      // 서비스 결과 기반 분기 — 컨트롤러에서 Session.findById 재호출 금지
      if (result.kind === 'DUAL_2PC') {
        return res.status(202).json({
          status: 'accepted',
          message:
            'DUAL_2PC 측정 준비 시작됨. Socket.io dual-session-ready 이벤트 대기.',
          groupId: result.groupId,
        });
      }

      // result.kind === 'SYNC' — 기존 경로
      return res.status(200).json({
        status: 'success',
        message: '측정이 시작되었습니다.',
        measuredAt: result.measuredAt,
      });
    } catch (error) {
      // 에러 발생 시 전역 핸들러로 전달
      return next(error);
    }
  },

  /**
   * groupId 기반 DUAL_2PC 측정 시작 핸들러.
   * 오퍼레이터 대시보드가 sessionId 없이 groupId만 보유할 때 사용함.
   * 202 Accepted + groupId 반환함.
   */
  startStreamingByGroup: async (
    req: Request,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const { groupId } = req.params;

      // groupId 기반 서비스 호출 — 404/400 검증 포함
      const result =
        await measurementService.startDualMeasurementByGroup(groupId);

      return res.status(202).json({
        status: 'accepted',
        groupId: result.groupId,
      });
    } catch (error) {
      // 에러 발생 시 전역 핸들러로 전달
      return next(error);
    }
  },
};

export default measurementController;
