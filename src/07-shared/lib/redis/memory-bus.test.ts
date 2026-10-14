/**
 * memory-bus.test.ts
 *
 * MESSAGE_BUS=memory일 때 redisService가 Redis에 연결하지 않고
 * 프로세스 내부에서 publish → subscribe 전달을 수행하는지 검증함.
 */

const mockConnect = jest.fn();
const mockCreateClient = jest.fn(() => ({
  connect: mockConnect,
  on: jest.fn(),
  isOpen: false,
}));

jest.mock('redis', () => ({ createClient: mockCreateClient }));

jest.mock('@07-shared/config/config', () => ({
  config: {
    messageBus: 'memory',
    redis: { url: 'redis://localhost:6379' },
  },
}));

import { redisService } from './redis';

const CHANNEL = 'mind-signal:g-mem:subject:1';

// 단언이 실패해도 구독이 다음 테스트로 넘어가지 않게, 만든 구독자를 모아
// afterEach에서 해제함. 모듈 수준 버스라 남은 핸들러가 다른 테스트의 전달 수를 바꿈.
const subscribers: Array<{ quit: () => Promise<unknown> }> = [];
function createSubscriber() {
  const subscriber = redisService.client.duplicate();
  subscribers.push(subscriber);
  return subscriber;
}

afterEach(async () => {
  await Promise.all(
    subscribers.splice(0).map((subscriber) => subscriber.quit())
  );
});

describe('MESSAGE_BUS=memory redisService', () => {
  it('Redis 클라이언트를 만들지도 connect를 호출하지도 않음', async () => {
    await redisService.connect();
    const subscriber = createSubscriber();
    await subscriber.connect();
    await redisService.client.publish(CHANNEL, 'x');
    await subscriber.quit();

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
    await expect(redisService.client.ping()).resolves.toBe('PONG');
  });

  it('publish한 메시지가 같은 채널 구독자에게만 전달됨', async () => {
    const received: string[] = [];
    const other: string[] = [];
    const subscriber = createSubscriber();
    const otherSubscriber = createSubscriber();
    await subscriber.subscribe(CHANNEL, (message: string) => {
      received.push(message);
    });
    await otherSubscriber.subscribe(
      'mind-signal:g-mem:subject:2',
      (message: string) => {
        other.push(message);
      }
    );

    const delivered = await redisService.client.publish(CHANNEL, 'hello');

    expect(delivered).toBe(1);
    expect(received).toEqual(['hello']);
    expect(other).toEqual([]);
    await subscriber.quit();
    await otherSubscriber.quit();
  });

  it('구독 해제 뒤에는 전달되지 않음', async () => {
    const received: string[] = [];
    const subscriber = createSubscriber();
    await subscriber.subscribe(CHANNEL, (message: string) => {
      received.push(message);
    });
    await redisService.client.publish(CHANNEL, 'before');

    await subscriber.unsubscribe(CHANNEL);
    await redisService.client.publish(CHANNEL, 'after');

    expect(received).toEqual(['before']);
  });

  it('quit은 채널 인자 없이 남은 구독을 전부 해제함', async () => {
    const received: string[] = [];
    const subscriber = createSubscriber();
    await subscriber.subscribe(CHANNEL, (message: string) => {
      received.push(message);
    });

    await subscriber.quit();

    await expect(redisService.client.publish(CHANNEL, 'after')).resolves.toBe(
      0
    );
    expect(received).toEqual([]);
  });

  it('pSubscribe는 패턴에 맞는 채널만 채널명과 함께 전달함', async () => {
    const received: Array<[string, string]> = [];
    const subscriber = createSubscriber();
    await subscriber.pSubscribe(
      'mind-signal:*',
      (message: string, channel: string) => {
        received.push([channel, message]);
      }
    );

    await redisService.client.publish(CHANNEL, 'in');
    await redisService.client.publish('other:channel', 'out');
    await subscriber.pUnsubscribe('mind-signal:*');
    await redisService.client.publish(CHANNEL, 'late');

    expect(received).toEqual([[CHANNEL, 'in']]);
  });

  it('구독자 예외가 발행자에게 번지지 않음', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const subscriber = createSubscriber();
    await subscriber.subscribe(CHANNEL, () => {
      throw new Error('boom');
    });

    await expect(redisService.client.publish(CHANNEL, 'x')).resolves.toBe(1);

    await subscriber.quit();
    errorSpy.mockRestore();
  });
});
