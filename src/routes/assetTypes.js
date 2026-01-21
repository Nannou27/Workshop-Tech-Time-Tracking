const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Helper function to check if user can manage a business unit
async function canManageBU(userId, businessUnitId) {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    const userResult = await db.query(
      `SELECT u.id, u.role_id, r.name as role_name, u.business_unit_id
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.id = ${placeholder}`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return false;
    }

    const user = userResult.rows[0];

    // Super Admin can manage all
    if (user.role_name === 'Super Admin') {
      return true;
    }

    // Business Unit Admin can only manage their own BU
    if (user.role_name === 'Business Unit Admin' && user.business_unit_id === businessUnitId) {
      return true;
    }

    return false;
  } catch (error) {
    logger.error('Error checking BU permissions:', error);
    return false;
  }
}

// GET /api/v1/asset-types/my-bu (for current user's BU)
// MUST be before /:business_unit_id route to avoid matching "my-bu" as a param
router.get('/my-bu', async (req, res, next) => {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    // Get user's business unit
    const userResult = await db.query(
      `SELECT business_unit_id FROM users WHERE id = ${placeholder}`,
      [req.user.id]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].business_unit_id) {
      return res.status(400).json({
        error: {
          code: 'NO_BUSINESS_UNIT',
          message: 'User is not assigned to a business unit'
        }
      });
    }

    const businessUnitId = userResult.rows[0].business_unit_id;
    
    // Get asset types for user's BU
    const result = await db.query(
      `SELECT * FROM asset_types
       WHERE business_unit_id = ${placeholder}
       AND is_active = true
       ORDER BY display_order ASC, type_name ASC`,
      [businessUnitId]
    );

    res.json({
      data: result.rows || []
    });
  } catch (error) {
    logger.error('Get my BU asset types error:', error);
    next(error);
  }
});

