import { Controller, Get, HttpCode } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Routes } from '@lectorium/protocol';

@Controller()
@ApiTags('🚦 Status')
export class StatusController {
  @Get(Routes().status.root())
  @HttpCode(200)
  @ApiOperation({
    summary: 'Get server status',
    operationId: 'status::get-status',
    description:
      `Retrieves the status of the server.\n\n` +
      `Returns the status of the server if the request is valid.`,
  })
  getStatus() {
    return { status: 'ok' };
  }
}
