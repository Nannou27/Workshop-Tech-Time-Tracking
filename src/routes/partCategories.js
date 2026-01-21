const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

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
    if (user.role_name === 'Business Unit Admin' && user.business_unit_id === businessUnitId) return true;
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
      `SELECT * FROM part_categories WHERE business_unit_id = ${placeholder} AND is_active = true ORDER BY display_order ASC`,
      [businessUnitId]
    );
    res.json({ data: result.rows || [] });
  } catch (error) {
    logger.error('Get my BU part categories error:', error);
    next(error);
  }
});

router.get('/:business_unit_id', async (req, res, next) => {
  try {
    const { business_unit_id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    const result = await db.query(
      `SELECT * FROM part_categories WHERE business_unit_id = ${placeholder} AND is_active = true ORDER BY display_order ASC`,
      [business_unit_id]
    );
    res.json({ data: result.rows || [] });
  } catch (error) {
    logger.error('Get part categories error:', error);
    next(error);
  }
});

router.post('/:business_unit_id', requireAdmin, [
  body('category_code').trim().notEmpty().matches(/^[A-Z0-9_]+$/),
  body('category_name').trim().notEmpty(),
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
    const { category_code, category_name, description, icon = '🔧', parent_category_id = null, display_order = 0 } = req.body;
    const dbType = process.env.DB_TYPE || 'postgresql';

    const checkPlaceholder = dbType === 'mysql' ? '?' : '$1';
    const existing = await db.query(
      `SELECT id FROM part_categories WHERE business_unit_id = ${checkPlaceholder} AND category_code = ${dbType === 'mysql' ? '?' : '$2'}`,
      [business_unit_id, category_code]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: { code: 'RESOURCE_CONFLICT', message: 'Part category with this code already exists' } });
    }

    let result;
    if (dbType === 'mysql') {
      await db.query(
        `INSERT INTO part_categories (business_unit_id, category_code, category_name, description, icon, parent_category_id, display_order, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [business_unit_id, category_code, category_name, description || null, icon, parent_category_id, display_order, req.user.id]
      );
      result = await db.query(`SELECT * FROM part_categories WHERE business_unit_id = ? AND category_code = ?`, [business_unit_id, category_code]);
    } else {
      result = await db.query(
        `INSERT INTO part_categories (business_unit_id, category_code, category_name, description, icon, parent_category_id, display_order, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [business_unit_id, category_code, category_name, description || null, icon, parent_category_id, display_order, req.user.id]
      );
    }
    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Create part category error:', error);
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
    const { category_name, description, icon, parent_category_id, display_order } = req.body;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const updates = [];
    const params = [];
    let paramCount = 0;

    if (category_name !== undefined) { paramCount++; updates.push(`category_name = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`); params.push(category_name); }
    if (description !== undefined) { paramCount++; updates.push(`description = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`); params.push(description); }
    if (icon !== undefined) { paramCount++; updates.push(`icon = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`); params.push(icon); }
    if (parent_category_id !== undefined) { paramCount++; updates.push(`parent_category_id = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`); params.push(parent_category_id); }
    if (display_order !== undefined) { paramCount++; updates.push(`display_order = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`); params.push(display_order); }
    if (updates.length === 0) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No fields to update' } });
    }

    paramCount++;
    params.push(id);

    if (dbType === 'mysql') {
      await db.query(`UPDATE part_categories SET ${updates.join(', ')} WHERE id = ?`, params);
      const result = await db.query(`SELECT * FROM part_categories WHERE id = ?`, [id]);
      res.json(result.rows[0]);
    } else {
      const result = await db.query(`UPDATE part_categories SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`, params);
      res.json(result.rows[0]);
    }
  } catch (error) {
    logger.error('Update part category error:', error);
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
    await db.query(`UPDATE part_categories SET is_active = false WHERE id = ${placeholder}`, [id]);
    res.json({ message: 'Part category deleted successfully' });
  } catch (error) {
    logger.error('Delete part category error:', error);
    next(error);
  }
});

module.exports = router;


