import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { RedisConfig } from '@lectorium/api/configs';
import Redis from 'ioredis';

@Injectable()
export class RedisService {
  private readonly redis: Redis;
  private readonly logger = new Logger(RedisService.name);

  constructor(
    @Inject(RedisConfig.KEY)
    config: ConfigType<typeof RedisConfig>,
  ) {
    this.logger.log('Starting Redis service...');
    this.redis = new Redis({
      host: config.host,
      port: config.port,
    });
  }

  async get(key: string): Promise<string | null> {
    return await this.redis.get(key);
  }

  async set(key: string, value: string, seconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', seconds);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.redis.exists(key)) === 1;
  }

  async ttl(key: string): Promise<number> {
    return await this.redis.ttl(key);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
