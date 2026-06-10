const Database = require('better-sqlite3');
const db = new Database('eudora.db');
const agent = db.prepare("SELECT id, name, status, created_at, proxy_key_encrypted FROM agents WHERE name = 'test-langchain-agent'").get();
console.log('created_at:', agent.created_at);
console.log('has encrypted key:', !!agent.proxy_key_encrypted);
console.log('encrypted key length:', agent.proxy_key_encrypted?.length);
