import express, { Router } from 'express';
import { engineController } from './engine.controller';
import { authenticate } from '@07-shared/middlewares/authenticate.middleware';
import { validate } from '@07-shared/middlewares/validate.middleware';
import { z } from 'zod';

const router = Router();

/**
 * @openapi
 * tags:
 *   - name: Engine
 *     description: 파이썬 데이터 엔진 등록 및 분석 프록시
 */

// 파이썬 엔진이 구동 시 자동 호출하는 등록 엔드포인트
const registerSchema = z.object({
  engineUrl: z.string().url(),
  secretKey: z.string().min(1),
});

/**
 * @openapi
 * /api/engine/register:
 *   post:
 *     summary: 파이썬 엔진 URL 등록
 *     description: |
 *       파이썬 FastAPI 서버가 구동 시 자동으로 호출하여 엔진 URL과 secret key를 등록함.
 *       인증 불필요 (엔진 간 내부 통신).
 *     tags: [Engine]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [engineUrl, secretKey]
 *             properties:
 *               engineUrl:
 *                 type: string
 *                 format: uri
 *                 example: "https://abcd-1234.ngrok-free.app"
 *               secretKey:
 *                 type: string
 *                 minLength: 1
 *                 example: "your-shared-secret-here"
 *     responses:
 *       200:
 *         description: 엔진 등록 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string, example: "엔진 등록 완료" }
 *       400:
 *         description: 유효성 검사 실패
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "fail" }
 *                 message: { type: string, example: "Invalid url" }
 *       403:
 *         description: 시크릿 키 불일치
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "fail" }
 *                 message: { type: string, example: "유효하지 않은 시크릿 키입니다." }
 */
router.post('/register', validate(registerSchema), engineController.register);

// DUAL_2PC 모드에서 각 DE 프로세스가 부팅 시 호출하는 등록 엔드포인트
const registerDualSchema = z.object({
  groupId: z.string().min(1),
  subjectIndex: z.number().int().min(1).max(2),
  engineUrl: z.string().url(),
  secretKey: z.string().min(1),
});

/**
 * @openapi
 * /api/engine/register-dual:
 *   post:
 *     summary: DUAL_2PC 엔진 URL 등록 (groupId+subjectIndex별)
 *     description: DUAL_2PC 모드에서 각 DE 프로세스가 부팅 시 호출. 인증 불필요 (엔진↔백엔드 내부).
 *     tags: [Engine]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [groupId, subjectIndex, engineUrl, secretKey]
 *             properties:
 *               groupId: { type: string, minLength: 1, example: "grp_abc123" }
 *               subjectIndex: { type: integer, minimum: 1, maximum: 2, example: 1 }
 *               engineUrl: { type: string, format: uri, example: "http://192.168.0.10:5002" }
 *               secretKey: { type: string, minLength: 1 }
 *     responses:
 *       200:
 *         description: 등록 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message: { type: string, example: "DUAL_2PC 엔진 등록 완료" }
 *                 registeredCount: { type: integer, example: 2 }
 *       400: { description: Zod 유효성 실패 }
 *       403: { description: secretKey 불일치 }
 */
router.post(
  '/register-dual',
  validate(registerDualSchema),
  engineController.registerDual
);

// DUAL_2PC 2-PC 집계 — 노트북 B DE가 자기 subject CSV를 operator로 업로드함.
// 인증: x-engine-secret 헤더(엔진 내부 통신). 본문: text/csv 원본, 메타: filename 쿼리.
router.post(
  '/csv-upload',
  express.text({ type: ['text/csv', 'text/plain'], limit: '15mb' }),
  engineController.csvUpload
);

// 전체 파이프라인 분석 프록시
const analyzePipelineSchema = z.object({
  groupId: z.string().min(1),
  subjectIndices: z.array(z.number().int().positive()),
  mode: z.enum(['DUAL', 'BTI']).optional().default('DUAL'),
  algorithm: z.string().optional().default('default'),
  params: z
    .object({
      stimulusDurationSec: z.number().int().positive().optional(),
      windowSizeSec: z.number().int().positive().optional(),
      nStimuli: z.number().int().positive().optional(),
      baselineDurationSec: z.number().int().positive().optional(),
      bandCols: z.array(z.string()).optional(),
    })
    .optional(),
  satisfactionScores: z.record(z.string(), z.number()).optional(),
  includeMarkdown: z.boolean().optional().default(false),
});

