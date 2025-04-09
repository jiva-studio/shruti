import { ApiProperty } from '@nestjs/swagger';
import * as protocol from '@lectorium/protocol';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsInt,
  Min,
} from 'class-validator';

export class SignUrlRequest implements protocol.S3SignedUrlRequest {
  @ApiProperty({ example: 'my-bucket' })
  @IsString()
  @IsNotEmpty()
  bucketName: string;

  @ApiProperty({ example: 'path/to/object.txt' })
  @IsString()
  @IsNotEmpty()
  key: string;

  @ApiProperty({ enum: protocol.S3Operation, example: 'getObject' })
  @IsEnum(protocol.S3Operation)
  @IsNotEmpty()
  operation: protocol.S3Operation;

  @ApiProperty({ example: 3600, required: false })
  @IsInt()
  @IsOptional()
  @Min(1)
  expiresIn?: number;
}

export class SignUrlResponse implements protocol.S3SignedUrlResponse {
  constructor(options?: { success?: boolean; signedUrl?: string }) {
    this.success = options?.success ?? true;
    this.signedUrl = options?.signedUrl ?? '';
  }

  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({ example: 'https://example.com/signed-url' })
  signedUrl: string;
}
