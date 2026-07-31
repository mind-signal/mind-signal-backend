import { Request, Response, NextFunction } from 'express';
import { engineRegistryService } from '../services/engine-registry.service';
import { engineProxyService } from '../services/engine-proxy.service';
import { dualTriggerService } from '../services/dual-2pc-trigger.service';
import { stopMeasurementService } from '@02-processes/measurements/services/measurement.service';
import { saveUploadedCsv } from '../services/csv-upload.service';
import {
  countCsvRows,
  evaluateSubjectCoverage,
} from '../services/session-coverage.service';
import { AppError } from '@07-shared/errors';
import { SocketService } from '@07-shared/lib/socket';

/** 최소 분석 가능 시간 (초) — 교수 확인 후 확정 예정 (임시 180초) */
const MIN_ANALYSIS_SECONDS = 180;

/**
 * 3-tier 분류 후 적절한 분석 파이프라인 트리거함
 * - SEQUENTIAL: 자동 트리거 안 함. operator "Analyze" 버튼(POST /api/analyze/sequential) 대기함
 * - VALID: measuredDurationSeconds >= MIN_ANALYSIS_SECONDS
 * - PARTIAL: 한쪽만 VALID
 * - ABORTED: 둘 다 INVALID
 */
async function triggerPostMeasurementByTier(groupId: string) {
  const { Session: SessionModel } = await import('@06-entities/sessions');

  // SEQUENTIAL 모드 조기 분기: 자동 분석 트리거 안 함 (I2 + N1)
  // subjectIndex: { $ne: null } 필터로 null 세션이 대표 세션으로 선택되는 경우 방지함
  const representativeSession = await SessionModel.findOne({
    groupId,
    subjectIndex: { $ne: null },
  }).sort({ subjectIndex: 1 });
  const experimentMode = representativeSession?.experimentMode ?? 'DUAL';

  if (experimentMode === 'SEQUENTIAL') {
    // operator "Analyze" 버튼 대기 — 소켓으로 측정 완료만 알림
    SocketService.emitLiveEvent('analysis-status', {
      groupId,
      tier: 'SEQUENTIAL',
      message:
        'SEQUENTIAL 모드 측정 완료. "Analyze" 버튼으로 분석을 시작하세요.',
    });
    return;
  }

  const completedSessions = await SessionModel.find({
    groupId,
    status: 'COMPLETED',
  });

  // 프로세스 생존 시간뿐 아니라 실제 수집량(coverage)까지 확인함.
  // 스트림이 중간에 죽어도 프로세스가 살아 있으면 duration만으로는 통과하기 때문임.
  const validSessions = completedSessions.filter((s) => {
    const rows = countCsvRows(groupId, s.subjectIndex as number);
    const verdict = evaluateSubjectCoverage(
      rows,
      s.measuredDurationSeconds,
      MIN_ANALYSIS_SECONDS
    );
    if (!verdict.valid) {
      console.warn(
        `[postMeasurement] groupId=${groupId} subject=${s.subjectIndex} 제외: ${verdict.reason} (rows=${rows}, coverage=${(verdict.coverage * 100).toFixed(1)}%)`
      );
    }
    return verdict.valid;
  });

  const tier =
    validSessions.length >= 2
      ? 'VALID'
      : validSessions.length === 1
        ? 'PARTIAL'
        : 'ABORTED';

  console.log(
    `[postMeasurement] groupId=${groupId} tier=${tier} (valid=${validSessions.length}/${completedSessions.length})`
  );

  if (tier === 'ABORTED') {
    // 양쪽 모두 데이터 부족 — 분석 불가, Socket.io로 ABORTED 알림함
    SocketService.emitLiveEvent('analysis-status', {
      groupId,
      tier: 'ABORTED',
      message: '양쪽 모두 측정 데이터가 부족합니다. 재측정이 필요합니다.',
    });
    return;
  }

  const mod = await import('@02-processes/post-measurement');

  if (tier === 'VALID') {
    // DUAL 분석 실행함
    mod
      .runPostMeasurementPipeline(groupId)
      .catch((err) => notifyPipelineFailure(groupId, 'DUAL', err));
  } else {
    // PARTIAL — BTI 폴백 분석 실행함.
    // 유효 판정을 받은 subject를 넘김. 1로 하드코딩하면 유효한 쪽이 subject 2일
    // 때 탈락한 데이터를 분석하려다 실패함(2026-07-31 실측)
    const validSubjectIndex = validSessions[0].subjectIndex as number;
    SocketService.emitLiveEvent('analysis-status', {
      groupId,
      tier: 'PARTIAL',
      message: `한 명(subject ${validSubjectIndex})의 데이터로 BTI 개인 분석을 진행합니다.`,
    });
    mod
      .runBTIAnalysisPipeline(groupId, validSubjectIndex)
      .catch((err) => notifyPipelineFailure(groupId, 'BTI', err));
  }
}

