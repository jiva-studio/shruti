import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import {
  UserAuthentication,
  LectoriumRequest,
} from '@lectorium/api/auth/utils';

export const Authentication = createParamDecorator(
  (data, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<LectoriumRequest>();
    return new UserAuthentication(request.accessToken);
  },
);
