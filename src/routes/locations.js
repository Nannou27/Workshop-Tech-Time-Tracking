const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// GET /api/v1/locations
router.get('/', async (req, res, next) => {
  try {
    let { business_unit_id, is_active } = req.query;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$';
    
    logger.info(`[LOCATIONS] GET request from user: ${req.user.id}, query BU: ${business_unit_id}`);
    
    // ENFORCE business unit filtering for non-Super Admin users
    // Get user's role and business unit
    const userCheckPlaceholder = dbType === 'mysql' ? '?' : '$1';
    const userResult = await db.query(
      `SELECT u.business_unit_id, r.name as role_name 
       FROM users u 
       JOIN roles r ON u.role_id = r.id 
       WHERE u.id = ${userCheckPlaceholder}`,
      [req.user.id]
    );
    
    logger.info(`[LOCATIONS] User check result:`, userResult.rows[0]);
    
    if (userResult.rows.length > 0) {
      const userRole = userResult.rows[0].role_name;
      const userBusinessUnitId = userResult.rows[0].business_unit_id;
      
      logger.info(`[LOCATIONS] User role: ${userRole}, BU: ${userBusinessUnitId}`);
      
      // If NOT Super Admin, FORCE filter by user's business unit
      // Check role name case-insensitively
      if (userRole && userRole.toLowerCase() !== 'super admin' && userBusinessUnitId) {
        business_unit_id = userBusinessUnitId;
        logger.info(`[SECURITY] ✓ Enforcing business unit filter for ${userRole}: BU ${userBusinessUnitId}`);
      } else if (userRole && userRole.toLowerCase() === 'super admin') {
        logger.info(`[SECURITY] Super Admin access - no business unit filter applied`);
      } else {
        logger.warn(`[SECURITY] ⚠️  User has no business unit assigned: User ID ${req.user.id}, Role: ${userRole}`);
      }
    }
    
    logger.info(`[LOCATIONS] Final query will use BU filter: ${business_unit_id || 'NONE'}`);
    
    let query = `
      SELECT l.*, bu.name as business_unit_name, bu.code as business_unit_code
      FROM locations l
      LEFT JOIN business_units bu ON l.business_unit_id = bu.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;
    
    if (business_unit_id) {
      paramCount++;
      query += ` AND l.business_unit_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(business_unit_id);
    }
    
    if (is_active !== undefined) {
      paramCount++;
      query += ` AND l.is_active = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(is_active === 'true' || is_active === true);
    }
    
    query += ` ORDER BY l.name ASC`;
    
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    logger.error('Get locations error:', error);
    next(error);
  }
});

// GET /api/v1/locations/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    const result = await db.query(
      `SELECT l.*, bu.name as business_unit_name, bu.code as business_unit_code
       FROM locations l
       LEFT JOIN business_units bu ON l.business_unit_id = bu.id
       WHERE l.id = ${placeholder}`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Location not found'
        }
      });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Get location error:', error);
    next(error);
  }
});

// POST /api/v1/locations
router.post('/', requireAdmin, [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('business_unit_id').notEmpty().withMessage('Business unit ID is required'),
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
    
    let { 
      name, 
      address, 
      city, 
      state, 
      country = 'UAE', 
      postal_code, 
      phone, 
      email,
      business_unit_id,
      is_active = true,
      metadata = {}
    } = req.body;
    
    const dbType = process.env.DB_TYPE || 'postgresql';
    
    // BUSINESS UNIT ADMIN SCOPING: BU Admins can only create locations in their OWN BU
    const userCheckPlaceholder = dbType === 'mysql' ? '?' : '$1';
    const userResult = await db.query(
      `SELECT u.business_unit_id, r.name as role_name 
       FROM users u 
       JOIN roles r ON u.role_id = r.id 
       WHERE u.id = ${userCheckPlaceholder}`,
      [req.user.id]
    );
    
    if (userResult.rows.length > 0) {
      const userRole = userResult.rows[0].role_name;
      const userBusinessUnitId = userResult.rows[0].business_unit_id;
      
      // If Business Unit Admin, FORCE their business unit
      if (userRole && userRole.toLowerCase().includes('business unit admin')) {
        if (!userBusinessUnitId) {
          return res.status(403).json({
            error: {
              code: 'AUTHORIZATION_FAILED',
              message: 'BU Admin must be assigned to a business unit'
            }
          });
        }
        
        // Override the business_unit_id with user's BU (prevent cross-BU creation)
        if (business_unit_id && business_unit_id !== userBusinessUnitId) {
          logger.warn(`[SECURITY] BU Admin attempted to create location in another BU. User BU: ${userBusinessUnitId}, Requested BU: ${business_unit_id}`);
        }
        business_unit_id = userBusinessUnitId;
        logger.info(`[SECURITY] BU Admin creating location in their BU: ${userBusinessUnitId}`);
      }
    }
    
    // Verify business unit exists
    const buPlaceholder = dbType === 'mysql' ? '?' : '$1';
    const buCheck = await db.query(
      `SELECT id FROM business_units WHERE id = ${buPlaceholder}`,
      [business_unit_id]
    );
    
    if (buCheck.rows.length === 0) {
      return res.status(400).json({
        error: {
          code: 'INVALID_BUSINESS_UNIT',
          message: 'Business unit not found'
        }
      });
    }
    
    const insertPlaceholder = dbType === 'mysql' ? '?' : '$1';
    const metadataValue = dbType === 'mysql' ? JSON.stringify(metadata) : metadata;
    
    let result;
    if (dbType === 'mysql') {
      result = await db.query(
        `INSERT INTO locations (name, address, city, state, country, postal_code, phone, email, business_unit_id, is_active, metadata, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, address || null, city || null, state || null, country, postal_code || null, phone || null, email || null, business_unit_id, is_active, metadataValue, req.user.id]
      );
      
      result = await db.query(
        `SELECT l.*, bu.name as business_unit_name, bu.code as business_unit_code
         FROM locations l
         LEFT JOIN business_units bu ON l.business_unit_id = bu.id
         WHERE l.id = LAST_INSERT_ID()`
      );
    } else {
      result = await db.query(
        `INSERT INTO locations (name, address, city, state, country, postal_code, phone, email, business_unit_id, is_active, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [name, address || null, city || null, state || null, country, postal_code || null, phone || null, email || null, business_unit_id, is_active, metadata, req.user.id]
      );
      
      // Get business unit info
      const buInfo = await db.query(
        `SELECT name, code FROM business_units WHERE id = $1`,
        [business_unit_id]
      );
      
      if (buInfo.rows.length > 0) {
        result.rows[0].business_unit_name = buInfo.rows[0].name;
        result.rows[0].business_unit_code = buInfo.rows[0].code;
      }
    }
    
    // Create audit log
    const auditPlaceholder = dbType === 'mysql' ? '?' : '$1';
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES (${auditPlaceholder}, 'location.created', 'location', ${dbType === 'mysql' ? '?' : '$2'}, ${dbType === 'mysql' ? '?' : '$3'})`,
      [req.user.id, result.rows[0].id, JSON.stringify(req.body)]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Create location error:', error);
    next(error);
  }
});

