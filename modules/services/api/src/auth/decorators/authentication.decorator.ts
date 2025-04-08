import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import {
  UserAuthentication,
  ShrutiRequest,
} from '@shruti/api/auth/utils';

export const Authentication = createParamDecorator(
  (data, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<ShrutiRequest>();
    return new UserAuthentication(request.accessToken);
  },
);
