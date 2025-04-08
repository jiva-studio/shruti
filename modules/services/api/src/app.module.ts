import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import {
  AuthConfig,
  CouchDbConfig,
  JwtConfig,
  MailerConfig,
  OtpConfig,
  RedisConfig,
} from './configs';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        CouchDbConfig,
        OtpConfig,
        RedisConfig,
        JwtConfig,
        AuthConfig,
        MailerConfig,
      ],
    }),
    AuthModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
