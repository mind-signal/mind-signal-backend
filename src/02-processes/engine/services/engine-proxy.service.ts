import { AppError } from '@07-shared/errors';
import { config } from '@07-shared/config/config';
import { engineRegistryService } from './engine-registry.service';

/** snake_case 키를 camelCase로 재귀 변환함 */
function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/** 객체의 모든 키를 snake_case → camelCase로 재귀 변환함 */
function toCamelCaseKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(toCamelCaseKeys);
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([key, val]) => [
        snakeToCamel(key),
        toCamelCaseKeys(val),
      ])
    );
  }
  return obj;
}

export const engineProxyService = {
  /** 등록된 파이썬 엔진으로 전체 파이프라인 분석 요청을 프록시함 */
  async analyzePipeline(
    groupId: string,
    subjectIndices: number[],
    params?: {
      stimulusDurationSec?: number;
      windowSizeSec?: number;
      nStimuli?: number;
      baselineDurationSec?: number;
      bandCols?: string[];
    },
    satisfactionScores?: Record<number, number>,
    includeMarkdown?: boolean,
    engineUrlOverride?: string
  ): Promise<Record<string, unknown>> {
    // 2-PC는 양쪽 DE가 legacy 단일 slot에 등록해 getEngineUrl()이 레이스임.
    // CSV가 집계된 operator 로컬 DE로 분석을 고정하려면 override를 사용함.
    const engineUrl = engineUrlOverride ?? engineRegistryService.getEngineUrl();

    const response = await fetch(`${engineUrl}/api/analyze/pipeline`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Engine-Secret': config.dataEngine.secretKey,
      },
      body: JSON.stringify({
        ['group_id']: groupId,
        ['subject_indices']: subjectIndices,
        ['params']: params
          ? {
              ['stimulus_duration_sec']: params.stimulusDurationSec,
              ['window_size_sec']: params.windowSizeSec,
              ['n_stimuli']: params.nStimuli,
              ['baseline_duration_sec']: params.baselineDurationSec,
              ['band_cols']: params.bandCols,
            }
          : undefined,
        ['satisfaction_scores']: satisfactionScores,
        ['include_markdown']: includeMarkdown ?? false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new AppError(
        `파이썬 엔진 파이프라인 분석 실패: ${response.status} ${errorText}`,
        response.status
      );
    }

    const data = await response.json();
    return toCamelCaseKeys(data) as Record<string, unknown>;
  },

  /** 등록된 파이썬 엔진으로 세션 분석 요청을 프록시함 (BTI용, metrics_mean/waves_mean 포함) */
  async analyzeSession(
    groupId: string,
    subjectIndices: number[],
    includeMarkdown?: boolean
  ): Promise<Record<string, unknown>> {
    const engineUrl = engineRegistryService.getEngineUrl();

    const response = await fetch(`${engineUrl}/api/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Engine-Secret': config.dataEngine.secretKey,
      },
      body: JSON.stringify({
        ['group_id']: groupId,
        ['subject_indices']: subjectIndices,
        ['include_markdown']: includeMarkdown ?? false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new AppError(
        `파이썬 엔진 세션 분석 실패: ${response.status} ${errorText}`,
        response.status
      );
    }

    const data = await response.json();
    return toCamelCaseKeys(data) as Record<string, unknown>;
  },

  /** 등록된 파이썬 엔진으로 EEG 스트리밍 시작 요청을 프록시함 */
  async streamStart(
    groupId: string,
    subjectIndex: number
  ): Promise<Record<string, unknown>> {
    const engineUrl = engineRegistryService.getEngineUrl();

    const response = await fetch(`${engineUrl}/api/stream/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Engine-Secret': config.dataEngine.secretKey,
      },
      body: JSON.stringify({
        ['group_id']: groupId,
        ['subject_index']: subjectIndex,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new AppError(
        `파이썬 엔진 스트림 시작 실패: ${response.status} ${errorText}`,
        response.status
      );
    }

    const data = await response.json();
    return toCamelCaseKeys(data) as Record<string, unknown>;
  },

  /**
   * DUAL_2PC 전용 스트리밍 시작 요청 프록시함.
   * groupId+subjectIndex로 등록된 DE URL 조회 후 /api/stream/start 호출함.
   *
   * @param groupId - 실험 그룹 ID
   * @param subjectIndex - 피실험자 순번 (1 또는 2)
   * @returns 엔진 응답 페이로드
   * @throws AppError 503 — 해당 groupId+subjectIndex DE 미등록
   */
  streamStartDual: async (
    groupId: string,
    subjectIndex: number
  ): Promise<Record<string, unknown>> => {
    const engineUrl = engineRegistryService.getEngineUrlByGroupSubject(
      groupId,
      subjectIndex
    );

    // [RC-2 반영] snake_case key — DE Pydantic `StreamStartRequest` 와 일치
    // (기존 streamStart engine-proxy.service.ts:157-160 pattern 재사용)
    const response = await fetch(`${engineUrl}/api/stream/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Engine-Secret': config.dataEngine.secretKey,
      },
      body: JSON.stringify({
        ['group_id']: groupId,
        ['subject_index']: subjectIndex,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new AppError(
        `DUAL_2PC 엔진 스트림 시작 실패: ${response.status} ${errorText}`,
        response.status
      );
    }

    const data = await response.json();
    return toCamelCaseKeys(data) as Record<string, unknown>;
  },

  /** 등록된 파이썬 엔진으로 EEG 스트리밍 종료 요청을 프록시함 */
  async streamStop(
    groupId: string,
    subjectIndex: number
  ): Promise<Record<string, unknown>> {
    // group 없으면 1PC legacy 폴백(BTI 가 사용), group 있는데 slot 없으면 DUAL_2PC 미등록 — 503
    const registrations = engineRegistryService.getByGroup(groupId);
    let engineUrl: string;
    if (!registrations) {
      engineUrl = engineRegistryService.getEngineUrl();
    } else {
      const registration = registrations.get(subjectIndex);
      if (!registration) {
        throw new AppError(
          `DUAL_2PC 엔진 미등록: groupId=${groupId}, subjectIndex=${subjectIndex}`,
          503
        );
      }
      engineUrl = registration.url;
    }

    const response = await fetch(`${engineUrl}/api/stream/stop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Engine-Secret': config.dataEngine.secretKey,
      },
      body: JSON.stringify({
        ['group_id']: groupId,
        ['subject_index']: subjectIndex,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new AppError(
        `파이썬 엔진 스트림 종료 실패: ${response.status} ${errorText}`,
        response.status
      );
    }

    const data = await response.json();
    return toCamelCaseKeys(data) as Record<string, unknown>;
  },
};
