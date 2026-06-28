// src/02-processes/measurement/api/measurement.routes.ts
import { Router } from 'express';
import measurementController from './measurement.controller';
import { authenticate, validateParams } from '@07-shared/middlewares';
import {
  measurementStartParamsSchema,
  measurementGroupStartParamsSchema,
} from './measurement.schema';

const router = Router();

/**
 * [Phase 2] 실시간 스트리밍 및 외부 엔진 실행 트리거
 * http://localhost:5000/api/measurements/sessions/:sessionId/eeg/stream:start
 * 02-processes 계층에서 복잡한 오케스트레이션을 제어함
 */

/**
 * @openapi
 * tags:
 *   - name: Measurements
 *     description: 뇌파 측정 및 실시간 스트리밍 관리
 */

/**
 * @openapi
 * /api/measurements/sessions/{sessionId}/eeg/stream:start:
 *   post:
 *     summary: 실시간 뇌파 스트리밍 시작 (Phase 2)
 *     description: |
 *       세션의 측정을 시작하고(상태 전이), Redis → Socket 브릿징 및 외부 Python 엔진을 실행합니다.
 *       - 상태 전이 규칙: canTransitionTo('MEASURING') 를 만족해야 합니다.
 *       - 성공 시 Session.status는 MEASURING으로 변경되고 measuredAt이 저장됩니다.
 *     tags: [Measurements]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         description: 측정을 시작할 세션 ID(ObjectId)
 *         schema:
 *           type: string
 *           example: "65c9f0b2a1b2c3d4e5f67890"
 *     responses:
 *       200:
 *         description: 스트리밍 시작 성공(세션 상태가 MEASURING으로 변경)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "success" }
 *                 message: { type: string, example: "측정이 시작되었습니다." }
 *                 measuredAt:
 *                   type: string
 *                   format: date-time
 *                   example: "2026-02-12T08:39:11.497Z"
 *
 *       400:
 *         description: 상태 전이 불가 또는 subjectIndex 누락
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "fail" }
 *                 message:
 *                   type: string
 *                   example: "현재 CREATED 상태에서는 측정을 시작할 수 없습니다."
 *
 *       401:
 *         description: 인증 실패(토큰 누락/만료/비정상)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "fail" }
 *                 message: { type: string, example: "유효하지 않은 토큰입니다." }
 *
 *       404:
 *         description: 세션을 찾을 수 없음
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "fail" }
 *                 message: { type: string, example: "요청하신 세션을 찾을 수 없습니다." }
 *
 *       500:
 *         description: 서버 오류(외부 엔진 실행/Redis 구독 등)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "error" }
 *                 message: { type: string, example: "서버 내부에 예상치 못한 오류가 발생했습니다." }
 */

router.post(
  '/sessions/:sessionId/eeg/stream:start',
  authenticate,
  validateParams(measurementStartParamsSchema),
  measurementController.startStreaming
);

/**
 * @openapi
 * /api/measurements/groups/{groupId}/eeg/stream:start:
 *   post:
 *     summary: DUAL_2PC 그룹 기반 측정 시작
 *     description: |
 *       오퍼레이터 대시보드가 sessionId 없이 groupId만 보유한 경우 사용함.
 *       - groupId로 세션 존재 여부 및 experimentMode=DUAL_2PC 검증함.
 *       - 검증 통과 시 fire-and-forget으로 DUAL_2PC 측정을 시작하고 202 반환함.
 *     tags: [Measurements]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupId
 *         required: true
 *         description: 측정을 시작할 실험 그룹 ID(ObjectId)
 *         schema:
 *           type: string
 *           example: "65c9f0b2a1b2c3d4e5f67890"
 *     responses:
 *       202:
 *         description: 측정 시작 수락됨(fire-and-forget)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "accepted" }
 *                 groupId:
 *                   type: string
 *                   example: "65c9f0b2a1b2c3d4e5f67890"
 *
 *       400:
 *         description: experimentMode가 DUAL_2PC가 아님
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "fail" }
 *                 message:
 *                   type: string
 *                   example: "groupId 기반 측정 시작은 DUAL_2PC 모드만 지원합니다."
 *
 *       401:
 *         description: 인증 실패(토큰 누락/만료/비정상)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "fail" }
 *                 message: { type: string, example: "유효하지 않은 토큰입니다." }
 *
 *       404:
 *         description: 해당 groupId의 세션을 찾을 수 없음
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "fail" }
 *                 message:
 *                   type: string
 *                   example: "해당 groupId에 속한 세션을 찾을 수 없습니다."
 *
 *       500:
 *         description: 서버 오류
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "error" }
 *                 message:
 *                   type: string
 *                   example: "서버 내부에 예상치 못한 오류가 발생했습니다."
 */
router.post(
  '/groups/:groupId/eeg/stream:start',
  authenticate,
  validateParams(measurementGroupStartParamsSchema),
  measurementController.startStreamingByGroup
);

export default router;
