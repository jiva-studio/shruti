import { ApiProperty } from '@nestjs/swagger';
import * as protocol from '@shruti/protocol';
import { IsNotEmpty, IsString, IsNumber, Min } from 'class-validator';

export class AudioSegmentRequest implements protocol.AudioSegmentRequest {
  @ApiProperty({ example: 'track-123' })
  @IsString()
  @IsNotEmpty()
  trackId: string;

  @ApiProperty({ example: 'original' })
  @IsString()
  @IsNotEmpty()
  audioType: string;

  @ApiProperty({ example: 30.5 })
  @IsNumber()
  @Min(0)
  timeStart: number;

  @ApiProperty({ example: 90.5 })
  @IsNumber()
  @Min(0)
  timeEnd: number;
}

export class AudioSegmentResponse implements protocol.AudioSegmentResponse {
  constructor(options?: { contentType?: string; contentLength?: number }) {
    this.contentType = options?.contentType ?? 'audio/mpeg';
    this.contentLength = options?.contentLength;
  }

  @ApiProperty({ example: 'audio/mpeg' })
  contentType: string;

  @ApiProperty({ example: 1024000, required: false })
  contentLength?: number;
}

export class AudioSegmentUrlResponse {
  constructor(options: { signedUrl: string }) {
    this.signedUrl = options.signedUrl;
  }

  @ApiProperty({
    example:
      'https://s3.example.com/bucket/notes/track-123_30.5_90.5_original.mp3?signature=...',
    description: 'Signed URL to download the audio segment',
  })
  signedUrl: string;
}
