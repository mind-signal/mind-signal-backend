/* eslint-disable camelcase */
/**
 * memory-bus-synthetic-e2e.ts — MESSAGE_BUS=memory 합성 E2E
 *
 * Redis도 기동 중인 BE도 없이, 이 프로세스 안에 /proxy 네임스페이스를 올려
 * proxy:sample / proxy:status → 메모리 버스 → 채널 구독자 전달을 실증함.
 * 메모리 버스는 프로세스 밖에서 구독할 수 없어 dual2pc-synthetic-e2e.ts처럼
 * 외부 구독자로 확인하는 방식이 성립하지 않음.
 *
 * 전제: 없음 (임의의 빈 포트를 127.0.0.1에 엶). CI 대상 아님.
 * 실행: npm run e2e:synthetic:memory
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { io } from 'socket.io-client';
import { config } from '@07-shared/config/config';
import { redisService } from '@07-shared/lib/redis';
import { SocketService } from '@07-shared/lib/socket';

const GROUP_ID = `synthetic-grp-${Date.now()}`;
const SUBJECT_IDX = 2;
const SAMPLE_COUNT = 5;
const CHANNEL = `mind-signal:${GROUP_ID}:subject:${SUBJECT_IDX}`;

type Ack = { ok: boolean; retryable?: boolean; error?: string };

async function main(): Promise<void> {
  if (config.messageBus !== 'memory') {
    console.error('FAIL: MESSAGE_BUS=memory로 실행해야 함');
    process.exit(1);
  }

  let samples = 0;
  let statuses = 0;
  const sub = redisService.client.duplicate();
  await sub.connect();
  await sub.subscribe(CHANNEL, (msg: string) => {
    const parsed = JSON.parse(msg) as { type?: string };
    if (parsed.type === 'brain_sync_all') samples += 1;
    if (parsed.type === 'headset_status') statuses += 1;
  });

  const server = http.createServer();
  SocketService.init(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const socket = io(`http://127.0.0.1:${port}/proxy`, {
    transports: ['websocket'],
    auth: { engineSecret: config.dataEngine.secretKey },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });

  const acks: Ack[] = [];
  for (let seq = 0; seq < SAMPLE_COUNT; seq += 1) {
    acks.push(
      await socket.timeout(2_000).emitWithAck('proxy:sample', {
        group_id: GROUP_ID,
        subject_idx: SUBJECT_IDX,
        payload: { delta: seq, theta: 0, alpha: 0, beta: 0, gamma: 0 },
      })
    );
  }
  acks.push(
    await socket.timeout(2_000).emitWithAck('proxy:status', {
      group_id: GROUP_ID,
      subject_idx: SUBJECT_IDX,
      status: 'disconnected',
      silent_seconds: 3,
    })
  );

  socket.disconnect();
  await sub.quit();

  const passed =
    acks.every((ack) => ack.ok) && samples === SAMPLE_COUNT && statuses === 1;
  const summary =
    `samples=${samples}/${SAMPLE_COUNT} status=${statuses}/1 ` +
    `acks_ok=${acks.filter((ack) => ack.ok).length}/${acks.length}`;
  if (passed) console.log(`PASS: ${summary} on ${CHANNEL} (redis 미사용)`);
  else console.error(`FAIL: ${summary}`);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
