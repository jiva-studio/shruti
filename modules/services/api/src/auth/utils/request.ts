import { AccessToken } from '@lectorium/protocol';
import { Request } from 'express';

export type LectoriumRequest = Request & {
  accessToken: AccessToken;
};
