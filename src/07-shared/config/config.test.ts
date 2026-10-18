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

  it('MEASUREMENT_EXPECTED_SECONDS 미설정이면 600초임 (SESSION-W008)', () => {
    delete process.env.MEASUREMENT_EXPECTED_SECONDS;

    expect(loadConfig().measurement.expectedSeconds).toBe(600);
  });

  it('MEASUREMENT_EXPECTED_SECONDS 값을 숫자로 읽음', () => {
    process.env.MEASUREMENT_EXPECTED_SECONDS = '90';

    expect(loadConfig().measurement.expectedSeconds).toBe(90);
  });

  it('MEASUREMENT_EXPECTED_SECONDS 가 숫자가 아니면 경고 후 600초로 폴백함', () => {
    process.env.MEASUREMENT_EXPECTED_SECONDS = 'ten';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(loadConfig().measurement.expectedSeconds).toBe(600);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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

  it.each(['150.5', 'abc', 'Infinity', '-5'])(
    'DUAL_2PC_TIMESTAMP_TOLERANCE_MS=%s면 기본 200ms로 대체하고 경고함 (EEG-W008)',
    (raw) => {
      // 비정수가 aligner 의 BigInt 변환까지 가면 setInterval 안에서 RangeError 로
      // 프로세스가 죽음
      process.env.DUAL_2PC_TIMESTAMP_TOLERANCE_MS = raw;
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      expect(loadConfig().dualPc.timestampToleranceMs).toBe(200);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    }
  );

  it('DUAL_2PC_TIMESTAMP_TOLERANCE_MS가 양의 정수면 그대로 씀', () => {
    process.env.DUAL_2PC_TIMESTAMP_TOLERANCE_MS = '150';

    expect(loadConfig().dualPc.timestampToleranceMs).toBe(150);
  });

  it('DUAL_2PC_REGISTRATION_TIMEOUT_MS가 숫자가 아니면 기본 60000ms로 대체하고 경고함', () => {
    process.env.DUAL_2PC_REGISTRATION_TIMEOUT_MS = 'abc';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(loadConfig().dualPc.registrationTimeoutMs).toBe(60000);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
