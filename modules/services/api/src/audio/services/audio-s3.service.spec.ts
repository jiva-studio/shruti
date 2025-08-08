import { Test, TestingModule } from '@nestjs/testing';
import { AudioS3Service } from './audio-s3.service';
import S3Config from '../../configs/s3.config';

describe('AudioS3Service', () => {
  let service: AudioS3Service;

  beforeEach(async () => {
    const mockS3Config = {
      endpoint: 'https://test-endpoint.com',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      region: 'us-east-1',
      forcePathStyle: true,
      bucketName: 'test-bucket',
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AudioS3Service,
        {
          provide: S3Config.KEY,
          useValue: mockS3Config,
        },
      ],
    }).compile();

    service = module.get<AudioS3Service>(AudioS3Service);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return bucket name from config', () => {
    expect(service.getBucketName()).toBe('test-bucket');
  });
});
