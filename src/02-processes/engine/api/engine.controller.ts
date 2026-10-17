import { Request, Response, NextFunction } from 'express';
import { engineRegistryService } from '../services/engine-registry.service';
import { engineProxyService } from '../services/engine-proxy.service';
import { dualTriggerService } from '../services/dual-2pc-trigger.service';
import { stopMeasurementService } from '@02-processes/measurements/services/measurement.service';
import { saveUploadedCsv } from '../services/csv-upload.service';
import {
  MIN_COVERAGE_RATIO,
  evaluateSubjectCoverage,
  readCsvStats,
} from '../services/session-coverage.service';
import { assertGroupOwnership } from '@05-features/sessions';
import { AppError } from '@07-shared/errors';
import { SocketService } from '@07-shared/lib/socket';
import { AuthedRequest } from '@07-shared/types';

/**
 * 인증된 요청자가 그 groupId 의 참여자인지 확인함 (AUTH-W002).
 *
 * 라우트에 `authenticate` 가 걸려 있어도 body 의 groupId 는 검증되지 않았음.
 * 즉 계정만 있으면 남의 그룹 측정을 시작하거나 중단하거나 분석 결과를
 * 받아낼 수 있었음.
 *
 * @param req - 인증 미들웨어를 통과한 요청임
 * @param groupId - 요청 body 또는 query 의 그룹 식별자임
 * @throws AppError 401 - 인증 정보가 없을 때
 * @throws AppError 403 - 참여자도 생성자도 아닐 때
 * @throws AppError 404 - 해당 groupId 의 세션이 하나도 없을 때
 */
async function assertRequesterOwnsGroup(
  req: AuthedRequest,
  groupId: string
): Promise<void> {
  if (!req.user?.id) {
    throw new AppError('인증이 필요합니다.', 401);
  }
  await assertGroupOwnership(groupId, req.user.id);
}

/** 최소 분석 가능 시간 (초) — 교수 확인 후 확정 예정 (임시 180초) */
const MIN_ANALYSIS_SECONDS = 180;

/**
 * 3-tier 분류 후 적절한 분석 파이프라인 트리거함
 * - VALID: measuredDurationSeconds >= MIN_ANALYSIS_SECONDS
 * - PARTIAL: 한쪽만 VALID
 * - ABORTED: 둘 다 INVALID
 */
