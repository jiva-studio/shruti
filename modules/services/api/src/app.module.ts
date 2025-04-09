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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['/workspaces/lectorium/data/.env.development'],
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
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
