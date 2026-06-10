const { createDecipheriv } = require('crypto');
const Database = require('better-sqlite3');

process.env.ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

const db = new Database('eudora.db');
const agent = db.prepare("SELECT proxy_key_encrypted, proxy_key_iv FROM agents WHERE name = 'test-langchain-agent'").get();

console.log('iv:', agent.proxy_key_iv);
console.log('encrypted:', agent.proxy_key_encrypted);

// Try manual decrypt matching your encryption.js implementation
try {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv = Buffer.from(agent.proxy_key_iv, 'hex');
  const encrypted = Buffer.from(agent.proxy_key_encrypted, 'hex');
  const authTag = encrypted.slice(-16);
  const ciphertext = encrypted.slice(0, -16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  console.log('decrypted key:', decrypted.toString());
} catch (e) {
  console.log('decrypt failed:', e.message);
}
