import express, { Express } from 'express';
import path from 'path';

// public/ 는 BE 프로젝트 루트 기준임 (npm run dev / npm start 모두 cwd=mind-signal-backend).
// 대시보드 HTML을 같은 출처로 서빙해 /health 폴링 시 CORS를 회피함.
export function registerStatic(app: Express): void {
  app.use(express.static(path.join(process.cwd(), 'public')));
}
