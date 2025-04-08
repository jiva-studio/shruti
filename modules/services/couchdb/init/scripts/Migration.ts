import { ServerScope } from 'nano'

export interface IMigration {
  name: string
  shouldMigrate(): Promise<boolean>
  migrate(): Promise<void>
  revert(): Promise<void>
}

export abstract class Migration implements IMigration {
  constructor(protected readonly server: ServerScope) {}
  abstract name: string
  abstract shouldMigrate(): Promise<boolean>
  abstract migrate(): Promise<void>
  abstract revert(): Promise<void>
}
