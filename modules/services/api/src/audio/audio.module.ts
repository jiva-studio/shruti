import { Module } from '@nestjs/common';
import { AudioSegmentController } from './controllers/audio-segment.controller';
import { AudioProcessingService, AudioS3Service } from './services';
import { RevokedTokensService } from '../auth/services';
import { RedisService } from '../shared/services';

@Module({
  controllers: [AudioSegmentController],
  providers: [
    AudioProcessingService,
    AudioS3Service,
    RevokedTokensService,
    RedisService,
  ],
})
export class AudioModule {}
