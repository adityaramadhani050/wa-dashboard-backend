import Redis from 'ioredis'

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

export async function publish(channel, data) {
  if (!publisher) return false
  try {
    await publisher.publish(channel, JSON.stringify(data))
    return true
  } catch (e) {
    console.warn('[Redis] publish error:', e.message)
    return false
  }
}

export const redisAvailable = !!url
