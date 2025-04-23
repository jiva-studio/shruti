const fs = require('fs')
var PouchDB = require('pouchdb')
  .plugin(require('pouchdb-adapter-node-websql'))

const baseUri  = process.env.DATABASE_URI
const databases = [
  'dictionary',
  'tracks',
  'index',
]

for (const database of databases) {
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

  // Replicate the database
  inputDB.replicate.to(
    outputDB, {
      filter: (doc) => !doc._id.startsWith('_')
    }
  ).then((result) => {
    console.log("Replication succeeded:", result);
  }).catch((error) => {
    console.error("Replication failed:", error);
  });
}