import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { RevokedTokensService } from '@lectorium/api/auth/services';
import { LectoriumRequest } from '@lectorium/api/auth/utils';
import { JwtConfig } from '@lectorium/api/configs';
import { AccessToken } from '@lectorium/protocol';

@Injectable()
export class AuthenticatedUserGuard implements CanActivate {
  constructor(
    @Inject(JwtConfig.KEY)
    private readonly jwtConfig: ConfigType<typeof JwtConfig>,
    private readonly jwtService: JwtService,
    private readonly revokedTokensService: RevokedTokensService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<LectoriumRequest>();
    const token = this.extractTokenFromHeader(request);
    if (!token) {
      throw new UnauthorizedException();
    }

    try {
      // Verify the token and extract the payload
      const accessToken = await this.jwtService.verifyAsync<AccessToken>(
        token,
        {
          publicKey: this.jwtConfig.publicKey,
        },
      );

      // Check if the token has been revoked
      const isTokenRevoked =
        await this.revokedTokensService.isRevoked(accessToken);
      if (isTokenRevoked) {
        throw new UnauthorizedException();
      }
      request.accessToken = accessToken;
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }

  private extractTokenFromHeader(
    request: LectoriumRequest,
  ): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
