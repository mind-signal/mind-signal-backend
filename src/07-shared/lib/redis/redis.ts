import { createClient } from 'redis';
import { config } from '@07-shared/config/config';
import { MemoryBusClient } from './memory-bus';
import type { BusClient } from './message-bus.types';

class RedisService {
  private static instance: RedisService;
  public client: BusClient;

  private constructor() {
    // MESSAGE_BUS=memory면 Redis 클라이언트를 만들지 않음 (연결 시도 0회).
    // 호출부가 쓰는 메서드만 구현한 프로세스 내부 버스로 대체하며, 호출부를
    // 두 모드에서 같게 유지함. 두 구현 모두 BusClient를 만족함
    if (config.messageBus === 'memory') {
      this.client = new MemoryBusClient();
      return;
    }

    // 2. process.env 대신 config 객체 사용 (REDIS_URL 우선, 없으면 HOST/PORT 폴백)
    const { url } = config.redis;

    // on()은 BusClient에 없는 Redis 전용 동작이라 구체 타입 변수로 등록함
    const client = createClient({ url });

    client.on('error', (err) => console.error('Redis Client Error', err));
    client.on('connect', () => console.log('Redis Client Connected'));

    this.client = client;
  }

  /**
   * RedisService 인스턴스를 반환 (싱글톤)
   * @returns {RedisService}
   */
  public static getInstance(): RedisService {
    if (!RedisService.instance) {
      RedisService.instance = new RedisService();
    }
    return RedisService.instance;
  }

  /**
   * Redis 서버에 연결 시도
   */
  public async connect(): Promise<void> {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
  }

  /**
   * Redis 연결 종료
   */
  public async disconnect(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.disconnect();
    }
  }
}

export const redisService = RedisService.getInstance();