/**
 * 분석 파이프라인 실패를 사용자와 로그 양쪽에 알림함.
 *
 * 이전에는 두 catch가 console.error만 하고 끝나 프론트가 실패를 알 방법이
 * 없었음. 결과 화면은 폴링을 계속하다 "응답 시간 초과"만 띄웠고 DB에도
 * 흔적이 남지 않아 사후 진단이 불가능했음(2026-07-31 실측).
 *
 * tier는 ABORTED를 재사용함. 프론트가 이 값에서만 폴링을 중단하고 message를
 * 표시하므로 프론트 변경 없이 즉시 실패를 전달할 수 있음. 실패 사유는
 * message로 구분됨.
 *
 * @param groupId - 측정 그룹 식별자임
 * @param pipeline - 실패한 파이프라인 종류임
 * @param err - 원인 에러임
 */
function notifyPipelineFailure(
  groupId: string,
  pipeline: 'DUAL' | 'BTI',
  err: unknown
): void {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(
    `[postMeasurement] groupId=${groupId} ${pipeline} 파이프라인 실패: ${reason}`
  );
  SocketService.emitLiveEvent('analysis-status', {
    groupId,
    tier: 'ABORTED',
    message: `분석에 실패했습니다. 재측정이 필요합니다. (${pipeline} 파이프라인 오류)`,
  });
}

