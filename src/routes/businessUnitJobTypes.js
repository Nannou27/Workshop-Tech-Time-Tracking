const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Helper: Check if user can manage BU
async function canManageBU(userId, businessUnitId) {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const userResult = await db.query(
      `SELECT u.id, u.role_id, r.name as role_name, u.business_unit_id
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.id = ${dbType === 'mysql' ? '?' : '$1'}`,
      [userId]
    );

    if (userResult.rows.length === 0) return false;
    const user = userResult.rows[0];

    // Super Admin can manage all BUs
    if (user.role_name === 'Super Admin') {
      return true;
    }

    // BU Admin can only manage their own BU
    if (user.role_name === 'Business Unit Admin' && user.business_unit_id === businessUnitId) {
      return true;
    }

    return false;
  } catch (error) {
    logger.error('Error checking BU permissions:', error);
    return false;
  }
}

// GET /api/v1/business-unit-job-types/:business_unit_id
// Get job types for a specific Business Unit
router.get('/:business_unit_id', async (req, res, next) => {
  try {
    const { business_unit_id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';

    const result = await db.query(
      `SELECT * FROM business_unit_job_types
       WHERE business_unit_id = ${dbType === 'mysql' ? '?' : '$1'}
       ORDER BY display_order, job_type_name`,
      [business_unit_id]
    );

    res.json({
      data: result.rows
    });
  } catch (error) {
    logger.error('Get job types error:', error);
    next(error);
  }
});

// GET /api/v1/business-unit-job-types/my-bu
// Get job types for current user's Business Unit
router.get('/my-bu', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const dbType = process.env.DB_TYPE || 'postgresql';

    const userResult = await db.query(
      `SELECT business_unit_id FROM users WHERE id = ${dbType === 'mysql' ? '?' : '$1'}`,
      [userId]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].business_unit_id) {
      return res.status(404).json({
        error: {
          code: 'NO_BUSINESS_UNIT',
          message: 'User is not assigned to a Business Unit'
        }
      });
    }

    const businessUnitId = userResult.rows[0].business_unit_id;
    req.params.business_unit_id = businessUnitId;
    return router.handle({ ...req, params: { business_unit_id: businessUnitId } }, res, next);
  } catch (error) {
    logger.error('Get my BU job types error:', error);
    next(error);
  }
});

// POST /api/v1/business-unit-job-types/:business_unit_id
// Create a new job type for a Business Unit
router.post('/:business_unit_id',
  requireAdmin,
  [
    body('job_type_code').notEmpty().trim().isLength({ max: 50 }),
    body('job_type_name').notEmpty().trim().isLength({ max: 255 }),
    body('description').optional().trim(),
    body('default_estimated_hours').optional().isFloat({ min: 0 }),
    body('display_order').optional().isInt({ min: 0 })
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

      const { business_unit_id } = req.params;
      const userId = req.user.id;

      // Check permissions
      const hasPermission = await canManageBU(userId, parseInt(business_unit_id));
      if (!hasPermission) {
        return res.status(403).json({
          error: {
            code: 'AUTHORIZATION_FAILED',
            message: 'You do not have permission to manage job types for this Business Unit'
          }
        });
      }

      const {
        job_type_code,
        job_type_name,
        description,
        default_estimated_hours,
        display_order = 0
      } = req.body;

      const dbType = process.env.DB_TYPE || 'postgresql';

      // Check for duplicate
      const existing = await db.query(
        `SELECT id FROM business_unit_job_types
         WHERE business_unit_id = ${dbType === 'mysql' ? '?' : '$1'} 
         AND job_type_code = ${dbType === 'mysql' ? '?' : '$2'}`,
        [business_unit_id, job_type_code]
      );

      if (existing.rows.length > 0) {
        return res.status(409).json({
          error: {
            code: 'RESOURCE_CONFLICT',
            message: 'Job type with this code already exists for this Business Unit'
          }
        });
      }

      let newJobType;
      if (dbType === 'mysql') {
        await db.query(
          `INSERT INTO business_unit_job_types 
           (business_unit_id, job_type_code, job_type_name, description, default_estimated_hours, display_order, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [business_unit_id, job_type_code, job_type_name, description || null, default_estimated_hours || null, display_order, userId, userId]
        );
        const result = await db.query(
          `SELECT * FROM business_unit_job_types 
           WHERE business_unit_id = ? AND job_type_code = ?`,
          [business_unit_id, job_type_code]
        );
        newJobType = result.rows[0];
      } else {
        const result = await db.query(
          `INSERT INTO business_unit_job_types 
           (business_unit_id, job_type_code, job_type_name, description, default_estimated_hours, display_order, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [business_unit_id, job_type_code, job_type_name, description || null, default_estimated_hours || null, display_order, userId, userId]
        );
        newJobType = result.rows[0];
      }

      // Log audit
      await db.query(
        `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
         VALUES ($1, 'job_type.created', 'business_unit_job_type', $2, $3)`,
        [userId, newJobType.id, JSON.stringify({ business_unit_id, job_type_code, job_type_name })]
      );

      res.status(201).json(newJobType);
    } catch (error) {
      logger.error('Create job type error:', error);
      next(error);
    }
  }
);

