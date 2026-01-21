const express = require('express');
const { query, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Helper function to check if table exists
async function tableExists(tableName) {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    let checkQuery;
    if (dbType === 'mysql') {
      checkQuery = `SHOW TABLES LIKE '${tableName}'`;
    } else {
      checkQuery = `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '${tableName}') as exists`;
    }
    const result = await db.query(checkQuery);
    return dbType === 'mysql' ? result.rows.length > 0 : result.rows[0].exists;
  } catch (error) {
    return false;
  }
}

// GET /api/v1/asset-movements
router.get('/',
  [
    query('asset_id').optional().isInt(),
    query('from_location_id').optional().isInt(),
    query('to_location_id').optional().isInt(),
    query('moved_by').optional().isUUID().withMessage('moved_by must be a valid UUID'),
    query('start_date').optional().isISO8601(),
    query('end_date').optional().isISO8601(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 })
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

      const { asset_id, from_location_id, to_location_id, moved_by, start_date, end_date, page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$';

      // Check if asset_movements table exists
      const movementsTableExists = await tableExists('asset_movements');
      if (!movementsTableExists) {
        return res.json({ data: [], pagination: { page: 1, limit: 20, total: 0, total_pages: 0 } });
      }

      let queryText = `
        SELECT am.*,
               a.name as asset_name, a.asset_tag, a.serial_number,
               from_loc.name as from_location_name,
               to_loc.name as to_location_name,
               u.display_name as moved_by_name
        FROM asset_movements am
        LEFT JOIN assets a ON am.asset_id = a.id
        LEFT JOIN locations from_loc ON am.from_location_id = from_loc.id
        LEFT JOIN locations to_loc ON am.to_location_id = to_loc.id
        LEFT JOIN users u ON am.moved_by = u.id
        WHERE 1=1
      `;
      const params = [];
      let paramCount = 0;

      if (asset_id) {
        paramCount++;
        queryText += ` AND am.asset_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(asset_id);
      }

      if (from_location_id) {
        paramCount++;
        queryText += ` AND am.from_location_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(from_location_id);
      }

      if (to_location_id) {
        paramCount++;
        queryText += ` AND am.to_location_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(to_location_id);
      }

      if (moved_by) {
        paramCount++;
        queryText += ` AND am.moved_by = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(moved_by);
      }

      if (start_date) {
        paramCount++;
        queryText += ` AND am.moved_at >= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(start_date);
      }

      if (end_date) {
        paramCount++;
        queryText += ` AND am.moved_at <= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(end_date);
      }

      // Get total count
      const countQuery = queryText.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as total FROM');
      const countResult = await db.query(countQuery, params);
      const total = parseInt(countResult.rows[0].total || countResult.rows[0].count || 0);

      // Add pagination
      const limitPlaceholder = dbType === 'mysql' ? '?' : `$${paramCount + 1}`;
      const offsetPlaceholder = dbType === 'mysql' ? '?' : `$${paramCount + 2}`;
      queryText += ` ORDER BY am.moved_at DESC LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`;
      params.push(parseInt(limit), offset);

      const result = await db.query(queryText, params);

      res.json({
        data: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          total_pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      logger.error('Get asset movements error:', error);
      next(error);
    }
  }
);

// GET /api/v1/asset-movements/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';

    // Check if asset_movements table exists
    const movementsTableExists = await tableExists('asset_movements');
    if (!movementsTableExists) {
      return res.status(404).json({
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'Asset movements feature not available'
        }
      });
    }

    const result = await db.query(
      `SELECT am.*,
              a.name as asset_name, a.asset_tag, a.serial_number,
              from_loc.name as from_location_name,
              to_loc.name as to_location_name,
              u.display_name as moved_by_name
       FROM asset_movements am
       LEFT JOIN assets a ON am.asset_id = a.id
       LEFT JOIN locations from_loc ON am.from_location_id = from_loc.id
       LEFT JOIN locations to_loc ON am.to_location_id = to_loc.id
       LEFT JOIN users u ON am.moved_by = u.id
       WHERE am.id = ${placeholder}`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'Asset movement not found'
        }
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Get asset movement error:', error);
    next(error);
  }
});


module.exports = router;

