import { ApiProperty } from '@nestjs/swagger';
import * as protocol from '@lectorium/protocol';
import { IsNotEmpty, IsString, IsNumber, Min } from 'class-validator';

export class AudioSegmentRequest implements protocol.AudioSegmentRequest {
  @ApiProperty({ example: 'library/tracks/track-123/audio/original.mp3' })
  @IsString()
  @IsNotEmpty()
  filePath: string;

  @ApiProperty({ example: 30.5 })
  @IsNumber()
  @Min(0)
  timeStart: number;

  @ApiProperty({ example: 90.5 })
  @IsNumber()
  @Min(0)
  timeEnd: number;
}

export class AudioSegmentUrlResponse implements protocol.AudioSegmentResponse {
  constructor(options: { signedUrl: string }) {
    this.signedUrl = options.signedUrl;
  }

  @ApiProperty({
    example:
      'https://s3.example.com/bucket/notes/a1b2c3d4e5f6789012345678901234567890123456789012345678901234567890.mp3?signature=...',
    description: 'Signed URL to download the audio segment',
  })
  signedUrl: string;
}
