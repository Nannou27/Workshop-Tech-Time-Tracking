const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// GET /api/v1/work-order-stage-history/:work_order_id
// Get stage history for a specific work order
router.get('/:work_order_id', async (req, res, next) => {
  try {
    const { work_order_id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';

    const result = await db.query(
      `SELECT 
        wosh.*,
        u1.display_name as from_technician_name,
        u1.email as from_technician_email,
        u2.display_name as to_technician_name,
        u2.email as to_technician_email,
        t1.employee_code as from_employee_code,
        t2.employee_code as to_employee_code
       FROM work_order_stage_history wosh
       LEFT JOIN users u1 ON wosh.from_technician_id = u1.id
       LEFT JOIN users u2 ON wosh.to_technician_id = u2.id
       LEFT JOIN technicians t1 ON wosh.from_technician_id = t1.user_id
       LEFT JOIN technicians t2 ON wosh.to_technician_id = t2.user_id
       WHERE wosh.work_order_id = ${dbType === 'mysql' ? '?' : '$1'}
       ORDER BY wosh.stage_order, wosh.created_at`,
      [work_order_id]
    );

    res.json({
      data: result.rows
    });
  } catch (error) {
    logger.error('Get work order stage history error:', error);
    next(error);
  }
});

// GET /api/v1/work-order-stage-history/technician/:technician_id
// Get stage history for a specific technician
router.get('/technician/:technician_id', async (req, res, next) => {
  try {
    const { technician_id } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    const dbType = process.env.DB_TYPE || 'postgresql';

    const result = await db.query(
      `SELECT 
        wosh.*,
        jc.job_number,
        jc.customer_name,
        u1.display_name as from_technician_name,
        u2.display_name as to_technician_name
       FROM work_order_stage_history wosh
       JOIN job_cards jc ON wosh.work_order_id = jc.id
       LEFT JOIN users u1 ON wosh.from_technician_id = u1.id
       LEFT JOIN users u2 ON wosh.to_technician_id = u2.id
       WHERE wosh.to_technician_id = ${dbType === 'mysql' ? '?' : '$1'}
       ORDER BY wosh.created_at DESC
       LIMIT ${dbType === 'mysql' ? '?' : '$2'} OFFSET ${dbType === 'mysql' ? '?' : '$3'}`,
      [technician_id, parseInt(limit), parseInt(offset)]
    );

    res.json({
      data: result.rows
    });
  } catch (error) {
    logger.error('Get technician stage history error:', error);
    next(error);
  }
});

// POST /api/v1/work-order-stage-history
// Create a new stage history entry (typically called when reassigning)
router.post('/',
  [
    body('work_order_id').isInt(),
    body('stage_name').notEmpty().trim(),
    body('to_technician_id').isInt(),
    body('assignment_id').optional().isInt(),
    body('from_technician_id').optional().isInt(),
    body('stage_order').optional().isInt({ min: 0 }),
    body('notes').optional().trim()
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

      const {
        work_order_id,
        assignment_id,
        stage_name,
        stage_order = 0,
        from_technician_id,
        to_technician_id,
        started_at,
        notes
      } = req.body;

      const dbType = process.env.DB_TYPE || 'postgresql';

      let newStage;
      if (dbType === 'mysql') {
        await db.query(
          `INSERT INTO work_order_stage_history 
           (work_order_id, assignment_id, stage_name, stage_order, from_technician_id, to_technician_id, started_at, notes, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_progress')`,
          [work_order_id, assignment_id || null, stage_name, stage_order, from_technician_id || null, to_technician_id, started_at || new Date(), notes || null]
        );
        const result = await db.query(
          `SELECT * FROM work_order_stage_history 
           WHERE work_order_id = ? AND to_technician_id = ? 
           ORDER BY created_at DESC LIMIT 1`,
          [work_order_id, to_technician_id]
        );
        newStage = result.rows[0];
      } else {
        const result = await db.query(
          `INSERT INTO work_order_stage_history 
           (work_order_id, assignment_id, stage_name, stage_order, from_technician_id, to_technician_id, started_at, notes, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'in_progress')
           RETURNING *`,
          [work_order_id, assignment_id || null, stage_name, stage_order, from_technician_id || null, to_technician_id, started_at || new Date(), notes || null]
        );
        newStage = result.rows[0];
      }

      res.status(201).json(newStage);
    } catch (error) {
      logger.error('Create stage history error:', error);
      next(error);
    }
  }
);

// PATCH /api/v1/work-order-stage-history/:id
// Update a stage history entry (e.g., mark as completed)
router.patch('/:id',
  [
    body('status').optional().isIn(['assigned', 'in_progress', 'completed', 'skipped']),
    body('completed_at').optional().isISO8601(),
    body('duration_seconds').optional().isInt({ min: 0 }),
    body('notes').optional().trim()
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

      const { id } = req.params;
      const dbType = process.env.DB_TYPE || 'postgresql';

      const updates = [];
      const params = [];
      let paramCount = 0;

      if (req.body.status !== undefined) {
        paramCount++;
        updates.push(`status = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(req.body.status);
      }
      if (req.body.completed_at !== undefined) {
        paramCount++;
        updates.push(`completed_at = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(req.body.completed_at);
      }
      if (req.body.duration_seconds !== undefined) {
        paramCount++;
        updates.push(`duration_seconds = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(req.body.duration_seconds);
      }
      if (req.body.notes !== undefined) {
        paramCount++;
        updates.push(`notes = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(req.body.notes);
      }

      if (updates.length === 0) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'No fields to update'
          }
        });
      }

      paramCount++;
      updates.push(`updated_at = ${dbType === 'mysql' ? 'NOW()' : 'now()'}`);
      params.push(id);

      if (dbType === 'mysql') {
        await db.query(
          `UPDATE work_order_stage_history SET ${updates.join(', ')} WHERE id = ?`,
          params
        );
        const result = await db.query(
          `SELECT * FROM work_order_stage_history WHERE id = ?`,
          [id]
        );
        return res.json(result.rows[0]);
      } else {
        const result = await db.query(
          `UPDATE work_order_stage_history SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
          params
        );
        return res.json(result.rows[0]);
      }
    } catch (error) {
      logger.error('Update stage history error:', error);
      next(error);
    }
  }
);

module.exports = router;





