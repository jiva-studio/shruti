import { Module } from '@nestjs/common';
import { SignUrlController } from './controllers/sign-url.controller';
import { S3Service } from './services/s3.service';

@Module({
  controllers: [SignUrlController],
  providers: [S3Service],
})
export class BucketModule {}
