import dotenv from 'dotenv';
import path from 'path';

// 1. 환경별 .env 파일 로드 (.env.local, .env.development, .env.test 등)
const nodeEnv = process.env.NODE_ENV || 'local';
const envPath = path.resolve(__dirname, `../../../.env.${nodeEnv}`);
dotenv.config({ path: envPath });

// 2. 필수 환경변수 목록 정의
const REQUIRED_ENV_VARS = [
  'MONGODB_URI',
  'JWT_SECRET_KEY',
  'JWT_EXPIRES_IN',
  //'GOOGLE_API_KEY',
  //'GEMINI_API_KEY',
];

// 3. 누락된 환경변수 검사 (production/staging 환경에서 특히 중요)
if (nodeEnv !== 'test') {
  REQUIRED_ENV_VARS.forEach((key) => {
    if (!process.env[key]) {
      throw new Error(
        `Critical Error: 환경변수 ${key}가 설정되지 않았습니다. (.env.${nodeEnv} 확인)`
      );
    }
  });
}

// 3.5 강제 페어링 admin allowlist — env ADMIN_EMAILS 콤마 구분, lowercase normalize함
const adminEmails: readonly string[] = (process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// production 환경에서 ADMIN_EMAILS 누락 시 startup fail-fast 처리함
if (nodeEnv === 'production' && adminEmails.length === 0) {
  throw new Error(
    'Critical Error: ADMIN_EMAILS 환경변수가 production에서 설정되지 않았습니다.'
  );
}

// 4. 설정 객체 내보내기
export const config = {
  env: nodeEnv,
  port: parseInt(process.env.PORT || '5000', 10),
  mongoUri: process.env.MONGODB_URI as string,
  googleApiKey: process.env.GOOGLE_API_KEY as string,
  geminiApiKeys: [
    process.env.GOOGLE_API_KEY1 as string,
    process.env.GOOGLE_API_KEY2 as string,
    process.env.GOOGLE_API_KEY3 as string,
  ],

  jwtSecret: {
    secret: process.env.JWT_SECRET_KEY as string,
    expiresIn: process.env.JWT_EXPIRES_IN as string,
  },
  isProduction: nodeEnv === 'production',
  redis: {
    url:
      process.env.REDIS_URL ||
      `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`,
  },
  dataEngine: {
    // 환경 변수에서 가져오되, 없을 경우를 대비해 기본값을 설정할 수 있습니다.
    path: path.resolve(
      process.env.DATA_ENGINE_PATH || '../mind-signal-data-engine'
    ),
    // 데이터 엔진 베이스 url
    baseUrl: process.env.DATA_ENGINE_URL || 'http://localhost:5002',
    // conda 환경 Python 실행 파일 경로 (기본값: 시스템 python)
    pythonBin: process.env.DATA_ENGINE_PYTHON ?? 'python',
    secretKey: process.env.ENGINE_SECRET_KEY || 'change-me-in-production',
  },
  // 소셜 로그인 OAuth 설정 (선택적 환경변수)
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI,
  kakaoClientId: process.env.KAKAO_CLIENT_ID,
  kakaoClientSecret: process.env.KAKAO_CLIENT_SECRET,
  kakaoRedirectUri: process.env.KAKAO_REDIRECT_URI,
  // K phase 강제 페어링 admin allowlist — lowercase normalize됨
  adminEmails,
  // ADR-011 MongoDB SRV DNS resolver fallback — env 비어 있으면 OS 기본 경로 유지
  // 값 있으면 mongoose.connect 직전에 dns.setServers 호출함 (Node c-ares OS DNS 미감지 우회용)
  mongoSrvDnsServers: process.env.MONGODB_SRV_DNS_SERVERS
    ? process.env.MONGODB_SRV_DNS_SERVERS.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined,
  // Phase 16 DUAL_2PC 타임스탬프 정렬 설정 (optional — 기본값 사용 가능)
  dualPc: {
    // plan-review M-4: 편도 50ms + NTP skew 50ms = 200ms 기본값
    timestampToleranceMs: Number(
      process.env.DUAL_2PC_TIMESTAMP_TOLERANCE_MS ?? 200
    ),
    registrationTimeoutMs: Number(
      process.env.DUAL_2PC_REGISTRATION_TIMEOUT_MS ?? 60000
    ),
  },
} as const; // 읽기 전용으로 설정

console.log(`현재 구동 환경: ${config.env}`);
// DB 자격증명은 환경 무관 마스킹함 — local 로그도 터미널·CI·전사 transcript에 평문 유출 위험 있음.
// null-safe — test/CI는 MONGODB_URI 미설정(.env.test gitignore) + NODE_ENV=test로 required-env 검사 skip이라
// config.mongoUri가 undefined일 수 있음. unconditional .replace는 모듈 로드 시점 TypeError 유발함.
console.log(
  `연결된 DB URI: ${
    config.mongoUri
      ? config.mongoUri.replace(/:([^@]+)@/, ':***@')
      : '(MONGODB_URI 미설정)'
  }`
);
