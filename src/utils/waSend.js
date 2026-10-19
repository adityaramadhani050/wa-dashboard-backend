import { randomBytes } from 'crypto';
import { markBotMessageId } from '../services/regionalBot.js';

// Kirim pesan yang barisnya disimpan sendiri oleh pemanggil (route kirim pesan,
// broadcast). ID pesan dibuat & didaftarkan SEBELUM dikirim, sehingga salinan
// (echo) dari WhatsApp yang bisa datang lebih dulu — mis. selagi media masih
// diunggah ke storage — tidak ikut disimpan dan pesan tidak tampil dobel.
export function sendOwned(sock, jid, content, opts = {}) {
  const messageId = '3EB0' + randomBytes(9).toString('hex').toUpperCase();
  markBotMessageId(messageId);
  return sock.sendMessage(jid, content, { ...opts, messageId });
}