// PATCH /api/v1/business-unit-job-types/:id
// Update a job type
router.patch('/:id', requireAdmin,
  [
    body('job_type_name').optional().trim().isLength({ max: 255 }),
    body('description').optional().trim(),
    body('default_estimated_hours').optional().isFloat({ min: 0 }),
    body('is_active').optional().isBoolean(),
    body('display_order').optional().isInt({ min: 0 })
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
      const userId = req.user.id;
      const dbType = process.env.DB_TYPE || 'postgresql';

      // Get existing job type to check permissions
      const existing = await db.query(
        `SELECT * FROM business_unit_job_types WHERE id = ${dbType === 'mysql' ? '?' : '$1'}`,
        [id]
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: 'Job type not found'
          }
        });
      }

      const businessUnitId = existing.rows[0].business_unit_id;

      // Check permissions
      const hasPermission = await canManageBU(userId, businessUnitId);
      if (!hasPermission) {
        return res.status(403).json({
          error: {
            code: 'AUTHORIZATION_FAILED',
            message: 'You do not have permission to update this job type'
          }
        });
      }

      const updates = [];
      const params = [];
      let paramCount = 0;

      if (req.body.job_type_name !== undefined) {
        paramCount++;
        updates.push(`job_type_name = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(req.body.job_type_name);
      }
      if (req.body.description !== undefined) {
        paramCount++;
        updates.push(`description = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(req.body.description);
      }
      if (req.body.default_estimated_hours !== undefined) {
        paramCount++;
        updates.push(`default_estimated_hours = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(req.body.default_estimated_hours);
      }
      if (req.body.is_active !== undefined) {
        paramCount++;
        updates.push(`is_active = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(req.body.is_active);
      }
      if (req.body.display_order !== undefined) {
        paramCount++;
        updates.push(`display_order = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(req.body.display_order);
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
      updates.push(`updated_by = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
      params.push(userId);

      paramCount++;
      params.push(id);

      if (dbType === 'mysql') {
        updates.push(`updated_at = NOW()`);
        await db.query(
          `UPDATE business_unit_job_types SET ${updates.join(', ')} WHERE id = ?`,
          params
        );
        const result = await db.query(
          `SELECT * FROM business_unit_job_types WHERE id = ?`,
          [id]
        );
        return res.json(result.rows[0]);
      } else {
        updates.push(`updated_at = now()`);
        const result = await db.query(
          `UPDATE business_unit_job_types SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
          params
        );
        return res.json(result.rows[0]);
      }
    } catch (error) {
      logger.error('Update job type error:', error);
      next(error);
    }
  }
);

// DELETE /api/v1/business-unit-job-types/:id
// Delete (deactivate) a job type
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const dbType = process.env.DB_TYPE || 'postgresql';

    // Get existing job type to check permissions
    const existing = await db.query(
      `SELECT * FROM business_unit_job_types WHERE id = ${dbType === 'mysql' ? '?' : '$1'}`,
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'Job type not found'
        }
      });
    }

    const businessUnitId = existing.rows[0].business_unit_id;

    // Check permissions
    const hasPermission = await canManageBU(userId, businessUnitId);
    if (!hasPermission) {
      return res.status(403).json({
        error: {
          code: 'AUTHORIZATION_FAILED',
          message: 'You do not have permission to delete this job type'
        }
      });
    }

    // Soft delete by setting is_active = false
    await db.query(
      `UPDATE business_unit_job_types 
       SET is_active = false, updated_by = ${dbType === 'mysql' ? '?' : '$1'}, updated_at = ${dbType === 'mysql' ? 'NOW()' : 'now()'}
       WHERE id = ${dbType === 'mysql' ? '?' : '$2'}`,
      [userId, id]
    );

    // Log audit
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES ($1, 'job_type.deleted', 'business_unit_job_type', $2, $3)`,
      [userId, id, JSON.stringify({ business_unit_id: businessUnitId })]
    );

    res.json({
      message: 'Job type deactivated successfully'
    });
  } catch (error) {
    logger.error('Delete job type error:', error);
    next(error);
  }
});

module.exports = router;