/**
 * @openapi
 * /api/engine/analyze/pipeline:
 *   post:
 *     summary: 전체 파이프라인 분석 요청
 *     description: |
 *       알고리즘 명세 기반 전체 파이프라인 분석을 프록시함.
 *       Baseline 산출 → Stimulus 윈도우 분할 → Feature 추출 → Pair Feature → Y 계산을 수행함.
 *       응답은 snake_case → camelCase로 자동 변환됨.
 *     tags: [Engine]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [groupId, subjectIndices]
 *             properties:
 *               groupId:
 *                 type: string
 *                 minLength: 1
 *                 example: "grp_abc123"
 *               subjectIndices:
 *                 type: array
 *                 items:
 *                   type: integer
 *                   minimum: 1
 *                 example: [1, 2]
 *               params:
 *                 type: object
 *                 description: 분석 파이프라인 파라미터 (모두 optional, 미지정 시 기본값 사용)
 *                 properties:
 *                   stimulusDurationSec:
 *                     type: integer
 *                     minimum: 1
 *                     default: 60
 *                     example: 60
 *                   windowSizeSec:
 *                     type: integer
 *                     minimum: 1
 *                     default: 10
 *                     example: 10
 *                   nStimuli:
 *                     type: integer
 *                     minimum: 1
 *                     default: 10
 *                     example: 10
 *                   baselineDurationSec:
 *                     type: integer
 *                     minimum: 1
 *                     default: 30
 *                     example: 30
 *                   bandCols:
 *                     type: array
 *                     items: { type: string }
 *                     default: ["alpha", "beta", "theta", "gamma"]
 *                     example: ["alpha", "beta", "theta", "gamma"]
 *               satisfactionScores:
 *                 type: object
 *                 nullable: true
 *                 description: 피실험자별 관계 만족도 점수 (키는 subjectIndex 문자열)
 *                 additionalProperties: { type: number }
 *                 example: { "1": 7.5, "2": 6.0 }
 *               includeMarkdown:
 *                 type: boolean
 *                 default: false
 *                 example: true
 *     responses:
 *       200:
 *         description: 파이프라인 분석 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 groupId: { type: string, example: "grp_abc123" }
 *                 subjects:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       subjectIndex: { type: integer, example: 1 }
 *                       baseline:
 *                         type: object
 *                         description: 대역별 baseline 평균값
 *                         properties:
 *                           alpha: { type: number, example: 0.42 }
 *                           beta: { type: number, example: 0.35 }
 *                           theta: { type: number, example: 0.22 }
 *                           gamma: { type: number, example: 0.08 }
 *                       features:
 *                         type: object
 *                         description: "윈도우별×대역별 feature (키: s{N}_w{N}_{band})"
 *                         additionalProperties: { type: number }
 *                         example: { "s1W1Alpha": 0.12, "s1W1Beta": 0.08 }
 *                       nFeatures: { type: integer, example: 240 }
 *                 pairFeatures:
 *                   type: object
 *                   nullable: true
 *                   description: "두 피실험자의 feature 결합 (키: a_/b_ 접두사)"
 *                   additionalProperties: { type: number }
 *                   example: { "aS1W1Alpha": 0.12, "bS1W1Alpha": 0.08 }
 *                 yScore:
 *                   type: number
 *                   nullable: true
 *                   description: "|satisfaction_A - satisfaction_B|"
 *                   example: 1.5
 *                 synchronyScore:
 *                   type: number
 *                   nullable: true
 *                   example: 0.75
 *                 pipelineParams:
 *                   type: object
 *                   properties:
 *                     stimulusDurationSec: { type: integer, example: 60 }
 *                     windowSizeSec: { type: integer, example: 10 }
 *                     nStimuli: { type: integer, example: 10 }
 *                     baselineDurationSec: { type: integer, example: 30 }
 *                     bandCols:
 *                       type: array
 *                       items: { type: string }
 *                       example: ["alpha", "beta", "theta", "gamma"]
 *                     nWindowsPerStimulus: { type: integer, example: 6 }
 *                     totalFeaturesPerSubject: { type: integer, example: 240 }
 *                 markdown:
 *                   type: string
 *                   nullable: true
 *       400:
 *         description: 유효성 검사 실패
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "fail" }
 *                 message: { type: string, example: "Required" }
 *       401:
 *         description: 인증 실패
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "fail" }
 *                 message: { type: string, example: "인증이 필요합니다." }
 *       503:
 *         description: 파이썬 엔진 미등록
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "fail" }
 *                 message: { type: string, example: "파이썬 데이터 엔진이 아직 등록되지 않았습니다." }
 */
router.post(
  '/analyze/pipeline',
  authenticate,
  validate(analyzePipelineSchema),
  engineController.analyzePipeline
);

// EEG 스트리밍 프록시 — 프론트엔드 → 백엔드 → 파이썬 엔진
const streamStartSchema = z.object({
  groupId: z.string().min(1),
  subjectIndex: z.number().int().nonnegative(),
});

