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

// GET /api/v1/job-history
router.get('/',
  [
    query('work_order_id').optional().isInt(),
    query('assignment_id').optional().isInt(),
    query('technician_id').optional().isInt(),
    query('action_type').optional().isIn(['created', 'assigned', 'started', 'paused', 'resumed', 'completed', 'reassigned', 'cancelled']),
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

      const { work_order_id, assignment_id, technician_id, action_type, start_date, end_date, page = 1, limit = 20 } = req.query;
      const offset = (page - 1) * limit;
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$';

      // Check if job_history table exists
      const historyTableExists = await tableExists('job_history');
      if (!historyTableExists) {
        return res.json({ data: [], pagination: { page: 1, limit: 20, total: 0, total_pages: 0 } });
      }

      let queryText = `
        SELECT jh.*,
               jc.job_number, jc.customer_name,
               u.display_name as technician_name,
               u.email as technician_email
        FROM job_history jh
        LEFT JOIN job_cards jc ON jh.work_order_id = jc.id
        LEFT JOIN users u ON jh.technician_id = u.id
        WHERE 1=1
      `;
      const params = [];
      let paramCount = 0;

      if (work_order_id) {
        paramCount++;
        queryText += ` AND jh.work_order_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(work_order_id);
      }

      if (assignment_id) {
        paramCount++;
        queryText += ` AND jh.assignment_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(assignment_id);
      }

      if (technician_id) {
        paramCount++;
        queryText += ` AND jh.technician_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(technician_id);
      }

      if (action_type) {
        paramCount++;
        queryText += ` AND jh.action_type = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(action_type);
      }

      if (start_date) {
        paramCount++;
        queryText += ` AND jh.created_at >= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(start_date);
      }

      if (end_date) {
        paramCount++;
        queryText += ` AND jh.created_at <= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(end_date);
      }

      // Get total count
      const countQuery = queryText.replace(/SELECT.*FROM/, 'SELECT COUNT(*) as total FROM');
      const countResult = await db.query(countQuery, params);
      const total = parseInt(countResult.rows[0].total || countResult.rows[0].count || 0);

      // Add pagination
      const limitPlaceholder = dbType === 'mysql' ? '?' : `$${paramCount + 1}`;
      const offsetPlaceholder = dbType === 'mysql' ? '?' : `$${paramCount + 2}`;
      queryText += ` ORDER BY jh.created_at DESC LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`;
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
      logger.error('Get job history error:', error);
      next(error);
    }
  }
);

// GET /api/v1/job-history/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';

    // Check if job_history table exists
    const historyTableExists = await tableExists('job_history');
    if (!historyTableExists) {
      return res.status(404).json({
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'Job history feature not available'
        }
      });
    }

    const result = await db.query(
      `SELECT jh.*,
              jc.job_number, jc.customer_name,
              u.display_name as technician_name,
              u.email as technician_email
       FROM job_history jh
       LEFT JOIN job_cards jc ON jh.work_order_id = jc.id
       LEFT JOIN users u ON jh.technician_id = u.id
       WHERE jh.id = ${placeholder}`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'Job history entry not found'
        }
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Get job history entry error:', error);
    next(error);
  }
});

// GET /api/v1/job-history/work-order/:work_order_id
router.get('/work-order/:work_order_id', async (req, res, next) => {
  try {
    const { work_order_id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';

    // Check if job_history table exists
    const historyTableExists = await tableExists('job_history');
    if (!historyTableExists) {
      return res.json({ data: [] });
    }

    const result = await db.query(
      `SELECT jh.*,
              u.display_name as technician_name,
              u.email as technician_email
       FROM job_history jh
       LEFT JOIN users u ON jh.technician_id = u.id
       WHERE jh.work_order_id = ${placeholder}
       ORDER BY jh.created_at DESC`,
      [work_order_id]
    );

    res.json({ data: result.rows });
  } catch (error) {
    logger.error('Get work order history error:', error);
    next(error);
  }
});

// GET /api/v1/job-history/technician/:technician_id
router.get('/technician/:technician_id', async (req, res, next) => {
  try {
    const { technician_id } = req.params;
    const { start_date, end_date, action_type } = req.query;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$';

    // Check if job_history table exists
    const historyTableExists = await tableExists('job_history');
    if (!historyTableExists) {
      return res.json({ data: [] });
    }

    let queryText = `
      SELECT jh.*,
             jc.job_number, jc.customer_name,
             u.display_name as technician_name
      FROM job_history jh
      LEFT JOIN job_cards jc ON jh.work_order_id = jc.id
      LEFT JOIN users u ON jh.technician_id = u.id
      WHERE jh.technician_id = ${placeholder}1
    `;
    const params = [technician_id];
    let paramCount = 1;

    if (start_date) {
      paramCount++;
      queryText += ` AND jh.created_at >= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(start_date);
    }

    if (end_date) {
      paramCount++;
      queryText += ` AND jh.created_at <= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(end_date);
    }

    if (action_type) {
      paramCount++;
      queryText += ` AND jh.action_type = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(action_type);
    }

    queryText += ' ORDER BY jh.created_at DESC';

    const result = await db.query(queryText, params);

    res.json({ data: result.rows });
  } catch (error) {
    logger.error('Get technician history error:', error);
    next(error);
  }
});

module.exports = router;





