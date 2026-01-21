const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// GET /api/v1/business-units
router.get('/', async (req, res, next) => {
  try {
    const { is_active } = req.query;
    const dbType = process.env.DB_TYPE || 'postgresql';
    
    let query = `SELECT * FROM business_units WHERE 1=1`;
    const params = [];
    let paramCount = 0;
    
    if (is_active !== undefined) {
      paramCount++;
      const p = dbType === 'mysql' ? '?' : `$${paramCount}`;
      query += ` AND is_active = ${p}`;
      params.push(is_active === 'true' || is_active === true);
    }
    
    query += ` ORDER BY name ASC`;
    
    const result = await db.query(query, params);
    // Standard response shape (clients already handle both array and {data:[]})
    res.json({ data: result.rows });
  } catch (error) {
    logger.error('Get business units error:', error);
    next(error);
  }
});

// GET /api/v1/business-units/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    const result = await db.query(
      `SELECT * FROM business_units WHERE id = ${placeholder}`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Business unit not found'
        }
      });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Get business unit error:', error);
    next(error);
  }
});

// POST /api/v1/business-units
router.post('/', requireSuperAdmin, [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('code').optional().trim(),
], async (req, res, next) => {
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
    
    const { name, description, code, is_active = true, metadata = {} } = req.body;
    const dbType = process.env.DB_TYPE || 'postgresql';
    
    // Check if code already exists
    if (code) {
      const checkPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const existing = await db.query(
        `SELECT id FROM business_units WHERE code = ${checkPlaceholder}`,
        [code]
      );
      
      if (existing.rows.length > 0) {
        return res.status(400).json({
          error: {
            code: 'DUPLICATE_CODE',
            message: 'Business unit code already exists'
          }
        });
      }
    }
    
    const insertPlaceholder = dbType === 'mysql' ? '?' : '$1';
    const metadataValue = dbType === 'mysql' ? JSON.stringify(metadata) : metadata;
    
    let result;
    if (dbType === 'mysql') {
      result = await db.query(
        `INSERT INTO business_units (name, description, code, is_active, metadata, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [name, description || null, code || null, is_active, metadataValue, req.user.id]
      );
      
      // Get the inserted record
      result = await db.query(
        `SELECT * FROM business_units WHERE id = LAST_INSERT_ID()`
      );
    } else {
      result = await db.query(
        `INSERT INTO business_units (name, description, code, is_active, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [name, description || null, code || null, is_active, metadata, req.user.id]
      );
    }
    
    // Create audit log
    const auditPlaceholder = dbType === 'mysql' ? '?' : '$1';
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES (${auditPlaceholder}, 'business_unit.created', 'business_unit', ${dbType === 'mysql' ? '?' : '$2'}, ${dbType === 'mysql' ? '?' : '$3'})`,
      [req.user.id, result.rows[0].id, JSON.stringify(req.body)]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Create business unit error:', error);
    next(error);
  }
});

// PATCH /api/v1/business-units/:id
router.patch('/:id', requireSuperAdmin, [
  body('name').optional().trim().notEmpty(),
], async (req, res, next) => {
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
    const { name, description, code, is_active, metadata } = req.body;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    // Check if business unit exists
    const existing = await db.query(
      `SELECT * FROM business_units WHERE id = ${placeholder}`,
      [id]
    );
    
    if (existing.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Business unit not found'
        }
      });
    }
    
    // Check if code already exists (if changing)
    if (code && code !== existing.rows[0].code) {
      const checkPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const codeCheck = await db.query(
        `SELECT id FROM business_units WHERE code = ${checkPlaceholder} AND id != ${dbType === 'mysql' ? '?' : '$2'}`,
        dbType === 'mysql' ? [code, id] : [code, id]
      );
      
      if (codeCheck.rows.length > 0) {
        return res.status(400).json({
          error: {
            code: 'DUPLICATE_CODE',
            message: 'Business unit code already exists'
          }
        });
      }
    }
    
    const updates = [];
    const params = [];
    let paramCount = 0;
    
    if (name !== undefined) {
      paramCount++;
      updates.push(`name = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(name);
    }
    
    if (description !== undefined) {
      paramCount++;
      updates.push(`description = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(description);
    }
    
    if (code !== undefined) {
      paramCount++;
      updates.push(`code = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(code);
    }
    
    if (is_active !== undefined) {
      paramCount++;
      updates.push(`is_active = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(is_active);
    }
    
    if (metadata !== undefined) {
      paramCount++;
      const metadataValue = dbType === 'mysql' ? JSON.stringify(metadata) : metadata;
      updates.push(`metadata = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(metadataValue);
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
    params.push(id);
    
    let result;
    if (dbType === 'mysql') {
      await db.query(
        `UPDATE business_units SET ${updates.join(', ')} WHERE id = ?`,
        params
      );
      
      result = await db.query(
        `SELECT * FROM business_units WHERE id = ?`,
        [id]
      );
    } else {
      result = await db.query(
        `UPDATE business_units SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
        params
      );
    }
    
    // Create audit log
    const auditPlaceholder = dbType === 'mysql' ? '?' : '$1';
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES (${auditPlaceholder}, 'business_unit.updated', 'business_unit', ${dbType === 'mysql' ? '?' : '$2'}, ${dbType === 'mysql' ? '?' : '$3'})`,
      [req.user.id, id, JSON.stringify(req.body)]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Update business unit error:', error);
    next(error);
  }
});

// DELETE /api/v1/business-units/:id
router.delete('/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    // Check if business unit exists
    const existing = await db.query(
      `SELECT * FROM business_units WHERE id = ${placeholder}`,
      [id]
    );
    
    if (existing.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Business unit not found'
        }
      });
    }
    
    // Check if business unit has locations
    const locationsCheck = await db.query(
      `SELECT COUNT(*) as count FROM locations WHERE business_unit_id = ${placeholder}`,
      [id]
    );
    
    const locationCount = dbType === 'mysql' 
      ? locationsCheck.rows[0].count 
      : parseInt(locationsCheck.rows[0].count);
    
    if (locationCount > 0) {
      return res.status(400).json({
        error: {
          code: 'HAS_DEPENDENCIES',
          message: `Cannot delete business unit: it has ${locationCount} location(s) associated`
        }
      });
    }
    
    // Soft delete by setting is_active to false
    if (dbType === 'mysql') {
      await db.query(
        `UPDATE business_units SET is_active = false WHERE id = ?`,
        [id]
      );
    } else {
      await db.query(
        `UPDATE business_units SET is_active = false WHERE id = $1`,
        [id]
      );
    }
    
    // Create audit log
    const auditPlaceholder = dbType === 'mysql' ? '?' : '$1';
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES (${auditPlaceholder}, 'business_unit.deleted', 'business_unit', ${dbType === 'mysql' ? '?' : '$2'}, ${dbType === 'mysql' ? '?' : '$3'})`,
      [req.user.id, id, JSON.stringify({ deleted_at: new Date().toISOString() })]
    );
    
    res.json({ message: 'Business unit deleted successfully' });
  } catch (error) {
    logger.error('Delete business unit error:', error);
    next(error);
  }
});

module.exports = router;


