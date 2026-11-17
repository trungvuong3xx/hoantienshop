const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const hashes = JSON.parse(fs.readFileSync(path.join(__dirname, 'original-hashes.json')));
for (const [name, hash] of Object.entries(hashes)) {
  const current = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
  if (current !== hash) throw new Error(`Source changed during verification: ${name}; regenerate before applying.`);
}
for (const name of Object.keys(hashes)) {
  fs.copyFileSync(path.join(__dirname, path.basename(name)), path.join(root, name));
}
console.log('Applied verified startup optimization to four files.');
