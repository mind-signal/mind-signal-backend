/**
 * engine-proxy.service.ts — streamStop DUAL_2PC URL 해석 회귀 재현 (감사 fix_needed #3)
 *
 * fix 전: streamStop이 getEngineUrl()(legacy 단일 slot)만 사용 →
 *         DUAL_2PC는 registerDual만 호출되어 registeredEngineUrl=null →
 *         streamStop 시 503 throw. 본 테스트는 fix 전 RED.
 * fix 후: groupId+subjectIndex 등록(dualRegistry)이 있으면 그 URL을,
 *         없으면 legacy URL을 사용함.
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

const GROUP_ID = 'grp_streamstop_test';

describe('engineProxyService.streamStop — DUAL_2PC URL 해석', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    engineRegistryService.cleanupGroup(GROUP_ID);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'stopped' }),
    }) as unknown as typeof fetch;
  });

  it('DUAL_2PC 등록 시 subject별 dual URL로 stop 요청함', async () => {
    engineRegistryService.registerDual(
      GROUP_ID,
      1,
      'http://de1:5002',
      ENGINE_SECRET
    );
    engineRegistryService.registerDual(
      GROUP_ID,
      2,
      'http://de2:5002',
      ENGINE_SECRET
    );

    await engineProxyService.streamStop(GROUP_ID, 2);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://de2:5002/api/stream/stop',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('dual 등록 없으면 legacy 단일 slot URL로 폴백함', async () => {
    engineRegistryService.register('http://legacy:5002', ENGINE_SECRET);

    await engineProxyService.streamStop(GROUP_ID, 1);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://legacy:5002/api/stream/stop',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('dual group 존재하나 slot 없으면 503 throw함', async () => {
    // subject 1만 등록 — subject 2 slot 없음
    engineRegistryService.registerDual(
      GROUP_ID,
      1,
      'http://de1:5002',
      ENGINE_SECRET
    );

    await expect(
      engineProxyService.streamStop(GROUP_ID, 2)
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
