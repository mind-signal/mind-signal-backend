/**
 * config 모듈은 import 시점에 env를 읽으므로 매 케이스마다 모듈 캐시를 비우고
 * 다시 require 함. NODE_ENV=test라 .env.test만 로드되고 .env.local은 유입되지 않음
 */
describe('config — Bedrock 설정과 chat-only 가드', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const loadConfig = () =>
    require('./config').config as typeof import('./config').config;

  it('BEDROCK_INFERENCE_PROFILE_ID가 빈 문자열이면 모델 ID로 폴백함', () => {
    process.env.BEDROCK_INFERENCE_PROFILE_ID = '';
    process.env.BEDROCK_MODEL_ID = 'fallback-model-id';

    expect(loadConfig().bedrock.modelId).toBe('fallback-model-id');
  });

  it('BEDROCK_INFERENCE_PROFILE_ID가 있으면 그것을 우선함', () => {
    process.env.BEDROCK_INFERENCE_PROFILE_ID = 'profile-id';
    process.env.BEDROCK_MODEL_ID = 'fallback-model-id';

    expect(loadConfig().bedrock.modelId).toBe('profile-id');
  });

  it('production에서 CHAT_ONLY_MODE가 켜져 있으면 기동을 거부함', () => {
    process.env.NODE_ENV = 'production';
    process.env.CHAT_ONLY_MODE = 'true';

    expect(loadConfig).toThrow(/CHAT_ONLY_MODE/);
  });

  it.each(['abc', 'Infinity'])(
    'DUAL_2PC_SOLO_WAIT_MS=%s면 기본 1000ms로 대체하고 경고함',
    (raw) => {
      process.env.DUAL_2PC_SOLO_WAIT_MS = raw;
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      expect(loadConfig().dualPc.soloWaitMs).toBe(1000);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    }
  );

  it('DUAL_2PC_SOLO_WAIT_MS가 유한한 숫자면 그대로 씀', () => {
    process.env.DUAL_2PC_SOLO_WAIT_MS = '1500';

    expect(loadConfig().dualPc.soloWaitMs).toBe(1500);
  });
});
