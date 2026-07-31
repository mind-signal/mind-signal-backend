/**
 * engine-proxy.service.ts — analyzePipeline DUAL_2PC URL 고정 (2-PC CSV 집계)
 *
 * 배경: 2-PC에서는 양쪽 DE가 legacy /register를 단일 slot에 호출해 getEngineUrl()이
 * 레이스(마지막 등록 승)임. 분석은 CSV가 집계된 operator 로컬 DE에서 돌아야 하므로
 * engineUrlOverride로 operator 로컬 DE URL을 강제할 수 있어야 함.
 *
 * fix 전 RED: override 파라미터 무시 → legacy URL로 요청.
 * fix 후 GREEN: override 제공 시 그 URL, 없으면 legacy 폴백.
 */

const ENGINE_SECRET = 'correct-engine-secret';

jest.mock('@07-shared/config/config', () => ({
  config: {
    dataEngine: {
      path: '/tmp/engine',
      baseUrl: 'http://localhost:5002',
      pythonBin: 'python',
      secretKey: 'correct-engine-secret',
    },
  },
}));

import { engineProxyService } from './engine-proxy.service';
import { engineRegistryService } from './engine-registry.service';

const GROUP_ID = 'grp_analyze_url_test';

describe('engineProxyService.analyzePipeline — DUAL_2PC operator 로컬 DE 고정', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    engineRegistryService.cleanupGroup(GROUP_ID);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as unknown as typeof fetch;
  });

  it('engineUrlOverride 제공 시 그 URL로 분석 요청함', async () => {
    // legacy 레이스 상황 재현 — 다른 DE가 단일 slot 점유
    engineRegistryService.register('http://legacy-race:5002', ENGINE_SECRET);

    await engineProxyService.analyzePipeline(
      GROUP_ID,
      [1, 2],
      undefined,
      undefined,
      false,
      'http://localhost:5002'
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:5002/api/analyze/pipeline',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('override 없으면 legacy getEngineUrl 사용함 (1-PC 호환)', async () => {
    engineRegistryService.register('http://legacy-race:5002', ENGINE_SECRET);

    await engineProxyService.analyzePipeline(GROUP_ID, [1, 2]);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://legacy-race:5002/api/analyze/pipeline',
      expect.objectContaining({ method: 'POST' })
    );
  });
});
