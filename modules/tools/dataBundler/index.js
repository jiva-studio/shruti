const fs = require('fs')
var PouchDB = require('pouchdb')
  .plugin(require('pouchdb-adapter-node-websql'))
  .plugin(require('pouchdb-find'))

const baseUri  = process.env.DATABASE_URI
const databases = [
  'dictionary',
  'tracks',
  'index',
]

const tasks = databases.map(database => new Promise(async () => {
  // Remove file if it exists
  const path = `./artifacts/${database}.db`;
  if (fs.existsSync(path)) {
    console.log(`Removing ${database}...`)
    fs.unlinkSync(path);
  }

  // Create the database
  console.log(`Processing ${database}...`)
  const inputDB  = new PouchDB(`${baseUri}${database}`)
  const outputDB = new PouchDB(`./artifacts/${database}.db`, { adapter: 'websql' })

  if (database === 'tracks') {
    console.log('Creating "sort_reference" index ...')
    await outputDB.createIndex({ 
      index: { name: 'sort_reference', fields: ['sort_reference'] },
    })

    console.log('Creating "sort_date" index ...')
    await outputDB.createIndex({ 
      index: { name: 'sort_date', fields: ['sort_date'] },
    })
  }

  // Replicate the database
  console.log(`Replicating ${database}...`)
  await inputDB.replicate.to(
    outputDB, {
      filter: (doc) => !doc._id.startsWith('_')
    }
  )

  // Populate index
  if (database === "tracks") {
    await outputDB.find({
      selector: { sort_reference: { $gte: null } },
      sort: ['sort_reference'],
      limit: 1
    });
    await outputDB.find({
      selector: { sort_date: { $gte: null } },
      sort: ['sort_date'],
      limit: 1
    });
  }
}))

Promise
  .all(tasks)
  .catch((e) => console.log(`Error: ${JSON.stringify(e)}`))
  .then(() => { console.log("Done...") })