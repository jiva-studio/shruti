import { ApiProperty } from '@nestjs/swagger';
import * as protocol from '@shruti/protocol';
import { IsString } from 'class-validator';

/* -------------------------------------------------------------------------- */
/*                                   Common                                   */
/* -------------------------------------------------------------------------- */

export class ErrorResponse implements protocol.ErrorResponse {
  @ApiProperty({ example: 'error' })
  @IsString()
  error: string;

  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({ example: ['message'] })
  message: string[];
}
