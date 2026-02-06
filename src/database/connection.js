const logger = require('../utils/logger');

// Support both PostgreSQL and MySQL
const DB_TYPE = process.env.DB_TYPE || 'postgresql'; // 'postgresql' or 'mysql'

let pool;

if (DB_TYPE === 'mysql') {
  const mysql = require('mysql2/promise');
  pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3306,
    database: process.env.DB_NAME || 'wttt',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 0,
    charset: 'utf8mb4'
  });
} else {
  const { Pool } = require('pg');
  pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'wttt',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
}

// Handle pool errors
pool.on('error', (err) => {
  logger.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Query helper with logging
const query = async (text, params) => {
  const start = Date.now();
  try {
    let res;
    if (DB_TYPE === 'mysql') {
      // Convert PostgreSQL-style $1, $2 placeholders to MySQL ? placeholders
      let mysqlText = text;
      if (params && params.length > 0 && text.includes('$')) {
        // Replace $1, $2, etc. with ?
        mysqlText = text.replace(/\$(\d+)/g, '?');
      }
      // Use query instead of execute - execute is too strict for dynamic queries
      const [rows, fields] = await pool.query(mysqlText, params || []);
      // For MySQL: SELECT returns array, UPDATE/INSERT/DELETE returns object with affectedRows
      const isArray = Array.isArray(rows);
      res = {
        rows: rows,
        rowCount: isArray ? rows.length : (rows.affectedRows || 0),
        fields: fields
      };
    } else {
      res = await pool.query(text, params);
    }
    const duration = Date.now() - start;
    logger.debug('Executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    logger.error('Query error', { text, error: error.message, params });
    throw error;
  }
};

// Transaction helper
const transaction = async (callback) => {
  if (DB_TYPE === 'mysql') {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await callback(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
};

module.exports = {
  query,
  transaction,
  pool,
  end: async () => {
    if (DB_TYPE === 'mysql') {
      await pool.end();
    } else {
      await pool.end();
    }
  }
};

