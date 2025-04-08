import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { useContainer } from 'class-validator';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // TODO Use on development environment only
  const config = new DocumentBuilder()
    .setTitle('Lectroium')
    .setDescription(`The Lectorium API`)
    .setVersion('1.0') // TODO Use version from package.json
    .setContact('AKd Studios', 'https://github.com/akdasa-studios/', '')
    .addBearerAuth()
    .addTag('🎟️ Authentication :: One-Time Password')
    .addTag('🔐 Authentication', 'Endpoints for authentication')
    .addServer('http://localhost:8001', 'Development server')
    .addServer('https://api.lectorium.com', 'Production server')
    .build();
  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('swagger', app, documentFactory);
  useContainer(app.select(AppModule), { fallbackOnErrors: true });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  /* -------------------------------------------------------------------------- */
  /*                                    Cors                                    */
  /* -------------------------------------------------------------------------- */

  // TODO: configure CORS via environment variables
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // TODO Change environment variable to LECTORIUM_API_PORT
  await app.listen(process.env.LECTORIUM_API_PORT ?? 8001);
}
bootstrap();
