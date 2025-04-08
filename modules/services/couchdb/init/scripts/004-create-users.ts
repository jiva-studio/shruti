import { Migration } from './Migration'

export abstract class CreateUserMigration extends Migration {
  abstract get username(): string
  abstract get password(): string
  abstract get roles(): string[]

  get name(): string { return `Create ${this.username} user` }

  async shouldMigrate(): Promise<boolean> {
    try {
      const doc = await this.server.use("_users").get(`org.couchdb.user:${this.username}`)
      return false
    } catch (error) {
      return true
    }
  }

  async migrate(): Promise<void> {
    await this.server.use<any>("_users").insert({
      _id: `org.couchdb.user:${this.username}`,
      name: this.username,
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
  username = "contentManager";
  password = "contentManager";
  roles = ["contentManager"];
}
