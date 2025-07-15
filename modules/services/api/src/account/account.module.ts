import { Module } from '@nestjs/common';
import { AccountController } from './controllers/account.controller';
import { AuthUsersService, RevokedTokensService } from '../auth/services';
import { CouchDbService, RedisService } from '../shared/services';
import { AuthenticatedUserGuard } from '../auth/guards';
import { JwtService } from '@nestjs/jwt';

@Module({
  controllers: [AccountController],
  providers: [
    AuthUsersService,
    CouchDbService,
    AuthenticatedUserGuard,
    JwtService,
    RevokedTokensService,
    RedisService,
  ],
})
export class AccountModule {}
