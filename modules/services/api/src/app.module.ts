import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import {
  AuthConfig,
  CouchDbConfig,
  JwtConfig,
  MailerConfig,
  OtpConfig,
  RedisConfig,
  S3Config,
} from './configs';
import { ConfigModule } from '@nestjs/config';
import { BucketModule } from './bucket/bucket.module';
import { StatusModule } from './status/status.module';
import { AccountModule } from './account/account.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['/workspaces/shruti/data/.env.development'],
      load: [
        CouchDbConfig,
        OtpConfig,
        RedisConfig,
        JwtConfig,
        AuthConfig,
        MailerConfig,
        S3Config,
      ],
    }),
    AuthModule,
    BucketModule,
    StatusModule,
    AccountModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
