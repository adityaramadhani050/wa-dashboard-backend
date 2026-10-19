import Redis from 'ioredis'
import { randomUUID } from 'crypto'

const url = process.env.UPSTASH_REDIS_URL

function makeRedis() {
  if (!url) return null
  const client = new Redis(url, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    lazyConnect: false,
    tls: url.startsWith('rediss://') ? {} : undefined,
  })
  client.on('error', err => console.warn('[Redis]', err.message))
  return client
}

// Two separate connections required for pub/sub
export const publisher = makeRedis()
export const subscriber = makeRedis()

// ID instance ini: pesan Redis dari instance sendiri diabaikan subscriber
// (instance ini sudah meng-emit langsung ke socket miliknya).
export const INSTANCE_ID = randomUUID()
export const REDIS_PREFIX = 'rt:'

// Teruskan event ke instance backend LAIN lewat Redis (bila ada). Selalu
// mengembalikan false agar pemanggil tetap meng-emit langsung ke socket lokal:
// event tidak hilang walau koneksi Redis/subscriber bermasalah, dan bila hanya
// ada satu instance Redis tidak diperlukan sama sekali.
export async function publish(channel, data) {
  if (publisher) {
    publisher.publish(REDIS_PREFIX + channel, JSON.stringify({ src: INSTANCE_ID, data }))
      .catch((e) => console.warn('[Redis] publish error:', e.message))
  }
  return false
}

export const redisAvailable = !!url
