import { createClient, RedisClientType } from 'redis';
import { config } from '@07-shared/config/config';
import { MemoryBusClient } from './memory-bus';

class RedisService {
  private static instance: RedisService;
  public client: RedisClientType;

  private constructor() {
    // MESSAGE_BUS=memory면 Redis 클라이언트를 만들지 않음 (연결 시도 0회).
    // 호출부가 쓰는 메서드만 구현한 프로세스 내부 버스로 대체하며, 호출부를
    // 두 모드에서 같게 유지하려고 RedisClientType으로 단언함
    if (config.messageBus === 'memory') {
      this.client = new MemoryBusClient() as unknown as RedisClientType;
      return;
    }

    // 2. process.env 대신 config 객체 사용 (REDIS_URL 우선, 없으면 HOST/PORT 폴백)
    const { url } = config.redis;

    this.client = createClient({ url });

    this.client.on('error', (err) => console.error('Redis Client Error', err));
    this.client.on('connect', () => console.log('Redis Client Connected'));
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
