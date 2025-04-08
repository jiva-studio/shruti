import * as protocol from '@lectorium/protocol';

export class UserAuthentication {
  constructor(private readonly _accessToken: protocol.AccessToken) {}

  /**
   * Get user Id
   * @returns User Id
   */
  get userId() {
    return this._accessToken.sub;
  }

  /**
   * Get user access token
   * @returns Access token
   */
  get accessToken() {
    return this._accessToken;
  }
}

export class AuthenticatedUserPermissions {
  constructor() {}
}
