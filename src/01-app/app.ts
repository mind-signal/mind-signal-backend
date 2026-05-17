import http from 'http';
import express, { ErrorRequestHandler } from 'express';
import mongoose from 'mongoose';
import bodyParser from 'body-parser';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { specs } from '@07-shared/config/swagger';
import indexRouter from '@01-app/app.router';
import { config } from '@07-shared/config/config';
import { SocketService } from '@07-shared/lib/socket';
import { AuthProviderRegistry } from '@05-features/auth/services/providers/auth-provider.registry';
import { registerPairingTriggerListener } from '@01-app/startup-listeners';
import { registerProxyIngestNamespace } from '@02-processes/measurements/services/proxy-ingest.handler';

const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs));
app.use('/api', indexRouter);

// 전역 에러 핸들러에 ErrorRequestHandler 타입을 명시적으로 지정한다.
const globalErrorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  // 어떤 요청에서 에러가 났는지 req 객체를 이용해 로그를 남긴다.
  console.error(`[${req.method}] ${req.originalUrl} - ERROR: ${error.message}`);

  // AppError에 정의된 isOperational 속성을 확인하여 운영 오류인지 판단한다.
  if (error.isOperational) {
    // isOperational이 true인 경우, AppError에서 설정한 상태 코드와 메시지를 사용한다.
    return res.status(error.statusCode || 500).json({
      status: error.status || 'error',
      message: error.message,
    });
  }

  // 그 외의 예측하지 못한 에러는 500 서버 에러로 처리한다.
  console.error('UNEXPECTED ERROR', error);
  return res.status(500).json({
    status: 'error',
    message: '서버 내부에 예상치 못한 오류가 발생했습니다.',
  });
};

// 타입이 지정된 에러 핸들러를 등록한다.
app.use(globalErrorHandler);

async function connectDB() {
  try {
    const mongoURI = config.mongoUri;
    if (!mongoURI) {
      throw new Error(
        'MongoDB URI가 설정되지 않았습니다. (.env / config.ts 확인)'
      );
    }

    // Mongoose v8 기준 기본값을 사용하며 타임아웃만 명시한다.
    await mongoose.connect(mongoURI, {
      // 10초 내 연결 실패 시 에러
      serverSelectionTimeoutMS: 10_000,
    });

    console.log('MongoDB 연결 성공');

    // DUAL_2PC pairing + operator-join startup listener 등록함 (LD-23)
    registerPairingTriggerListener();

    // 소셜 인증 공급자 초기화
    AuthProviderRegistry.initialize();

    mongoose.connection.on('error', (err) => {
      console.error('MongoDB 연결 에러:', err);
    });

    const PORT = Number(config.port) || 5000;
    const server = http.createServer(app);
    SocketService.init(server);
    registerProxyIngestNamespace(); // Phase 18 T1-BE-G — /proxy 인그레스 네임스페이스 등록함
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`API running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('서버 시작 중 오류:', err);
    process.exit(1);
  }
}

connectDB();

export default app;
