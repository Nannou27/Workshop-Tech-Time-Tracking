const redis = require('redis');
const logger = require('./logger');

let client = null;

// Initialize Redis client
const initRedis = async () => {
  try {
    const redisConfig = {
      socket: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT) || 6379
      },
      database: parseInt(process.env.REDIS_DB) || 0
    };

    // Add password if provided
    if (process.env.REDIS_PASSWORD) {
      redisConfig.password = process.env.REDIS_PASSWORD;
    }

    // Enable TLS for AWS ElastiCache in production
    if (process.env.REDIS_TLS === 'true') {
      redisConfig.socket.tls = true;
    }

    client = redis.createClient(redisConfig);

    client.on('error', (err) => {
      logger.error('Redis Client Error:', err);
    });

    client.on('connect', () => {
      logger.info('Redis client connected');
    });

    await client.connect();
    return client;
  } catch (error) {
    logger.error('Redis connection failed:', error);
    // Return a mock client for development if Redis is not available
    return null;
  }
};

// Acquire distributed lock (simple implementation)
const acquireLock = async (key, ttl = 5000) => {
  if (!client) {
    logger.warn('Redis not available, lock acquisition skipped');
    return true; // Allow in development without Redis
  }

  try {
    const lockKey = `lock:${key}`;
    const result = await client.setNX(lockKey, '1');
    
    if (result) {
      await client.expire(lockKey, Math.floor(ttl / 1000));
      return true;
    }
    
    return false;
  } catch (error) {
    logger.error('Lock acquisition error:', error);
    return false;
  }
};

// Release distributed lock
const releaseLock = async (key) => {
  if (!client) {
    return;
  }

  try {
    const lockKey = `lock:${key}`;
    await client.del(lockKey);
  } catch (error) {
    logger.error('Lock release error:', error);
  }
};

// Get value from cache
const get = async (key) => {
  if (!client) return null;

  try {
    const value = await client.get(key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    logger.error('Redis get error:', error);
    return null;
  }
};

// Set value in cache
const set = async (key, value, ttl = 3600) => {
  if (!client) return;

  try {
    await client.setEx(key, ttl, JSON.stringify(value));
  } catch (error) {
    logger.error('Redis set error:', error);
  }
};

// Delete from cache
const del = async (key) => {
  if (!client) return;

  try {
    await client.del(key);
  } catch (error) {
    logger.error('Redis delete error:', error);
  }
};

module.exports = {
  initRedis,
  acquireLock,
  releaseLock,
  get,
  set,
  del,
  client: () => client
};






