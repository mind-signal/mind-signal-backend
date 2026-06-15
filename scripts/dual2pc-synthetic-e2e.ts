/* eslint-disable camelcase */
/**
 * dual2pc-synthetic-e2e.ts — DUAL_2PC 합성 E2E (레벨 2)
 *
 * 하드웨어/노트북 B 없이 1 PC에서 proxy:sample → BE publish → Redis subject:2
 * broadcast 경로를 실증함. 가짜 DE_B가 합성 envelope을 송신하고 별도 구독자가
 * 채널 broadcast를 카운트함.
 *
 * 전제: BE dev 기동(:5000) + npm run infra:up(Redis). CI 대상 아님.
 * 실행: npm run e2e:synthetic
 */

import { io } from 'socket.io-client';
import { createClient } from 'redis';
import { config } from '@07-shared/config/config';

const GROUP_ID = 'synthetic-grp';
const SUBJECT_IDX = 2;
const SAMPLE_COUNT = 5;
const CHANNEL = `mind-signal:${GROUP_ID}:subject:${SUBJECT_IDX}`;

async function main(): Promise<void> {
  let received = 0;
  const sub = createClient({ url: config.redis.url });
  await sub.connect();
  await sub.subscribe(CHANNEL, (msg: string) => {
    const parsed = JSON.parse(msg);
    if (parsed.type === 'brain_sync_all') received += 1;
    console.log(`[recv] ${CHANNEL} type=${parsed.type} count=${received}`);
  });

  const socket = io(`http://localhost:${config.port}/proxy`, {
    transports: ['websocket'],
    auth: { engineSecret: config.dataEngine.secretKey },
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });

  for (let seq = 0; seq < SAMPLE_COUNT; seq += 1) {
    const envelope = {
      group_id: GROUP_ID,
      subject_idx: SUBJECT_IDX,
      de_ts_ns: String(Date.now() * 1_000_000),
      proxy_ingress_ts_ns: String(Date.now() * 1_000_000),
      seq,
      payload: { delta: seq, theta: 0, alpha: 0, beta: 0, gamma: 0 },
      sync_meta: {},
    };
    const ack: { ok: boolean; retryable?: boolean; error?: string } =
      await socket.timeout(2_000).emitWithAck('proxy:sample', envelope);
    console.log(`[send] seq=${seq} ack=${JSON.stringify(ack)}`);
    // ack 거부 시 조기 종료함 - count 불일치보다 명확한 신호
    if (!ack.ok) {
      console.error(`FAIL: seq=${seq} ack 거부됨`, ack);
      socket.disconnect();
      await sub.quit();
      process.exit(1);
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  socket.disconnect();
  await sub.quit();

  if (received === SAMPLE_COUNT) {
    console.log(`PASS: ${received}/${SAMPLE_COUNT} broadcast on ${CHANNEL}`);
    process.exit(0);
  } else {
    console.error(`FAIL: ${received}/${SAMPLE_COUNT} received`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
