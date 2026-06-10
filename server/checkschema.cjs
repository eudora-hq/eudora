const Database = require('better-sqlite3');
const db = new Database('eudora.db');
const cols = db.prepare('PRAGMA table_info(agents)').all();
console.log('agents columns:', cols.map(c => c.name));
