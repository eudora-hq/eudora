const Database = require('better-sqlite3');
const db = new Database('eudora.db');
const agent = db.prepare("SELECT id, name, agent_type, status FROM agents WHERE name = 'test-langchain-agent'").get();
console.log(agent);
