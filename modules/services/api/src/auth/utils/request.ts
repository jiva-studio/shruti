import { AccessToken } from '@shruti/protocol';
import { Request } from 'express';

export type ShrutiRequest = Request & {
  accessToken: AccessToken;
};
