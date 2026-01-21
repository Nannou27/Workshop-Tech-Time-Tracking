const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

async function columnExists(tableName, columnName) {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    let checkQuery;
    if (dbType === 'mysql') {
      checkQuery = `SHOW COLUMNS FROM ${tableName} LIKE '${columnName}'`;
    } else {
      checkQuery = `SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = '${tableName}' AND column_name = '${columnName}'
      ) as exists`;
    }
    const result = await db.query(checkQuery);
    return dbType === 'mysql' ? result.rows.length > 0 : result.rows[0].exists;
  } catch (error) {
    return false;
  }
}

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

async function canManageBU(userId, businessUnitId) {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    const userResult = await db.query(
      `SELECT u.id, r.name as role_name, u.business_unit_id FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ${placeholder}`,
      [userId]
    );
    if (userResult.rows.length === 0) return false;
    const user = userResult.rows[0];
    if (user.role_name === 'Super Admin') return true;
    if (user.role_name === 'Business Unit Admin' && String(user.business_unit_id) === String(businessUnitId)) return true;
    return false;
  } catch (error) { return false; }
}

router.get('/my-bu', async (req, res, next) => {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    const userResult = await db.query(`SELECT business_unit_id FROM users WHERE id = ${placeholder}`, [req.user.id]);
    if (userResult.rows.length === 0 || !userResult.rows[0].business_unit_id) {
      return res.status(400).json({ error: { code: 'NO_BUSINESS_UNIT', message: 'User is not assigned to a business unit' } });
    }
    const businessUnitId = userResult.rows[0].business_unit_id;
    const result = await db.query(
      `SELECT * FROM job_card_statuses WHERE business_unit_id = ${placeholder} AND is_active = true ORDER BY display_order ASC`,
      [businessUnitId]
    );
    res.json({ data: result.rows || [] });
  } catch (error) {
    logger.error('Get my BU job card statuses error:', error);
    next(error);
  }
});

router.get('/:business_unit_id', async (req, res, next) => {
  try {
    const { business_unit_id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    const result = await db.query(
      `SELECT * FROM job_card_statuses WHERE business_unit_id = ${placeholder} AND is_active = true ORDER BY display_order ASC`,
      [business_unit_id]
    );
    res.json({ data: result.rows || [] });
  } catch (error) {
    logger.error('Get job card statuses error:', error);
    next(error);
  }
});

router.post('/:business_unit_id', requireAdmin, [
  body('status_code').trim().notEmpty().matches(/^[a-z0-9_]+$/),
  body('status_name').trim().notEmpty(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() } });
    }
    const { business_unit_id } = req.params;
    const hasPermission = await canManageBU(req.user.id, parseInt(business_unit_id));
    if (!hasPermission) {
      return res.status(403).json({ error: { code: 'AUTHORIZATION_FAILED', message: 'You do not have permission' } });
    }
    const {
      status_code,
      status_name,
      description,
      color = '#ffc107',
      badge_style = 'warning',
      is_closed_status = false,
      display_order = 0
    } = req.body;
    const dbType = process.env.DB_TYPE || 'postgresql';

    // If the table is missing (schema not applied), return a clear 4xx instead of a hidden 500.
    const hasTable = await tableExists('job_card_statuses');
    if (!hasTable) {
      return res.status(400).json({
        error: {
          code: 'FEATURE_NOT_AVAILABLE',
          message: 'job_card_statuses table is missing in this database. Apply schema_system_configurations.sql to enable configurable job card statuses.'
        }
      });
    }

    const checkPlaceholder = dbType === 'mysql' ? '?' : '$1';
    const existing = await db.query(
      `SELECT id FROM job_card_statuses WHERE business_unit_id = ${checkPlaceholder} AND status_code = ${dbType === 'mysql' ? '?' : '$2'}`,
      [business_unit_id, status_code]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: { code: 'RESOURCE_CONFLICT', message: 'Job card status with this code already exists' } });
    }

    // Backward-compatible insert: only include columns that exist in the current DB schema
    const hasDescription = await columnExists('job_card_statuses', 'description');
    const hasColor = await columnExists('job_card_statuses', 'color');
    const hasBadgeStyle = await columnExists('job_card_statuses', 'badge_style');
    const hasClosed = await columnExists('job_card_statuses', 'is_closed_status');
    const hasDisplayOrder = await columnExists('job_card_statuses', 'display_order');
    const hasCreatedBy = await columnExists('job_card_statuses', 'created_by');

    const cols = ['business_unit_id', 'status_code', 'status_name'];
    const vals = [business_unit_id, status_code, status_name];

    if (hasDescription) { cols.push('description'); vals.push(description || null); }
    if (hasColor) { cols.push('color'); vals.push(color); }
    if (hasBadgeStyle) { cols.push('badge_style'); vals.push(badge_style); }
    if (hasClosed) {
      const closed = is_closed_status === true || is_closed_status === 1 || is_closed_status === '1' || is_closed_status === 'true';
      cols.push('is_closed_status'); vals.push(closed);
    }
    if (hasDisplayOrder) { cols.push('display_order'); vals.push(parseInt(display_order) || 0); }
    if (hasCreatedBy) { cols.push('created_by'); vals.push(req.user.id); }

    let result;
    if (dbType === 'mysql') {
      const placeholders = cols.map(() => '?').join(', ');
      await db.query(
        `INSERT INTO job_card_statuses (${cols.join(', ')})
         VALUES (${placeholders})`,
        vals
      );
      result = await db.query(
        `SELECT * FROM job_card_statuses WHERE business_unit_id = ? AND status_code = ?`,
        [business_unit_id, status_code]
      );
    } else {
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      result = await db.query(
        `INSERT INTO job_card_statuses (${cols.join(', ')})
         VALUES (${placeholders}) RETURNING *`,
        vals
      );
    }

    res.status(201).json(result.rows[0] || null);
  } catch (error) {
    logger.error('Create job card status error:', error);
    next(error);
  }
});

