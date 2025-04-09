import { Module } from '@nestjs/common';
import { SignUrlController } from './controllers/sign-url.controller';
import { S3Service } from './services/s3.service';
import { RevokedTokensService } from '../auth/services';
import { RedisService } from '../shared/services';

@Module({
  controllers: [SignUrlController],
  providers: [S3Service, RevokedTokensService, RedisService],
})
export class BucketModule {}
