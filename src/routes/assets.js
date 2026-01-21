const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// GET /api/v1/assets
router.get('/', async (req, res, next) => {
  try {
    let { business_unit_id, location_id, status, asset_type, barcode, qr_code, search, identifier } = req.query;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$';
    
    // ENFORCE business unit filtering for non-Super Admin users
    const userCheckPlaceholder = dbType === 'mysql' ? '?' : '$1';
    const userResult = await db.query(
      `SELECT u.business_unit_id, r.name as role_name 
       FROM users u 
       JOIN roles r ON u.role_id = r.id 
       WHERE u.id = ${userCheckPlaceholder}`,
      [req.user.id]
    );
    
    let isForcedBusinessUnitFilter = false;
    if (userResult.rows.length > 0) {
      const userRole = userResult.rows[0].role_name;
      const userBusinessUnitId = userResult.rows[0].business_unit_id;
      
      // If NOT Super Admin, FORCE filter by user's business unit
      if (userRole && userRole.toLowerCase() !== 'super admin' && userBusinessUnitId) {
        business_unit_id = userBusinessUnitId;
        isForcedBusinessUnitFilter = true;
        logger.info(`[SECURITY] Enforcing business unit filter for ${userRole}: BU ${userBusinessUnitId}`);
      }
    }
    
    let query = `
      SELECT a.*, 
             bu.name as business_unit_name, 
             bu.code as business_unit_code,
             l.name as location_name,
             parent.name as parent_asset_name
      FROM assets a
      LEFT JOIN business_units bu ON a.business_unit_id = bu.id
      LEFT JOIN locations l ON a.location_id = l.id
      LEFT JOIN assets parent ON a.parent_asset_id = parent.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;
    
    if (business_unit_id) {
      paramCount++;
      // Include legacy/shared assets where business_unit_id is NULL for non–Super Admin users
      // so assets already linked to job cards remain selectable in the UI dropdown.
      if (isForcedBusinessUnitFilter) {
        query += ` AND (a.business_unit_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount} OR a.business_unit_id IS NULL)`;
      } else {
        query += ` AND a.business_unit_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      }
      params.push(business_unit_id);
    }
    
    if (location_id) {
      paramCount++;
      query += ` AND a.location_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(location_id);
    }
    
    if (status) {
      paramCount++;
      query += ` AND a.status = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(status);
    }
    
    if (asset_type) {
      paramCount++;
      query += ` AND a.asset_type = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(asset_type);
    }
    
    if (barcode) {
      paramCount++;
      query += ` AND a.barcode = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(barcode);
    }
    
    if (qr_code) {
      paramCount++;
      query += ` AND a.qr_code = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(qr_code);
    }

    // Identifier lookup: exact match across barcode/qr_code/asset_tag/serial_number (and name as fallback),
    // plus a best-effort JSON metadata license_plate match for vehicle assets (if present).
    if (identifier) {
      const identRaw = String(identifier).trim();
      if (identRaw) {
        const identNormalized = identRaw.toUpperCase().replace(/\s+/g, '');
        if (dbType === 'mysql') {
          // Use repeated placeholders (mysql2 requires separate params for each ?)
          query += ` AND (
            a.barcode = ?
            OR a.qr_code = ?
            OR a.asset_tag = ?
            OR a.serial_number = ?
            OR a.name LIKE ?
            OR UPPER(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.license_plate')), ' ', '')) = ?
          )`;
          params.push(identRaw, identRaw, identRaw, identRaw, `%${identRaw}%`, identNormalized);
        } else {
          // PostgreSQL
          paramCount++;
          const p1 = `$${paramCount}`; params.push(identRaw);
          paramCount++;
          const p2 = `$${paramCount}`; params.push(identRaw);
          paramCount++;
          const p3 = `$${paramCount}`; params.push(identRaw);
          paramCount++;
          const p4 = `$${paramCount}`; params.push(identRaw);
          paramCount++;
          const p5 = `$${paramCount}`; params.push(`%${identRaw}%`);
          paramCount++;
          const p6 = `$${paramCount}`; params.push(identNormalized);
          query += ` AND (
            a.barcode = ${p1}
            OR a.qr_code = ${p2}
            OR a.asset_tag = ${p3}
            OR a.serial_number = ${p4}
            OR a.name ILIKE ${p5}
            OR UPPER(REPLACE(COALESCE(a.metadata->>'license_plate',''), ' ', '')) = ${p6}
          )`;
        }
      }
    }
    
    if (search) {
      paramCount++;
      const searchPattern = dbType === 'mysql' ? `CONCAT('%', ?, '%')` : `$${paramCount}`;
      query += ` AND (a.name LIKE ${searchPattern} OR a.serial_number LIKE ${searchPattern} OR a.asset_tag LIKE ${searchPattern})`;
      const searchValue = `%${search}%`;
      params.push(searchValue);
      if (dbType === 'mysql') {
        params.push(searchValue);
        params.push(searchValue);
      } else {
        paramCount++;
        params.push(searchValue);
        paramCount++;
        params.push(searchValue);
      }
    }
    
    query += ` ORDER BY a.name ASC`;
    
    const result = await db.query(query, params);
    // Extract currency_code from metadata to a top-level field for easy UI formatting
    const rows = (result.rows || []).map(r => {
      let meta = r.metadata;
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { meta = null; }
      }
      const currency_code = (meta && typeof meta === 'object' && meta.currency_code) ? String(meta.currency_code) : null;
      return { ...r, currency_code };
    });
    res.json(rows);
  } catch (error) {
    logger.error('Get assets error:', error);
    next(error);
  }
});

// GET /api/v1/assets/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    const result = await db.query(
      `SELECT a.*, 
              bu.name as business_unit_name, 
              bu.code as business_unit_code,
              l.name as location_name,
              parent.name as parent_asset_name
       FROM assets a
       LEFT JOIN business_units bu ON a.business_unit_id = bu.id
       LEFT JOIN locations l ON a.location_id = l.id
       LEFT JOIN assets parent ON a.parent_asset_id = parent.id
       WHERE a.id = ${placeholder}`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Asset not found'
        }
      });
    }
    
    const row = result.rows[0];
    let meta = row.metadata;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch { meta = null; }
    }
    if (meta && typeof meta === 'object') {
      row.currency_code = meta.currency_code || null;
    }
    res.json(row);
  } catch (error) {
    logger.error('Get asset error:', error);
    next(error);
  }
});

// POST /api/v1/assets
router.post('/', requireAdmin, [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('business_unit_id').notEmpty().withMessage('Business unit ID is required'),
  body('location_id').notEmpty().withMessage('Location ID is required'),
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
      serial_number,
      barcode,
      qr_code,
      asset_tag,
      cost,
      currency_code,
      purchase_date,
      warranty_expiry,
      business_unit_id,
      location_id,
      parent_asset_id,
      status = 'active',
      asset_type,
      manufacturer,
      model,
      year,
      metadata = {}
    } = req.body;
    
    const dbType = process.env.DB_TYPE || 'postgresql';
    
    // BUSINESS UNIT ADMIN SCOPING: BU Admins can only create assets in their OWN BU
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
        
        // Override the business_unit_id with user's BU
        if (business_unit_id && business_unit_id !== userBusinessUnitId) {
          logger.warn(`[SECURITY] BU Admin attempted to create asset in another BU. User BU: ${userBusinessUnitId}, Requested BU: ${business_unit_id}`);
        }
        business_unit_id = userBusinessUnitId;
        logger.info(`[SECURITY] BU Admin creating asset in their BU: ${userBusinessUnitId}`);
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
    
    // Verify location exists
    const locPlaceholder = dbType === 'mysql' ? '?' : '$1';
    const locCheck = await db.query(
      `SELECT id FROM locations WHERE id = ${locPlaceholder}`,
      [location_id]
    );
    
    if (locCheck.rows.length === 0) {
      return res.status(400).json({
        error: {
          code: 'INVALID_LOCATION',
          message: 'Location not found'
        }
      });
    }
    
    // Check for duplicate barcode/qr_code/asset_tag
    if (barcode) {
      const checkPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const existing = await db.query(
        `SELECT id FROM assets WHERE barcode = ${checkPlaceholder}`,
        [barcode]
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({
          error: {
            code: 'DUPLICATE_BARCODE',
            message: 'Barcode already exists'
          }
        });
      }
    }
    
    if (qr_code) {
      const checkPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const existing = await db.query(
        `SELECT id FROM assets WHERE qr_code = ${checkPlaceholder}`,
        [qr_code]
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({
          error: {
            code: 'DUPLICATE_QR_CODE',
            message: 'QR code already exists'
          }
        });
      }
    }
    
    if (asset_tag) {
      const checkPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const existing = await db.query(
        `SELECT id FROM assets WHERE asset_tag = ${checkPlaceholder}`,
        [asset_tag]
      );
      if (existing.rows.length > 0) {
        return res.status(400).json({
          error: {
            code: 'DUPLICATE_ASSET_TAG',
            message: 'Asset tag already exists'
          }
        });
      }
    }
    
    // Store currency code in metadata for schema-safe multi-currency support
    const enhancedMetadata = (metadata && typeof metadata === 'object') ? { ...metadata } : {};
    if (currency_code) {
      enhancedMetadata.currency_code = String(currency_code).toUpperCase().trim();
    }
    const metadataValue = dbType === 'mysql' ? JSON.stringify(enhancedMetadata) : enhancedMetadata;
    
    let result;
    if (dbType === 'mysql') {
      result = await db.query(
        `INSERT INTO assets (name, serial_number, barcode, qr_code, asset_tag, cost, purchase_date, warranty_expiry, business_unit_id, location_id, parent_asset_id, status, asset_type, manufacturer, model, year, metadata, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, serial_number || null, barcode || null, qr_code || null, asset_tag || null, cost || null, purchase_date || null, warranty_expiry || null, business_unit_id, location_id, parent_asset_id || null, status, asset_type || null, manufacturer || null, model || null, year || null, metadataValue, req.user.id]
      );
      
      result = await db.query(
        `SELECT a.*, 
                bu.name as business_unit_name, 
                bu.code as business_unit_code,
                l.name as location_name,
                parent.name as parent_asset_name
         FROM assets a
         LEFT JOIN business_units bu ON a.business_unit_id = bu.id
         LEFT JOIN locations l ON a.location_id = l.id
         LEFT JOIN assets parent ON a.parent_asset_id = parent.id
         WHERE a.id = LAST_INSERT_ID()`
      );
    } else {
      result = await db.query(
        `INSERT INTO assets (name, serial_number, barcode, qr_code, asset_tag, cost, purchase_date, warranty_expiry, business_unit_id, location_id, parent_asset_id, status, asset_type, manufacturer, model, year, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         RETURNING *`,
        [name, serial_number || null, barcode || null, qr_code || null, asset_tag || null, cost || null, purchase_date || null, warranty_expiry || null, business_unit_id, location_id, parent_asset_id || null, status, asset_type || null, manufacturer || null, model || null, year || null, enhancedMetadata, req.user.id]
      );
      
      // Get related info
      const relatedInfo = await db.query(
        `SELECT bu.name, bu.code FROM business_units bu WHERE bu.id = $1
         UNION ALL
         SELECT l.name, NULL FROM locations l WHERE l.id = $2`,
        [business_unit_id, location_id]
      );
      
      if (relatedInfo.rows.length > 0) {
        result.rows[0].business_unit_name = relatedInfo.rows[0].name;
        result.rows[0].business_unit_code = relatedInfo.rows[0].code;
        if (relatedInfo.rows.length > 1) {
          result.rows[0].location_name = relatedInfo.rows[1].name;
        }
      }
    }
    
    // Log barcode scan if provided
    if (barcode || qr_code) {
      const scanPlaceholder = dbType === 'mysql' ? '?' : '$1';
      await db.query(
        `INSERT INTO barcode_scans (barcode, qr_code, entity_type, entity_id, scanned_by, scan_type, location_id)
         VALUES (${scanPlaceholder}, ${dbType === 'mysql' ? '?' : '$2'}, 'asset', ${dbType === 'mysql' ? '?' : '$3'}, ${dbType === 'mysql' ? '?' : '$4'}, 'create', ${dbType === 'mysql' ? '?' : '$5'})`,
        [barcode || null, qr_code || null, result.rows[0].id, req.user.id, location_id]
      );
    }
    
    // Create audit log
    const auditPlaceholder = dbType === 'mysql' ? '?' : '$1';
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES (${auditPlaceholder}, 'asset.created', 'asset', ${dbType === 'mysql' ? '?' : '$2'}, ${dbType === 'mysql' ? '?' : '$3'})`,
      [req.user.id, result.rows[0].id, JSON.stringify(req.body)]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Create asset error:', error);
    next(error);
  }
});

// PATCH /api/v1/assets/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { 
      name,
      serial_number,
      barcode,
      qr_code,
      asset_tag,
      cost,
      currency_code,
      purchase_date,
      warranty_expiry,
      business_unit_id,
      location_id,
      parent_asset_id,
      status,
      asset_type,
      manufacturer,
      model,
      year,
      metadata
    } = req.body;
    
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    // Check if asset exists
    const existing = await db.query(
      `SELECT * FROM assets WHERE id = ${placeholder}`,
      [id]
    );
    
    if (existing.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Asset not found'
        }
      });
    }
    
    // Check for duplicate barcode/qr_code/asset_tag if changing
    if (barcode && barcode !== existing.rows[0].barcode) {
      const checkPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const existingBarcode = await db.query(
        `SELECT id FROM assets WHERE barcode = ${checkPlaceholder} AND id != ${dbType === 'mysql' ? '?' : '$2'}`,
        dbType === 'mysql' ? [barcode, id] : [barcode, id]
      );
      if (existingBarcode.rows.length > 0) {
        return res.status(400).json({
          error: {
            code: 'DUPLICATE_BARCODE',
            message: 'Barcode already exists'
          }
        });
      }
    }
    
    const updates = [];
    const params = [];
    let paramCount = 0;
    const oldLocationId = existing.rows[0].location_id;
    
    if (name !== undefined) {
      paramCount++;
      updates.push(`name = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(name);
    }
    
    if (serial_number !== undefined) {
      paramCount++;
      updates.push(`serial_number = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(serial_number);
    }
    
    if (barcode !== undefined) {
      paramCount++;
      updates.push(`barcode = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(barcode);
    }
    
    if (qr_code !== undefined) {
      paramCount++;
      updates.push(`qr_code = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(qr_code);
    }
    
    if (asset_tag !== undefined) {
      paramCount++;
      updates.push(`asset_tag = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(asset_tag);
    }
    
    if (cost !== undefined) {
      paramCount++;
      updates.push(`cost = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(cost);
    }
    
    if (purchase_date !== undefined) {
      paramCount++;
      updates.push(`purchase_date = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(purchase_date);
    }
    
    if (warranty_expiry !== undefined) {
      paramCount++;
      updates.push(`warranty_expiry = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(warranty_expiry);
    }
    
    if (business_unit_id !== undefined) {
      paramCount++;
      updates.push(`business_unit_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(business_unit_id);
    }
    
    if (location_id !== undefined) {
      paramCount++;
      updates.push(`location_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(location_id);
    }
    
    if (parent_asset_id !== undefined) {
      paramCount++;
      updates.push(`parent_asset_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(parent_asset_id);
    }
    
    if (status !== undefined) {
      paramCount++;
      updates.push(`status = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(status);
    }
    
    if (asset_type !== undefined) {
      paramCount++;
      updates.push(`asset_type = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(asset_type);
    }
    
    if (manufacturer !== undefined) {
      paramCount++;
      updates.push(`manufacturer = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(manufacturer);
    }
    
    if (model !== undefined) {
      paramCount++;
      updates.push(`model = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(model);
    }
    
    if (year !== undefined) {
      paramCount++;
      updates.push(`year = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(year);
    }
    
    // Merge metadata updates to avoid wiping existing metadata; allow currency_code update without full metadata.
    if (metadata !== undefined || currency_code !== undefined) {
      let existingMeta = existing.rows[0].metadata;
      if (typeof existingMeta === 'string') {
        try { existingMeta = JSON.parse(existingMeta); } catch { existingMeta = {}; }
      }
      existingMeta = (existingMeta && typeof existingMeta === 'object') ? existingMeta : {};
      const incomingMeta = (metadata && typeof metadata === 'object') ? metadata : {};
      const merged = { ...existingMeta, ...incomingMeta };
      if (currency_code !== undefined) {
        merged.currency_code = currency_code ? String(currency_code).toUpperCase().trim() : null;
      }
      paramCount++;
      const metadataValue = dbType === 'mysql' ? JSON.stringify(merged) : merged;
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
        `UPDATE assets SET ${updates.join(', ')} WHERE id = ?`,
        params
      );
      
      result = await db.query(
        `SELECT a.*, 
                bu.name as business_unit_name, 
                bu.code as business_unit_code,
                l.name as location_name,
                parent.name as parent_asset_name
         FROM assets a
         LEFT JOIN business_units bu ON a.business_unit_id = bu.id
         LEFT JOIN locations l ON a.location_id = l.id
         LEFT JOIN assets parent ON a.parent_asset_id = parent.id
         WHERE a.id = ?`,
        [id]
      );
    } else {
      result = await db.query(
        `UPDATE assets SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
        params
      );
      
      // Get related info
      const finalLocationId = location_id !== undefined ? location_id : oldLocationId;
      const relatedInfo = await db.query(
        `SELECT bu.name, bu.code FROM business_units bu WHERE bu.id = $1
         UNION ALL
         SELECT l.name, NULL FROM locations l WHERE l.id = $2`,
        [business_unit_id || existing.rows[0].business_unit_id, finalLocationId]
      );
      
      if (relatedInfo.rows.length > 0) {
        result.rows[0].business_unit_name = relatedInfo.rows[0].name;
        result.rows[0].business_unit_code = relatedInfo.rows[0].code;
        if (relatedInfo.rows.length > 1) {
          result.rows[0].location_name = relatedInfo.rows[1].name;
        }
      }
    }
    
    // Log location change if location was updated
    if (location_id !== undefined && location_id !== oldLocationId) {
      const movementPlaceholder = dbType === 'mysql' ? '?' : '$1';
      await db.query(
        `INSERT INTO asset_movements (asset_id, from_location_id, to_location_id, moved_by, movement_type)
         VALUES (${movementPlaceholder}, ${dbType === 'mysql' ? '?' : '$2'}, ${dbType === 'mysql' ? '?' : '$3'}, ${dbType === 'mysql' ? '?' : '$4'}, 'transfer')`,
        [id, oldLocationId, location_id, req.user.id]
      );
    }
    
    // Create audit log
    const auditPlaceholder = dbType === 'mysql' ? '?' : '$1';
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES (${auditPlaceholder}, 'asset.updated', 'asset', ${dbType === 'mysql' ? '?' : '$2'}, ${dbType === 'mysql' ? '?' : '$3'})`,
      [req.user.id, id, JSON.stringify(req.body)]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Update asset error:', error);
    next(error);
  }
});

// GET /api/v1/assets/:id/work-orders
router.get('/:id/work-orders', async (req, res, next) => {
  try {
    const { id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    const result = await db.query(
      `SELECT jc.*, 
              COUNT(DISTINCT a.id) as assignment_count,
              COUNT(DISTINCT CASE WHEN a.status = 'completed' THEN a.id END) as completed_assignments
       FROM job_cards jc
       LEFT JOIN assignments a ON jc.id = a.job_card_id
       WHERE jc.asset_id = ${placeholder}
       GROUP BY jc.id
       ORDER BY jc.created_at DESC`,
      [id]
    );
    
    res.json(result.rows);
  } catch (error) {
    logger.error('Get asset work orders error:', error);
    next(error);
  }
});

// GET /api/v1/assets/:id/movements
router.get('/:id/movements', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { start_date, end_date } = req.query;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$';

    // Check if asset_movements table exists
    const checkQuery = dbType === 'mysql'
      ? `SHOW TABLES LIKE 'asset_movements'`
      : `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'asset_movements') as exists`;
    const tableCheck = await db.query(checkQuery);
    const movementsTableExists = dbType === 'mysql' ? tableCheck.rows.length > 0 : tableCheck.rows[0].exists;
    
    if (!movementsTableExists) {
      return res.json({ data: [] });
    }

    let queryText = `
      SELECT am.*,
             from_loc.name as from_location_name,
             to_loc.name as to_location_name,
             u.display_name as moved_by_name
      FROM asset_movements am
      LEFT JOIN locations from_loc ON am.from_location_id = from_loc.id
      LEFT JOIN locations to_loc ON am.to_location_id = to_loc.id
      LEFT JOIN users u ON am.moved_by = u.id
      WHERE am.asset_id = ${placeholder}1
    `;
    const params = [id];
    let paramCount = 1;

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

    queryText += ' ORDER BY am.moved_at DESC';

    const result = await db.query(queryText, params);

    res.json({ data: result.rows });
  } catch (error) {
    logger.error('Get asset movements error:', error);
    next(error);
  }
});

module.exports = router;

