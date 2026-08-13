import { oldUserDatabase } from "../fixtures/oldUserDatabase.js"
import { world } from "../src/world.js"

/**
 * What the migration chain MEANS is unit-tested (`infra/persistence/migrations`);
 * what no unit test can show is that it runs through
 * `@capacitor-community/sqlite` on the device's own SQLite. So: put a database
 * of an older schema in the app's data dir, launch the current build, and
 * compare the result with the reference run `fixtures/makeUserDb.ts` recorded
 * on this machine's engine — schema, migration ledger, and the rows, including
 * the ones migration 027 folds.
 *
 * A bug the migrations share on both engines is invisible here by construction;
 * this spec answers "did they run, and did they survive the crossing", not
 * "are they right".
 */
describe("an older database is migrated on the device", () => {
  const { app, userDb, screens } = world()
  const fixture = oldUserDatabase()

  before(async () => {
    // The app owns the file while it runs, and the build's own database is
    // already there from the install — stop it before swapping the file in.
    await app.forceStop()
    await userDb.install(fixture.databasePath)
    await app.launch()
  })

  it("opens into the library, not onboarding", async () => {
    // A database with listening history is an established user; reaching the
    // tabs at all means the migrated schema is readable by the app.
    await screens.tabs.waitUntilVisible()
    expect(await screens.onboarding.isVisible()).toBe(false)
  })

  describe("the database left on disk", () => {
    before(async () => {
      // Read the file, not the connection the app still holds open.
      await app.forceStop()
    })

    it("records every migration the fixture had not seen", async () => {
      const applied = await userDb.appliedMigrations()
      expect(fixture.pending.filter((name) => !applied.includes(name))).toEqual([])
      expect(applied).toEqual([...fixture.expected.migrations])
    })

    it("builds the schema the reference run produced", async () => {
      const tables = await userDb.tables()
      const expected = Object.entries(fixture.expected.tables)
      expect(expected.map(([table]) => table).filter((table) => !tables.includes(table))).toEqual([])
      for (const [table, columns] of expected) {
        expect(await userDb.columnsOf(table)).toEqual([...columns])
      }
    })

    it("creates the indexes the migrations declare", async () => {
      const indexes = await userDb.indexes()
      expect(fixture.expected.indexes.filter((name) => !indexes.includes(name))).toEqual([])
    })

    it("keeps the rows the older database carried", async () => {
      for (const [table, rows] of Object.entries(fixture.expected.rows)) {
        const columns = Object.keys(rows[0] ?? {})
        expect(await userDb.rows(table, columns)).toEqual([...rows])
      }
    })

    it("keeps the settings the older database carried", async () => {
      const config = await userDb.rows("config", ["key", "value"])
      for (const entry of fixture.expected.configEntries) {
        expect(config).toContainEqual({ ...entry })
      }
    })
  })
})
