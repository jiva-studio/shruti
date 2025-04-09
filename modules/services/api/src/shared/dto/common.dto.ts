import { ApiProperty } from '@nestjs/swagger';
import * as protocol from '@lectorium/protocol';
import { IsString } from 'class-validator';

/* -------------------------------------------------------------------------- */
/*                                   Common                                   */
/* -------------------------------------------------------------------------- */

export class ErrorResponse implements protocol.ErrorResponse {
  constructor(options?: {
    error?: string;
    statusCode?: number;
    message?: string[];
  }) {
    this.error = options?.error ?? 'error';
    this.statusCode = options?.statusCode ?? 400;
    this.message = options?.message ?? ['message'];
  }

  @ApiProperty({ example: 'error' })
  @IsString()
  error: string;

  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({ example: ['message'] })
  message: string[];
}