async function triggerPostMeasurementByTier(groupId: string) {
  const { Session: SessionModel } = await import('@06-entities/sessions');

  const completedSessions = await SessionModel.find({
    groupId,
    status: 'COMPLETED',
  });

  // 프로세스 생존 시간뿐 아니라 실제 수집량(coverage)까지 확인함.
  // 스트림이 중간에 죽어도 프로세스가 살아 있으면 duration만으로는 통과하기 때문임.
  const validSessions = completedSessions.filter((s) => {
    const stats = readCsvStats(groupId, s.subjectIndex as number);
    const verdict = evaluateSubjectCoverage(
      stats,
      s.measuredDurationSeconds,
      MIN_ANALYSIS_SECONDS
    );
    // 판정 여부와 무관하게 세 지표를 남김. 밀도는 게이트, 완주율은 관측용,
    // legacy는 옛 판정식 값이라 회차 간 비교가 끊기지 않게 함
    const metrics =
      `rows=${stats.rows} span=${stats.spanSeconds.toFixed(1)}s ` +
      `density=${(verdict.density * 100).toFixed(1)}% ` +
      `completion=${(verdict.completionRatio * 100).toFixed(1)}% ` +
      `legacy=${(verdict.legacyCoverage * 100).toFixed(1)}%`;
    if (verdict.valid) {
      console.log(
        `[postMeasurement] groupId=${groupId} subject=${s.subjectIndex} 유효: ${metrics}`
      );
      // 완주율이 낮으면 데이터는 쓰되 스트림 이상을 경고로 남김
      if (verdict.completionRatio < MIN_COVERAGE_RATIO) {
        console.warn(
          `[postMeasurement] groupId=${groupId} subject=${s.subjectIndex} ` +
            `완주율 낮음 — 스트림 조기 종료나 전달 지연 의심: ${metrics}`
        );
      }
    } else {
      console.warn(
        `[postMeasurement] groupId=${groupId} subject=${s.subjectIndex} 제외: ${verdict.reason} (${metrics})`
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

  // 등급을 두 세션에 저장함. 이미 판정된 그룹이면 0건이라 여기서 끝냄 —
  // 판정과 emit 이 그룹당 한 번만 일어나게 하는 가드임
  const saved = await SessionModel.updateMany(
    { groupId, analysisTier: null },
    { $set: { analysisTier: tier } }
  );
  if (saved.modifiedCount === 0) {
    console.warn(`[postMeasurement] groupId=${groupId} 이미 판정됨, 건너뜀`);
    return;
  }

  if (tier === 'ABORTED') {
    // 양쪽 모두 데이터 부족 — 분석 불가, Socket.io로 ABORTED 알림함
    // 그룹 room 으로만 보냄. 전역 emit 이면 무관한 소켓도 받음 (AUTH-W001)
    SocketService.emitToGroup(groupId, 'analysis-status', {
      groupId,
      tier: 'ABORTED',
      message: '양쪽 모두 측정 데이터가 부족합니다. 재측정이 필요합니다.',
    });
    return;
  }

  const mod = await import('@02-processes/post-measurement');

  if (tier === 'VALID') {
    SocketService.emitToGroup(groupId, 'analysis-status', {
      groupId,
      tier: 'VALID',
      message: '두 명의 데이터로 분석을 진행합니다.',
    });
    // DUAL 분석 실행함
    mod
      .runPostMeasurementPipeline(groupId)
      .catch((err) => notifyPipelineFailure(groupId, 'DUAL', err));
  } else {
    // PARTIAL — BTI 폴백 분석 실행함.
    // 유효 판정을 받은 subject를 넘김. 1로 하드코딩하면 유효한 쪽이 subject 2일
    // 때 탈락한 데이터를 분석하려다 실패함(2026-07-31 실측)
    const validSubjectIndex = validSessions[0].subjectIndex as number;
    SocketService.emitToGroup(groupId, 'analysis-status', {
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
  SocketService.emitToGroup(groupId, 'analysis-status', {
    groupId,
    tier: 'ABORTED',
    message: `분석에 실패했습니다. 재측정이 필요합니다. (${pipeline} 파이프라인 오류)`,
  });
}

/** 그룹별 직렬화 체인임 — 세션 COMPLETED 전이를 한 번에 하나씩만 처리함 */
const groupLocks = new Map<string, Promise<unknown>>();

/**
 * 같은 그룹의 작업을 프로세스 안에서 순서대로 실행함.
 * ponytail: 프로세스 안 가드만 있음. 백엔드를 여러 프로세스로 띄우면 DB
 * 조건부 갱신(findOneAndUpdate)으로 바꿔야 함
 */
function withGroupLock<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
  const run = (groupLocks.get(groupId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  groupLocks.set(groupId, tail);
  void tail.then(() => {
    if (groupLocks.get(groupId) === tail) groupLocks.delete(groupId);
  });
  return run;
}

/**
 * 운영자 수동 중지가 진행 중인 그룹임. 수동 중지가 엔진을 멈추면 엔진도 CSV 를
 * 올리는데, 그 업로드가 먼저 세션을 끝내면 stopReason 이 Natural 로 잘못 남음
 */
const manualStopGroups = new Set<string>();

/**
 * subject 하나를 COMPLETED 로 전이함. 이미 COMPLETED 면 건너뜀.
 * 그룹 가드 안에서 실행하므로 수동 중지와 엔진 업로드가 겹쳐도 한 번만 전이됨.
 *
 * @returns 이번 호출이 그룹의 마지막 전이를 했는지 반환
 * @throws AppError 404/400 — 세션 없음 또는 MEASURING 이 아닌 상태일 때
 */
function completeSubject(
  groupId: string,
  subjectIndex: number,
  stopReason: 'Natural' | 'ManualEarly' | 'HeadsetLost' | 'ProcessError'
): Promise<{ allCompleted: boolean }> {
  return withGroupLock(groupId, async () => {
    const { Session: SessionModel } = await import('@06-entities/sessions');
    const session = await SessionModel.findOne({ groupId, subjectIndex });
    if (session?.status === 'COMPLETED') return { allCompleted: false };
    return stopMeasurementService(groupId, subjectIndex, stopReason);
  });
}

/** 그룹 등급 판정을 비동기로 시작함 */
function startTierJudgement(groupId: string): void {
  triggerPostMeasurementByTier(groupId).catch((err) =>
    console.error('3-tier 파이프라인 트리거 에러:', err)
  );
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

  /**
   * DE가 업로드한 subject CSV를 operator csv 폴더에 저장함 (2-PC 집계).
   * 엔진은 측정을 끝낼 때만 CSV 를 올리므로 업로드를 자연 종료 통지로도 씀
   * (SESSION-W008). 세션이 MEASURING 일 때만 Natural 로 COMPLETED 전이함
   */
  csvUpload: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const secretKey = req.header('x-engine-secret') ?? '';
      const filename = String(req.query.filename ?? '');
      const content = typeof req.body === 'string' ? req.body : '';
      const { groupId, subjectIndex } = saveUploadedCsv({
        secretKey,
        filename,
        content,
      });

      if (!manualStopGroups.has(groupId)) {
        try {
          const { allCompleted } = await completeSubject(
            groupId,
            subjectIndex,
            'Natural'
          );
          if (allCompleted) startTierJudgement(groupId);
        } catch (err) {
          // MEASURING 이 아닌 세션의 업로드는 CSV 저장만 함
          console.warn(
            `[csvUpload] groupId=${groupId} subject=${subjectIndex} 종료 처리 생략: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }

      res.status(200).json({ status: 'success', message: 'CSV 업로드 완료' });
    } catch (error) {
      next(error);
    }
  },

  /** 파이프라인 분석 요청을 파이썬 엔진으로 프록시함 */
  analyzePipeline: async (
    req: AuthedRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const {
        groupId,
        subjectIndices,
        params,
        satisfactionScores,
        includeMarkdown,
      } = req.body;
      // includeMarkdown 이 true 면 분석 서술이 응답에 그대로 실려 나감
      await assertRequesterOwnsGroup(req, groupId);
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
  streamStart: async (
    req: AuthedRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const { groupId, subjectIndex } = req.body;
      await assertRequesterOwnsGroup(req, groupId);
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
  streamStop: async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const { groupId, subjectIndex, stopReason } = req.body;
      await assertRequesterOwnsGroup(req, groupId);

      manualStopGroups.add(groupId);
      try {
        // 1. 엔진에 스트리밍 종료 요청함
        const engineResult = await engineProxyService.streamStop(
          groupId,
          subjectIndex
        );

        // 2. 세션 COMPLETED 전이 + Redis 구독 해제 + stopReason 기록함
        const { allCompleted } = await completeSubject(
          groupId,
          subjectIndex,
          stopReason ?? 'Natural'
        );

        // 3. 이번 호출이 마지막 전이를 했을 때만 3-tier 판정 트리거함
        if (allCompleted) startTierJudgement(groupId);

        res.status(200).json({ ...engineResult, allCompleted });
      } finally {
        manualStopGroups.delete(groupId);
      }
    } catch (error) {
      next(error);
    }
  },

  /** registry 상태 snapshot 반환함 (FE polling 용) */
  getRegistryStatus: async (
    req: AuthedRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const groupId = req.query.groupId as string;
      if (!groupId || typeof groupId !== 'string') {
        throw new AppError('groupId 쿼리 필수', 400);
      }
      await assertRequesterOwnsGroup(req, groupId);
      const status = dualTriggerService.getRegistryStatus(groupId);
      res.status(200).json(status);
    } catch (err) {
      next(err);
    }
  },

  /** 양쪽 DE에 assign-group 트리거 요청 처리함 */
  dualTrigger: async (
    req: AuthedRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const { groupId } = req.body;
      await assertRequesterOwnsGroup(req, groupId);
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
  stopAll: async (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const { groupId, stopReason } = req.body;
      // 한 호출로 그룹의 MEASURING 세션 전부를 끝내므로 파급이 가장 큼
      await assertRequesterOwnsGroup(req, groupId);

      // MEASURING 상태의 세션만 조회함
      const { Session: SessionModel } = await import('@06-entities/sessions');
      const measuringSessions = await SessionModel.find({
        groupId,
        status: 'MEASURING',
      });

      if (measuringSessions.length === 0) {
        // 엔진 자연 종료가 먼저 두 세션을 끝냈으면 중지할 것이 없을 뿐임
        const allSessions = await SessionModel.find({ groupId });
        if (
          allSessions.length > 0 &&
          allSessions.every((s) => s.status === 'COMPLETED')
        ) {
          res
            .status(200)
            .json({ status: 'success', stoppedCount: 0, allCompleted: true });
          return;
        }
        throw new AppError('현재 측정 중인 세션이 없습니다.', 404);
      }

      manualStopGroups.add(groupId);
      let finishedGroup = false;
      try {
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

          // 조회 뒤 엔진 업로드가 먼저 끝낸 세션은 건너뜀
          const result = await completeSubject(
            groupId,
            session.subjectIndex,
            stopReason ?? 'ManualEarly'
          );
          finishedGroup ||= result.allCompleted;
        }
      } finally {
        manualStopGroups.delete(groupId);
      }

      // 이번 호출이 마지막 전이를 했을 때만 3-tier 판정 트리거함
      if (finishedGroup) startTierJudgement(groupId);

      // 응답은 순서 무관하게 전체 완료 여부를 독립 확인함
      const allSessions = await SessionModel.find({ groupId });
      const allCompleted = allSessions.every((s) => s.status === 'COMPLETED');

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
