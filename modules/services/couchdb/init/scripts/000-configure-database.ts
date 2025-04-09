import fs from 'fs'
import { Migration } from './Migration'

export class ConfigureDatabase extends Migration {
  get name(): string { return 'Configure database' }

  async shouldMigrate(): Promise<boolean> {
    return true
  }

  async migrate(): Promise<void> {
    const jwtPublicKeyPath = '/etc/lectorium/keys/jwt_public_key.pem';
    const jwtPublicKey     = fs.readFileSync(jwtPublicKeyPath, 'utf8');

    const keys = [
      { key: 'httpd/enable_cors', value: 'true' },
      { key: 'cors/origins',      value: '*' },
      { key: 'cors/credentials',  value: 'true' },
      { key: 'cors/headers',      value: 'accept, authorization, content-type, origin, referer' },
      { key: 'cors/methods',      value: 'GET, PUT, POST, HEAD, DELETE, OPTIONS' },
      {
        key: 'chttpd/admin_only_all_dbs',
        value: 'false'
      },
      {
        key: 'chttpd/authentication_handlers',
        value: "{chttpd_auth, cookie_authentication_handler}, {chttpd_auth, jwt_authentication_handler}, {chttpd_auth, default_authentication_handler}"
      },
      {
        key: 'jwt_keys/rsa:_default',
        value: jwtPublicKey.replace(/\n/g, '\\n')
      },
      {
        key: 'jwt_auth/roles_claim_path',
        value: 'roles'
      },
      { key: 'couchdb/single_node', value: 'true' },
    ]

    for (const { key, value } of keys) {
      await this.server.request({
        db: '_node',
        path: `/nonode@nohost/_config/${key}`,
        method: 'PUT',
        body: value
      })
    }
  }

  async revert(): Promise<void> {
  }
}