// GET /api/v1/asset-types/:business_unit_id
router.get('/:business_unit_id', async (req, res, next) => {
  try {
    const { business_unit_id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    const result = await db.query(
      `SELECT * FROM asset_types
       WHERE business_unit_id = ${placeholder}
       AND is_active = true
       ORDER BY display_order ASC, type_name ASC`,
      [business_unit_id]
    );

    res.json({
      data: result.rows || []
    });
  } catch (error) {
    logger.error('Get asset types error:', error);
    next(error);
  }
});

// POST /api/v1/asset-types/:business_unit_id
router.post('/:business_unit_id',
  requireAdmin,
  [
    body('type_code').trim().notEmpty().matches(/^[A-Z0-9_]+$/),
    body('type_name').trim().notEmpty(),
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

      // Check permission
      const hasPermission = await canManageBU(userId, parseInt(business_unit_id));
      if (!hasPermission) {
        return res.status(403).json({
          error: {
            code: 'AUTHORIZATION_FAILED',
            message: 'You do not have permission to manage this business unit'
          }
        });
      }

      const {
        type_code,
        type_name,
        description,
        icon = '🏭',
        color = '#17a2b8',
        display_order = 0
      } = req.body;

      const dbType = process.env.DB_TYPE || 'postgresql';

      // Check if type already exists for this BU
      const checkPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const existing = await db.query(
        `SELECT id FROM asset_types 
         WHERE business_unit_id = ${checkPlaceholder} 
         AND type_code = ${dbType === 'mysql' ? '?' : '$2'}`,
        [business_unit_id, type_code]
      );

      if (existing.rows.length > 0) {
        return res.status(409).json({
          error: {
            code: 'RESOURCE_CONFLICT',
            message: 'Asset type with this code already exists'
          }
        });
      }

      // Insert new asset type
      let newAssetType;
      if (dbType === 'mysql') {
        await db.query(
          `INSERT INTO asset_types (business_unit_id, type_code, type_name, description, icon, color, display_order, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [business_unit_id, type_code, type_name, description || null, icon, color, display_order, userId, userId]
        );

        const result = await db.query(
          `SELECT * FROM asset_types 
           WHERE business_unit_id = ? AND type_code = ?`,
          [business_unit_id, type_code]
        );
        newAssetType = result.rows[0];
      } else {
        const result = await db.query(
          `INSERT INTO asset_types (business_unit_id, type_code, type_name, description, icon, color, display_order, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [business_unit_id, type_code, type_name, description || null, icon, color, display_order, userId, userId]
        );
        newAssetType = result.rows[0];
      }

      // Create audit log
      await db.query(
        dbType === 'mysql'
          ? `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details) VALUES (?, 'asset_type.created', 'asset_type', ?, ?)`
          : `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details) VALUES ($1, 'asset_type.created', 'asset_type', $2, $3)`,
        [userId, newAssetType.id, JSON.stringify({ business_unit_id, type_code, type_name })]
      );

      res.status(201).json(newAssetType);
    } catch (error) {
      logger.error('Create asset type error:', error);
      next(error);
    }
  }
);

// PATCH /api/v1/asset-types/:business_unit_id/:id
router.patch('/:business_unit_id/:id',
  requireAdmin,
  [
    body('type_name').optional().trim().notEmpty(),
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

      const { business_unit_id, id } = req.params;
      const userId = req.user.id;

      // Check permission
      const hasPermission = await canManageBU(userId, parseInt(business_unit_id));
      if (!hasPermission) {
        return res.status(403).json({
          error: {
            code: 'AUTHORIZATION_FAILED',
            message: 'You do not have permission to manage this business unit'
          }
        });
      }

      // Verify asset type exists and belongs to this BU
      const dbType = process.env.DB_TYPE || 'postgresql';
      const checkPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const existing = await db.query(
        `SELECT * FROM asset_types WHERE id = ${checkPlaceholder} AND business_unit_id = ${dbType === 'mysql' ? '?' : '$2'}`,
        [id, business_unit_id]
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Asset type not found'
          }
        });
      }

      const { type_name, description, icon, color, is_active, display_order } = req.body;

      const updates = [];
      const params = [];
      let paramCount = 0;

      if (type_name !== undefined) {
        paramCount++;
        updates.push(`type_name = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(type_name);
      }

      if (description !== undefined) {
        paramCount++;
        updates.push(`description = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(description);
      }

      if (icon !== undefined) {
        paramCount++;
        updates.push(`icon = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(icon);
      }

      if (color !== undefined) {
        paramCount++;
        updates.push(`color = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(color);
      }

      if (is_active !== undefined) {
        paramCount++;
        updates.push(`is_active = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(is_active);
      }

      if (display_order !== undefined) {
        paramCount++;
        updates.push(`display_order = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(display_order);
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

      let result;
      if (dbType === 'mysql') {
        await db.query(
          `UPDATE asset_types SET ${updates.join(', ')} WHERE id = ?`,
          params
        );

        result = await db.query(`SELECT * FROM asset_types WHERE id = ?`, [id]);
      } else {
        result = await db.query(
          `UPDATE asset_types SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
          params
        );
      }

      // Create audit log
      await db.query(
        dbType === 'mysql'
          ? `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details) VALUES (?, 'asset_type.updated', 'asset_type', ?, ?)`
          : `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details) VALUES ($1, 'asset_type.updated', 'asset_type', $2, $3)`,
        [userId, id, JSON.stringify(req.body)]
      );

      res.json(result.rows[0]);
    } catch (error) {
      logger.error('Update asset type error:', error);
      next(error);
    }
  }
);

// DELETE /api/v1/asset-types/:business_unit_id/:id
router.delete('/:business_unit_id/:id', requireAdmin, async (req, res, next) => {
  try {
    const { business_unit_id, id } = req.params;
    const userId = req.user.id;

    // Check permission
    const hasPermission = await canManageBU(userId, parseInt(business_unit_id));
    if (!hasPermission) {
      return res.status(403).json({
        error: {
          code: 'AUTHORIZATION_FAILED',
          message: 'You do not have permission to manage this business unit'
        }
      });
    }

    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';

    // Soft delete by setting is_active to false
    await db.query(
      `UPDATE asset_types SET is_active = false WHERE id = ${placeholder}`,
      [id]
    );

    // Create audit log
    await db.query(
      dbType === 'mysql'
        ? `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details) VALUES (?, 'asset_type.deleted', 'asset_type', ?, ?)`
        : `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details) VALUES ($1, 'asset_type.deleted', 'asset_type', $2, $3)`,
      [userId, id, JSON.stringify({ business_unit_id })]
    );

    res.json({ message: 'Asset type deleted successfully' });
  } catch (error) {
    logger.error('Delete asset type error:', error);
    next(error);
  }
});

module.exports = router;