router.patch('/:business_unit_id/:id', requireAdmin, async (req, res, next) => {
  try {
    const { business_unit_id, id } = req.params;
    const hasPermission = await canManageBU(req.user.id, parseInt(business_unit_id));
    if (!hasPermission) {
      return res.status(403).json({ error: { code: 'AUTHORIZATION_FAILED', message: 'You do not have permission' } });
    }
    const { status_name, description, color, badge_style, is_closed_status, display_order } = req.body;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const updates = [];
    const params = [];
    let paramCount = 0;

    if (status_name !== undefined) { paramCount++; updates.push(`status_name = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`); params.push(status_name); }
    if (description !== undefined && await columnExists('job_card_statuses', 'description')) { paramCount++; updates.push(`description = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`); params.push(description); }
    if (color !== undefined && await columnExists('job_card_statuses', 'color')) { paramCount++; updates.push(`color = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`); params.push(color); }
    if (badge_style !== undefined && await columnExists('job_card_statuses', 'badge_style')) { paramCount++; updates.push(`badge_style = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`); params.push(badge_style); }
    if (is_closed_status !== undefined && await columnExists('job_card_statuses', 'is_closed_status')) { paramCount++; updates.push(`is_closed_status = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`); params.push(is_closed_status); }
    if (display_order !== undefined && await columnExists('job_card_statuses', 'display_order')) { paramCount++; updates.push(`display_order = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`); params.push(display_order); }
    if (updates.length === 0) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No fields to update' } });
    }

    paramCount++;
    params.push(id);

    if (dbType === 'mysql') {
      await db.query(`UPDATE job_card_statuses SET ${updates.join(', ')} WHERE id = ?`, params);
      const result = await db.query(`SELECT * FROM job_card_statuses WHERE id = ?`, [id]);
      res.json(result.rows[0]);
    } else {
      const result = await db.query(`UPDATE job_card_statuses SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`, params);
      res.json(result.rows[0]);
    }
  } catch (error) {
    logger.error('Update job card status error:', error);
    next(error);
  }
});

router.delete('/:business_unit_id/:id', requireAdmin, async (req, res, next) => {
  try {
    const { business_unit_id, id } = req.params;
    const hasPermission = await canManageBU(req.user.id, parseInt(business_unit_id));
    if (!hasPermission) {
      return res.status(403).json({ error: { code: 'AUTHORIZATION_FAILED', message: 'You do not have permission' } });
    }
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    await db.query(`UPDATE job_card_statuses SET is_active = false WHERE id = ${placeholder}`, [id]);
    res.json({ message: 'Job card status deleted successfully' });
  } catch (error) {
    logger.error('Delete job card status error:', error);
    next(error);
  }
});

module.exports = router;


