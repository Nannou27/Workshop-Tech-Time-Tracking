const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// GET /api/v1/settings
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const { category } = req.query;
    const DB_TYPE = process.env.DB_TYPE || 'postgresql';

    // MySQL uses backticks for 'key' (reserved word), PostgreSQL doesn't need it
    const keyColumn = DB_TYPE === 'mysql' ? '`key`' : 'key';
    let queryText = `SELECT ${keyColumn} as key, value, description, category FROM system_settings`;
    const params = [];

    if (category) {
      queryText += ' WHERE category = ?';
      params.push(category);
    }

    queryText += ' ORDER BY category, ' + keyColumn;

    const result = await db.query(queryText, params);

    res.json({
      data: result.rows
    });
  } catch (error) {
    logger.error('Get settings error:', error);
    next(error);
  }
});

// PATCH /api/v1/settings/:key
router.patch('/:key',
  requireAdmin,
  [
    body('value').notEmpty()
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: errors.array()
          }
        });
      }

      const { key } = req.params;
      const { value } = req.body;
      const DB_TYPE = process.env.DB_TYPE || 'postgresql';
      const keyColumn = DB_TYPE === 'mysql' ? '`key`' : 'key';

      if (DB_TYPE === 'mysql') {
        await db.query(
          `UPDATE system_settings 
           SET value = ?, updated_at = NOW(), updated_by = ?
           WHERE ${keyColumn} = ?`,
          [JSON.stringify(value), req.user.id, key]
        );
        const result = await db.query(
          `SELECT ${keyColumn} as key, value, updated_at FROM system_settings WHERE ${keyColumn} = ?`,
          [key]
        );
        if (result.rows.length === 0) {
          return res.status(404).json({
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'Setting not found'
            }
          });
        }
        return res.json(result.rows[0]);
      } else {
        const result = await db.query(
          `UPDATE system_settings 
           SET value = $1, updated_at = now(), updated_by = $2
           WHERE key = $3
           RETURNING key, value, updated_at`,
          [JSON.stringify(value), req.user.id, key]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'Setting not found'
            }
          });
        }

        res.json(result.rows[0]);
      }

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: 'Setting not found'
          }
        });
      }

      res.json(result.rows[0]);
    } catch (error) {
      logger.error('Update setting error:', error);
      next(error);
    }
  }
);

module.exports = router;