export const engineController = {
  /** 파이썬 엔진 URL 등록 처리함 */
  register: (req: Request, res: Response, next: NextFunction) => {
    try {
      const { engineUrl, secretKey } = req.body;
      engineRegistryService.register(engineUrl, secretKey);
      res.status(200).json({ message: '엔진 등록 완료' });
    } catch (error) {
      next(error);
    }
  },

  /** DUAL_2PC 엔진 URL 등록 처리함 */
  registerDual: (req: Request, res: Response, next: NextFunction) => {
    try {
      const { groupId, subjectIndex, engineUrl, secretKey } = req.body;
      engineRegistryService.registerDual(
        groupId,
        subjectIndex,
        engineUrl,
        secretKey
      );
      const group = engineRegistryService.getByGroup(groupId);
      res.status(200).json({
        message: 'DUAL_2PC 엔진 등록 완료',
        registeredCount: group?.size ?? 0,
      });
    } catch (error) {
      next(error);
    }
  },

  /** 노트북 B DE가 업로드한 subject CSV를 operator csv 폴더에 저장함 (2-PC 집계) */
  csvUpload: (req: Request, res: Response, next: NextFunction) => {
    try {
      const secretKey = req.header('x-engine-secret') ?? '';
      const filename = String(req.query.filename ?? '');
      const content = typeof req.body === 'string' ? req.body : '';
      saveUploadedCsv({ secretKey, filename, content });
      res.status(200).json({ status: 'success', message: 'CSV 업로드 완료' });
    } catch (error) {
      next(error);
    }
  },

  /** 파이프라인 분석 요청을 파이썬 엔진으로 프록시함 */
  analyzePipeline: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        groupId,
        subjectIndices,
        params,
        satisfactionScores,
        includeMarkdown,
      } = req.body;
      const result = await engineProxyService.analyzePipeline(
        groupId,
        subjectIndices,
        params,
        satisfactionScores,
        includeMarkdown
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /** EEG 스트리밍 시작 요청을 파이썬 엔진으로 프록시함 */
  streamStart: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { groupId, subjectIndex } = req.body;
      const result = await engineProxyService.streamStart(
        groupId,
        subjectIndex
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },

  /** EEG 스트리밍 종료 요청을 파이썬 엔진으로 프록시 + 세션 COMPLETED 전이함 */
  streamStop: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { groupId, subjectIndex, stopReason } = req.body;

      // 1. 엔진에 스트리밍 종료 요청함
      const engineResult = await engineProxyService.streamStop(
        groupId,
        subjectIndex
      );

      // 2. 세션 COMPLETED 전이 + Redis 구독 해제 + stopReason 기록함
      const { allCompleted } = await stopMeasurementService(
        groupId,
        subjectIndex,
        stopReason ?? 'Natural'
      );

      // 3. 모든 subject 완료 시 3-tier 분류 후 파이프라인 트리거함
      if (allCompleted) {
        triggerPostMeasurementByTier(groupId).catch((err) =>
          console.error('3-tier 파이프라인 트리거 에러:', err)
        );
      }

      res.status(200).json({ ...engineResult, allCompleted });
    } catch (error) {
      next(error);
    }
  },

  /** registry 상태 snapshot 반환함 (FE polling 용) */
  getRegistryStatus: (req: Request, res: Response, next: NextFunction) => {
    try {
      const groupId = req.query.groupId as string;
      if (!groupId || typeof groupId !== 'string') {
        throw new AppError('groupId 쿼리 필수', 400);
      }
      const status = dualTriggerService.getRegistryStatus(groupId);
      res.status(200).json(status);
    } catch (err) {
      next(err);
    }
  },

  /** 양쪽 DE에 assign-group 트리거 요청 처리함 */
  dualTrigger: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { groupId } = req.body;
      const subjects = await dualTriggerService.collectPendingSubjects(groupId);
      if (subjects.length !== 2) {
        throw new AppError('양쪽 DE 모두 pending 상태가 아님', 503);
      }
      const result = await dualTriggerService.triggerAssignGroup(
        groupId,
        subjects
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  /** DE startup pending 등록 처리함 */
  registerPending: (req: Request, res: Response, next: NextFunction) => {
    try {
      const { subjectIndex, engineUrl, secretKey } = req.body;
      engineRegistryService.registerPending(subjectIndex, engineUrl, secretKey);
      res.status(200).json({ status: 'registered' });
    } catch (err) {
      next(err);
    }
  },

  /** DE 종료 시 pending entry 삭제 처리함 */
  unregisterPending: (req: Request, res: Response, next: NextFunction) => {
    try {
      const { subjectIndex, engineUrl, secretKey } = req.body;
      engineRegistryService.unregisterPending(
        subjectIndex,
        engineUrl,
        secretKey
      );
      res.status(200).json({ deleted: true });
    } catch (err) {
      next(err);
    }
  },

  /** 그룹 내 모든 MEASURING 세션 일괄 종료 수행함 */
  stopAll: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { groupId, stopReason } = req.body;

      // MEASURING 상태의 세션만 조회함
      const { Session: SessionModel } = await import('@06-entities/sessions');
      const measuringSessions = await SessionModel.find({
        groupId,
        status: 'MEASURING',
      });

      if (measuringSessions.length === 0) {
        throw new AppError('현재 측정 중인 세션이 없습니다.', 404);
      }

      // 각 subject를 순차적으로 종료함
      for (const session of measuringSessions) {
        if (session.subjectIndex === null) continue;

        try {
          await engineProxyService.streamStop(groupId, session.subjectIndex);
        } catch (err) {
          console.error(
            `[stopAll] 엔진 종료 실패 subject=${session.subjectIndex}:`,
            err
          );
        }

        await stopMeasurementService(
          groupId,
          session.subjectIndex,
          stopReason ?? 'ManualEarly'
        );
      }

      // 루프 후 순서 무관하게 전체 완료 여부 독립 확인함
      const allSessions = await SessionModel.find({ groupId });
      const allCompleted = allSessions.every((s) => s.status === 'COMPLETED');

      // 모든 subject 완료 시 3-tier 분류 후 파이프라인 트리거함
      if (allCompleted) {
        triggerPostMeasurementByTier(groupId).catch((err) =>
          console.error('3-tier 파이프라인 트리거 에러:', err)
        );
      }

      res.status(200).json({
        status: 'success',
        stoppedCount: measuringSessions.length,
        allCompleted,
      });
    } catch (error) {
      next(error);
    }
  },
};
