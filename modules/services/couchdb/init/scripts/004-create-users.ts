import { Migration } from './Migration'

export abstract class CreateUserMigration extends Migration {
  abstract get email(): string
  abstract get password(): string
  abstract get roles(): string[]

  get name(): string { return `Create ${this.email} user` }

  async shouldMigrate(): Promise<boolean> {
    try {
      await this.server.use("_users").get(`org.couchdb.user:${this.email}`)
      return false
    } catch (error) {
      return true
    }
  }

  async migrate(): Promise<void> {
    await this.server.use<any>("_users").insert({
      _id: `org.couchdb.user:${this.email}`,
      name: this.email,
      password: this.password,
      roles: this.roles,
      type: "user"
    })
  }

  async revert(): Promise<void> {
    // await this.server.use("_users").destroy()
  }
}

export class CreateContentManagerUser extends CreateUserMigration {
  email    = process.env.LECTORIUM_CONTENT_MANAGER_EMAIL    ?? "content@manager.com";
  password = process.env.LECTORIUM_CONTENT_MANAGER_PASSWORD ?? "contentManager";
  roles    = ["contentManager"];
}
