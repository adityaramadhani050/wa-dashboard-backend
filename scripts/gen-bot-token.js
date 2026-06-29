// Generate JWT statis (tanpa kedaluwarsa) untuk integrasi mesin-ke-mesin,
// mis. bot notifikasi WA yang memanggil API backend ini.
//
// PENTING: token ditandatangani dengan JWT_SECRET yang SAMA dengan server.
// Jalankan di lingkungan yang punya env JWT_SECRET (mis. Railway shell) ATAU
// set JWT_SECRET di terminal sebelum menjalankan. Token berlaku selamanya
// (tidak ada klaim `exp`) — perlakukan seperti password.
//
// Pakai:
//   JWT_SECRET=xxxx node scripts/gen-bot-token.js
//   JWT_SECRET=xxxx node scripts/gen-bot-token.js --name "Bot Notif" --role admin --id bot-notif
//
// Cabut/rotasi: ganti JWT_SECRET di server -> semua token lama (termasuk ini)
// otomatis tidak valid.

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('ERROR: env JWT_SECRET belum di-set. Set dulu, contoh:');
  console.error('  JWT_SECRET="<secret-yang-sama-dengan-server>" node scripts/gen-bot-token.js');
  process.exit(1);
}
if (JWT_SECRET === 'dev-insecure-secret-change-me') {
  console.warn('PERINGATAN: memakai JWT_SECRET default dev. Token tidak aman untuk produksi.\n');
}

// Argumen opsional
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const payload = {
  id: getArg('--id', 'bot-notif-wa'),
  username: getArg('--username', 'bot-notif-wa'),
  name: getArg('--name', 'Bot Notif WA'),
  role: getArg('--role', 'admin'), // admin agar lolos requireAdmin juga
  type: 'service',                 // penanda token mesin (bukan user login)
};

// Tanpa `expiresIn` => token tidak pernah kedaluwarsa
const token = jwt.sign(payload, JWT_SECRET);

console.log('\nPayload :', JSON.stringify(payload));
console.log('\nJWT Token (statis, tanpa kedaluwarsa):\n');
console.log(token);
console.log('\nPakai di header HTTP setiap request:');
console.log(`  Authorization: Bearer ${token}\n`);