/**
 * @openapi
 * /api/engine/stream/start:
 *   post:
 *     summary: EEG 스트리밍 시작 (엔진 프록시)
 *     description: |
 *       등록된 파이썬 엔진에 core.main spawn을 요청하여 EEG 실시간 스트리밍을 시작함.
 *     tags: [Engine]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [groupId, subjectIndex]
 *             properties:
 *               groupId:
 *                 type: string
 *                 minLength: 1
 *                 example: "grp_abc123"
 *               subjectIndex:
 *                 type: integer
 *                 minimum: 0
 *                 example: 1
 *     responses:
 *       200:
 *         description: 스트리밍 시작 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "started" }
 *                 pid: { type: integer, example: 12345 }
 *                 key: { type: string, example: "grp_abc123:1" }
 *       409:
 *         description: 이미 실행 중인 스트림
 *       503:
 *         description: 파이썬 엔진 미등록
 */
router.post(
  '/stream/start',
  authenticate,
  validate(streamStartSchema),
  engineController.streamStart
);

const streamStopSchema = z.object({
  groupId: z.string().min(1),
  subjectIndex: z.number().int().nonnegative(),
  stopReason: z
    .enum(['Natural', 'ManualEarly', 'HeadsetLost', 'ProcessError'])
    .optional()
    .default('Natural'),
});

/**
 * @openapi
 * /api/engine/stream/stop:
 *   post:
 *     summary: EEG 스트리밍 종료 (엔진 프록시)
 *     description: |
 *       등록된 파이썬 엔진에 실행 중인 EEG 스트리밍 프로세스 종료를 요청함.
 *     tags: [Engine]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [groupId, subjectIndex]
 *             properties:
 *               groupId:
 *                 type: string
 *                 minLength: 1
 *                 example: "grp_abc123"
 *               subjectIndex:
 *                 type: integer
 *                 minimum: 0
 *                 example: 1
 *               stopReason:
 *                 type: string
 *                 enum: [Natural, ManualEarly, HeadsetLost, ProcessError]
 *                 default: Natural
 *                 description: 종료 사유
 *                 example: "Natural"
 *     responses:
 *       200:
 *         description: 스트리밍 종료 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "stopped" }
 *                 key: { type: string, example: "grp_abc123:1" }
 *       404:
 *         description: 실행 중인 스트림 없음
 *       503:
 *         description: 파이썬 엔진 미등록
 */
router.post(
  '/stream/stop',
  authenticate,
  validate(streamStopSchema),
  engineController.streamStop
);

const stopAllSchema = z.object({
  groupId: z.string().min(1),
  stopReason: z
    .enum(['Natural', 'ManualEarly', 'HeadsetLost', 'ProcessError'])
    .optional()
    .default('ManualEarly'),
});

/**
 * @openapi
 * /api/engine/stream/stop-all:
 *   post:
 *     summary: 그룹 내 모든 EEG 스트리밍 일괄 종료
 *     description: |
 *       groupId에 속한 MEASURING 상태의 모든 subject를 순차적으로 종료함.
 *       조기 종료 버튼 클릭 시 프론트엔드에서 호출함.
 *     tags: [Engine]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [groupId]
 *             properties:
 *               groupId:
 *                 type: string
 *                 minLength: 1
 *                 example: "grp_abc123"
 *               stopReason:
 *                 type: string
 *                 enum: [Natural, ManualEarly, HeadsetLost, ProcessError]
 *                 default: ManualEarly
 *                 description: 종료 사유
 *                 example: "ManualEarly"
 *     responses:
 *       200:
 *         description: 일괄 종료 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: "success" }
 *                 stoppedCount: { type: integer, example: 2 }
 *                 allCompleted: { type: boolean, example: true }
 *       404:
 *         description: MEASURING 상태의 세션 없음
 *       503:
 *         description: 파이썬 엔진 미등록
 */
router.post(
  '/stream/stop-all',
  authenticate,
  validate(stopAllSchema),
  engineController.stopAll
);

// ===== Phase 17.6 — DUAL_2PC trigger gap hotfix 라우트 (LD-31) =====

// registry 상태 snapshot 조회 (FE polling 용)
router.get('/registry-status', engineController.getRegistryStatus);

// 양쪽 DE에 assign-group 트리거 요청 처리함
const dualTriggerSchema = z.object({
  groupId: z.string().min(1),
});

router.post(
  '/dual-trigger',
  validate(dualTriggerSchema),
  engineController.dualTrigger
);

// DE startup pending 등록 처리함
const registerPendingSchema = z.object({
  subjectIndex: z.union([z.literal(1), z.literal(2)]),
  engineUrl: z.string().url(),
  secretKey: z.string().min(1),
});

router.post(
  '/register-pending',
  validate(registerPendingSchema),
  engineController.registerPending
);

// DE 종료 시 pending entry 삭제 처리함
const unregisterPendingSchema = z.object({
  subjectIndex: z.union([z.literal(1), z.literal(2)]),
  engineUrl: z.string().url(),
  secretKey: z.string().min(1),
});

router.delete(
  '/register-pending',
  validate(unregisterPendingSchema),
  engineController.unregisterPending
);

export default router;
