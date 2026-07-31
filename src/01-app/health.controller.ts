import { RequestHandler } from 'express';
import { redisService } from '@07-shared/lib/redis';

const PEERS: { name: string; url: string }[] = [
  { name: 'data-engine-A', url: 'http://localhost:5002/health' },
  { name: 'proxy', url: 'http://localhost:5050/health' },
  { name: 'frontend', url: 'http://localhost:3000' },
  ...(process.env.NOTEBOOK_B_URL
    ? [{ name: 'data-engine-B', url: `${process.env.NOTEBOOK_B_URL}/health` }]
    : []),
];

async function ping(url: string): Promise<'up' | 'down'> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

async function checkRedis(): Promise<'ok' | 'down'> {
  try {
    await redisService.connect();
    await redisService.client.ping();
    return 'ok';
  } catch {
    return 'down';
  }
}

// 대시보드용 집계 헬스체크. redis ping + 각 서비스 reachability를 서버사이드로 모아
// 단일 응답으로 반환함 (대시보드는 BE 한 곳만 폴링 -> CORS 불필요).
export const healthCheck: RequestHandler = async (_req, res) => {
  const [redis, entries] = await Promise.all([
    checkRedis(),
    Promise.all(PEERS.map(async (p) => [p.name, await ping(p.url)] as const)),
  ]);
  res.status(200).json({
    status: 'success',
    data: { redis, services: Object.fromEntries(entries) },
  });
};
