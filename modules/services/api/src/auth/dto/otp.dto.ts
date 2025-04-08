import { ApiProperty } from '@nestjs/swagger';
import * as protocol from '@lectorium/protocol';
import { IsEnum, IsNotEmpty, IsString } from 'class-validator';

import { IsDestinationCorrect } from '../validations/destination.validation';

export class GetOtpRequest implements protocol.GetOtpRequest {
  @ApiProperty({ enum: protocol.OtpType, example: 'email' })
  @IsEnum(protocol.OtpType)
  @IsNotEmpty()
  type: protocol.OtpType;

  @ApiProperty({ example: 'example@example.com' })
  @IsString()
  @IsNotEmpty()
  @IsDestinationCorrect()
  destination: string;
}

export class GetOtpResponse implements protocol.GetOtpResponse {
  constructor(options?: { success?: boolean; message?: string }) {
    this.success = options?.success ?? true;
    this.message = this.success
      ? 'OTP has been sent'
      : (options?.message ?? 'Failed to send OTP');
  }

  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({ example: 'message' })
  message: string;
}