// PATCH /api/v1/locations/:id
router.patch('/:id', requireAdmin, [
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
    const { 
      name, 
      address, 
      city, 
      state, 
      country, 
      postal_code, 
      phone, 
      email,
      business_unit_id,
      is_active,
      metadata
    } = req.body;
    
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    // Check if location exists
    const existing = await db.query(
      `SELECT * FROM locations WHERE id = ${placeholder}`,
      [id]
    );
    
    if (existing.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Location not found'
        }
      });
    }
    
    // Verify business unit exists if changing
    if (business_unit_id && business_unit_id !== existing.rows[0].business_unit_id) {
      const buPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const buCheck = await db.query(
        `SELECT id FROM business_units WHERE id = ${buPlaceholder}`,
        [business_unit_id]
      );
      
      if (buCheck.rows.length === 0) {
        return res.status(400).json({
          error: {
            code: 'INVALID_BUSINESS_UNIT',
            message: 'Business unit not found'
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
    
    if (address !== undefined) {
      paramCount++;
      updates.push(`address = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(address);
    }
    
    if (city !== undefined) {
      paramCount++;
      updates.push(`city = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(city);
    }
    
    if (state !== undefined) {
      paramCount++;
      updates.push(`state = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(state);
    }
    
    if (country !== undefined) {
      paramCount++;
      updates.push(`country = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(country);
    }
    
    if (postal_code !== undefined) {
      paramCount++;
      updates.push(`postal_code = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(postal_code);
    }
    
    if (phone !== undefined) {
      paramCount++;
      updates.push(`phone = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(phone);
    }
    
    if (email !== undefined) {
      paramCount++;
      updates.push(`email = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(email);
    }
    
    if (business_unit_id !== undefined) {
      paramCount++;
      updates.push(`business_unit_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(business_unit_id);
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
        `UPDATE locations SET ${updates.join(', ')} WHERE id = ?`,
        params
      );
      
      result = await db.query(
        `SELECT l.*, bu.name as business_unit_name, bu.code as business_unit_code
         FROM locations l
         LEFT JOIN business_units bu ON l.business_unit_id = bu.id
         WHERE l.id = ?`,
        [id]
      );
    } else {
      result = await db.query(
        `UPDATE locations SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
        params
      );
      
      // Get business unit info
      const buId = business_unit_id !== undefined ? business_unit_id : existing.rows[0].business_unit_id;
      const buInfo = await db.query(
        `SELECT name, code FROM business_units WHERE id = $1`,
        [buId]
      );
      
      if (buInfo.rows.length > 0) {
        result.rows[0].business_unit_name = buInfo.rows[0].name;
        result.rows[0].business_unit_code = buInfo.rows[0].code;
      }
    }
    
    // Create audit log
    const auditPlaceholder = dbType === 'mysql' ? '?' : '$1';
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES (${auditPlaceholder}, 'location.updated', 'location', ${dbType === 'mysql' ? '?' : '$2'}, ${dbType === 'mysql' ? '?' : '$3'})`,
      [req.user.id, id, JSON.stringify(req.body)]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Update location error:', error);
    next(error);
  }
});

// DELETE /api/v1/locations/:id
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    // Check if location exists
    const existing = await db.query(
      `SELECT * FROM locations WHERE id = ${placeholder}`,
      [id]
    );
    
    if (existing.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Location not found'
        }
      });
    }
    
    // Check if location has assets
    const assetsCheck = await db.query(
      `SELECT COUNT(*) as count FROM assets WHERE location_id = ${placeholder}`,
      [id]
    );
    
    const assetCount = dbType === 'mysql' 
      ? assetsCheck.rows[0].count 
      : parseInt(assetsCheck.rows[0].count);
    
    if (assetCount > 0) {
      return res.status(400).json({
        error: {
          code: 'HAS_DEPENDENCIES',
          message: `Cannot delete location: it has ${assetCount} asset(s) associated`
        }
      });
    }
    
    // Soft delete by setting is_active to false
    if (dbType === 'mysql') {
      await db.query(
        `UPDATE locations SET is_active = false WHERE id = ?`,
        [id]
      );
    } else {
      await db.query(
        `UPDATE locations SET is_active = false WHERE id = $1`,
        [id]
      );
    }
    
    // Create audit log
    const auditPlaceholder = dbType === 'mysql' ? '?' : '$1';
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES (${auditPlaceholder}, 'location.deleted', 'location', ${dbType === 'mysql' ? '?' : '$2'}, ${dbType === 'mysql' ? '?' : '$3'})`,
      [req.user.id, id, JSON.stringify({ deleted_at: new Date().toISOString() })]
    );
    
    res.json({ message: 'Location deleted successfully' });
  } catch (error) {
    logger.error('Delete location error:', error);
    next(error);
  }
});

module.exports = router;


