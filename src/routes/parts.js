const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireAdmin, requireAdminOrServiceAdvisor } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Helper function to check if column exists in table
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

// GET /api/v1/parts
router.get('/', async (req, res, next) => {
  try {
    let { parent_asset_id, location_id, status, barcode, qr_code, search } = req.query;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$';
    
    // Check if users.business_unit_id column exists (schema tolerance)
    const hasUsersBU = await columnExists('users', 'business_unit_id');
    
    // ENFORCE business unit filtering for non-Super Admin users
    const userCheckPlaceholder = dbType === 'mysql' ? '?' : '$1';
    
    let userBusinessUnitId = null;
    let userRole = null;
    
    if (hasUsersBU) {
      const userResult = await db.query(
        `SELECT u.business_unit_id, r.name as role_name 
         FROM users u 
         JOIN roles r ON u.role_id = r.id 
         WHERE u.id = ${userCheckPlaceholder}`,
        [req.user.id]
      );
      
      if (userResult.rows.length > 0) {
        userRole = userResult.rows[0].role_name;
        userBusinessUnitId = userResult.rows[0].business_unit_id;
        
        // Log enforcement for non-Super Admin
        if (userRole && userRole.toLowerCase() !== 'super admin' && userBusinessUnitId) {
          logger.info(`[SECURITY] Enforcing business unit filter for ${userRole}: BU ${userBusinessUnitId}`);
        }
      }
    } else {
      // Just get the role without business_unit_id
      const userResult = await db.query(
        `SELECT r.name as role_name 
         FROM users u 
         JOIN roles r ON u.role_id = r.id 
         WHERE u.id = ${userCheckPlaceholder}`,
        [req.user.id]
      );
      
      if (userResult.rows.length > 0) {
        userRole = userResult.rows[0].role_name;
        if (userRole && userRole.toLowerCase() !== 'super admin') {
          logger.warn(`[SECURITY] Cannot enforce business unit filter for ${userRole} - users.business_unit_id column missing`);
        }
      }
    }
    
    let query = `
      SELECT p.*, 
             a.name as parent_asset_name,
             a.asset_tag as parent_asset_tag,
             l.name as location_name,
             l.business_unit_id as location_business_unit_id
      FROM parts p
      LEFT JOIN assets a ON p.parent_asset_id = a.id
      LEFT JOIN locations l ON p.location_id = l.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;
    
    // Filter by business unit (for non-Super Admin)
    // - Inventory parts may have no location_id; those are scoped via metadata.business_unit_id.
    // - Asset-linked parts can be scoped via location.business_unit_id.
    if (userBusinessUnitId && userRole && userRole.toLowerCase() !== 'super admin') {
      if (dbType === 'mysql') {
        query += ` AND (
          l.business_unit_id = ?
          OR CAST(JSON_UNQUOTE(JSON_EXTRACT(p.metadata, '$.business_unit_id')) AS UNSIGNED) = ?
        )`;
        params.push(userBusinessUnitId, userBusinessUnitId);
      } else {
        paramCount++;
        query += ` AND COALESCE((p.metadata->>'business_unit_id')::int, l.business_unit_id) = $${paramCount}`;
        params.push(userBusinessUnitId);
      }
    }
    
    if (parent_asset_id) {
      paramCount++;
      query += ` AND p.parent_asset_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(parent_asset_id);
    }
    
    if (location_id) {
      paramCount++;
      query += ` AND p.location_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(location_id);
    }
    
    if (status) {
      paramCount++;
      query += ` AND p.status = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(status);
    }
    
    if (barcode) {
      paramCount++;
      query += ` AND p.barcode = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(barcode);
    }
    
    if (qr_code) {
      paramCount++;
      query += ` AND p.qr_code = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(qr_code);
    }
    
    if (search) {
      paramCount++;
      const searchPattern = dbType === 'mysql' ? `CONCAT('%', ?, '%')` : `$${paramCount}`;
      query += ` AND (p.name LIKE ${searchPattern} OR p.part_number LIKE ${searchPattern} OR p.serial_number LIKE ${searchPattern})`;
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
    
    query += ` ORDER BY p.name ASC`;
    
    const result = await db.query(query, params);
    
    // Extract metadata fields to top level for easier UI access
    const parts = result.rows.map(part => {
      if (part.metadata) {
        const meta = typeof part.metadata === 'string' ? JSON.parse(part.metadata) : part.metadata;
        return {
          ...part,
          description: meta.description || null,
          category: meta.category || null,
          quantity_in_stock: meta.quantity_in_stock || 0,
          business_unit_id: meta.business_unit_id || part.location_business_unit_id,
          currency_code: meta.currency_code || null
        };
      }
      return part;
    });
    
    res.json({ data: parts });
  } catch (error) {
    logger.error('Get parts error:', error);
    next(error);
  }
});

// GET /api/v1/parts/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    const result = await db.query(
      `SELECT p.*, 
              a.name as parent_asset_name,
              a.asset_tag as parent_asset_tag,
              l.name as location_name
       FROM parts p
       LEFT JOIN assets a ON p.parent_asset_id = a.id
       LEFT JOIN locations l ON p.location_id = l.id
       WHERE p.id = ${placeholder}`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Part not found'
        }
      });
    }

    // Extract metadata fields to top level for easier UI access (keep consistent with list endpoint)
    const row = result.rows[0];
    if (row.metadata) {
      try {
        const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
        if (meta && typeof meta === 'object') {
          row.description = meta.description || null;
          row.category = meta.category || null;
          row.quantity_in_stock = meta.quantity_in_stock || 0;
          row.business_unit_id = meta.business_unit_id || null;
          row.currency_code = meta.currency_code || null;
        }
      } catch (e) {
        // ignore metadata parse issues; return raw row
      }
    }

    res.json(row);
  } catch (error) {
    logger.error('Get part error:', error);
    next(error);
  }
});

// POST /api/v1/parts
router.post('/', requireAdminOrServiceAdvisor, [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('part_number').optional().trim(),
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
    
    const {
      name,
      part_number,
      description,
      serial_number,
      barcode,
      qr_code,
      cost,
      currency_code,
      quantity_in_stock,
      category,
      parent_asset_id: requested_parent_asset_id,
      location_id,
      business_unit_id,
      status = 'active',
      manufacturer,
      metadata = {}
    } = req.body;

    // parent_asset_id may be enforced (inventory fallback) depending on schema; keep it mutable.
    let parent_asset_id = requested_parent_asset_id;
    
    const dbType = process.env.DB_TYPE || 'postgresql';
    
    // Get user's business unit for scoping
    let finalBusinessUnitId = business_unit_id;
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
      
      // Service Advisors and BU Admins can only create parts in their BU
      if (userRole === 'ServiceAdvisor' || userRole.toLowerCase().includes('business unit admin')) {
        if (!userBusinessUnitId) {
          return res.status(403).json({
            error: {
              code: 'AUTHORIZATION_FAILED',
              message: 'You must be assigned to a business unit'
            }
          });
        }
        finalBusinessUnitId = userBusinessUnitId;
      }
    }
    
    // If parent_asset_id provided, verify it exists AND get its business_unit_id/location_id
    let parentAssetRow = null;
    if (parent_asset_id) {
      const assetPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const assetCheck = await db.query(
        `SELECT id, location_id, business_unit_id FROM assets WHERE id = ${assetPlaceholder}`,
        [parent_asset_id]
      );
      
      if (assetCheck.rows.length === 0) {
        return res.status(400).json({
          error: {
            code: 'INVALID_ASSET',
            message: 'Parent asset not found'
          }
        });
      }
      
      // Use asset's business unit if not set
      if (!finalBusinessUnitId) {
        finalBusinessUnitId = assetCheck.rows[0].business_unit_id;
      }

      parentAssetRow = assetCheck.rows[0];
    }
    
    // Use asset's location if location_id not provided (for asset parts)
    const finalLocationId = parent_asset_id ? (location_id || parentAssetRow?.location_id || null) : (location_id || null);

    // Some deployments still have parts.parent_asset_id as NOT NULL.
    // To keep production working without manual DB intervention, if parent_asset_id is missing
    // and the schema requires it, we create (or reuse) a per-business-unit "Inventory" asset
    // and attach inventory parts to it.
    if (!parent_asset_id && dbType === 'mysql') {
      try {
        const nullableCheck = await db.query(
          `SELECT IS_NULLABLE
           FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'parts'
             AND COLUMN_NAME = 'parent_asset_id'`
        );
        const isNullable = nullableCheck.rows.length > 0 && String(nullableCheck.rows[0].IS_NULLABLE).toUpperCase() === 'YES';

        if (!isNullable) {
          // Need a BU-scoped "Inventory" asset to satisfy NOT NULL constraint
          if (!finalBusinessUnitId) {
            return res.status(400).json({
              error: {
                code: 'BUSINESS_UNIT_REQUIRED',
                message: 'Business unit is required to create inventory parts'
              }
            });
          }

          // Pick an active location in this BU (assets.location_id is NOT NULL)
          const loc = await db.query(
            `SELECT id FROM locations WHERE business_unit_id = ? AND is_active = true ORDER BY id ASC LIMIT 1`,
            [finalBusinessUnitId]
          );
          if (loc.rows.length === 0) {
            return res.status(400).json({
              error: {
                code: 'LOCATION_REQUIRED',
                message: 'No active location found for this business unit. Create a location first.'
              }
            });
          }
          const inventoryLocationId = loc.rows[0].id;

          const inventoryTag = `INVENTORY-BU-${finalBusinessUnitId}`;
          const existingInv = await db.query(
            `SELECT id FROM assets WHERE asset_tag = ? LIMIT 1`,
            [inventoryTag]
          );

          let inventoryAssetId;
          if (existingInv.rows.length > 0) {
            inventoryAssetId = existingInv.rows[0].id;
          } else {
            await db.query(
              `INSERT INTO assets (name, asset_tag, business_unit_id, location_id, status, asset_type, created_by, metadata)
               VALUES (?, ?, ?, ?, 'active', 'Inventory', ?, ?)`,
              [
                'Inventory',
                inventoryTag,
                finalBusinessUnitId,
                inventoryLocationId,
                req.user.id,
                JSON.stringify({ system: true, purpose: 'parts_inventory_container' })
              ]
            );
            const createdInv = await db.query(`SELECT id FROM assets WHERE asset_tag = ? LIMIT 1`, [inventoryTag]);
            inventoryAssetId = createdInv.rows[0].id;
          }

          // Attach this part to inventory asset to satisfy NOT NULL schema
          parent_asset_id = inventoryAssetId;
        }
      } catch (e) {
        // If schema introspection fails, continue; the insert will error and be surfaced by error handler/logs.
      }
    }
    
    // Check for duplicate barcode/qr_code
    if (barcode) {
      const checkPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const existing = await db.query(
        `SELECT id FROM parts WHERE barcode = ${checkPlaceholder}`,
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
        `SELECT id FROM parts WHERE qr_code = ${checkPlaceholder}`,
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
    
    // Store additional fields in metadata for now (until schema is updated)
    const enhancedMetadata = {
      ...metadata,
      description: description || null,
      category: category || null,
      quantity_in_stock: quantity_in_stock || 0,
      business_unit_id: finalBusinessUnitId,
      currency_code: currency_code ? String(currency_code).toUpperCase().trim() : (metadata?.currency_code ? String(metadata.currency_code).toUpperCase().trim() : null)
    };
    
    const metadataValue = dbType === 'mysql' ? JSON.stringify(enhancedMetadata) : enhancedMetadata;
    
    let result;
    if (dbType === 'mysql') {
      result = await db.query(
        `INSERT INTO parts (name, part_number, serial_number, barcode, qr_code, cost, parent_asset_id, location_id, status, manufacturer, metadata, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, part_number || null, serial_number || null, barcode || null, qr_code || null, cost || null, parent_asset_id || null, finalLocationId || null, status, manufacturer || null, metadataValue, req.user.id]
      );
      
      result = await db.query(
        `SELECT p.*, 
                a.name as parent_asset_name,
                a.asset_tag as parent_asset_tag,
                l.name as location_name
         FROM parts p
         LEFT JOIN assets a ON p.parent_asset_id = a.id
         LEFT JOIN locations l ON p.location_id = l.id
         WHERE p.id = LAST_INSERT_ID()`
      );
      
      // Extract metadata fields to top level for easier access
      if (result.rows[0].metadata) {
        const meta = typeof result.rows[0].metadata === 'string' ? JSON.parse(result.rows[0].metadata) : result.rows[0].metadata;
        result.rows[0].description = meta.description;
        result.rows[0].category = meta.category;
        result.rows[0].quantity_in_stock = meta.quantity_in_stock;
        result.rows[0].currency_code = meta.currency_code || null;
      }
    } else {
      result = await db.query(
        `INSERT INTO parts (name, part_number, serial_number, barcode, qr_code, cost, parent_asset_id, location_id, status, manufacturer, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [name, part_number || null, serial_number || null, barcode || null, qr_code || null, cost || null, parent_asset_id || null, finalLocationId || null, status, manufacturer || null, enhancedMetadata, req.user.id]
      );
      
      // Extract metadata fields to top level
      if (result.rows[0].metadata) {
        result.rows[0].description = result.rows[0].metadata.description;
        result.rows[0].category = result.rows[0].metadata.category;
        result.rows[0].quantity_in_stock = result.rows[0].metadata.quantity_in_stock;
        result.rows[0].currency_code = result.rows[0].metadata.currency_code || null;
      }
      
      // Get related info
      const relatedInfo = await db.query(
        `SELECT a.name, a.asset_tag FROM assets a WHERE a.id = $1
         UNION ALL
         SELECT l.name, NULL FROM locations l WHERE l.id = $2`,
        [parent_asset_id, finalLocationId]
      );
      
      if (relatedInfo.rows.length > 0) {
        result.rows[0].parent_asset_name = relatedInfo.rows[0].name;
        result.rows[0].parent_asset_tag = relatedInfo.rows[0].asset_tag;
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
         VALUES (${scanPlaceholder}, ${dbType === 'mysql' ? '?' : '$2'}, 'part', ${dbType === 'mysql' ? '?' : '$3'}, ${dbType === 'mysql' ? '?' : '$4'}, 'create', ${dbType === 'mysql' ? '?' : '$5'})`,
        [barcode || null, qr_code || null, result.rows[0].id, req.user.id, finalLocationId]
      );
    }
    
    // Create audit log
    const auditPlaceholder = dbType === 'mysql' ? '?' : '$1';
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES (${auditPlaceholder}, 'part.created', 'part', ${dbType === 'mysql' ? '?' : '$2'}, ${dbType === 'mysql' ? '?' : '$3'})`,
      [req.user.id, result.rows[0].id, JSON.stringify(req.body)]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Create part error:', error);
    next(error);
  }
});

// PATCH /api/v1/parts/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { 
      name,
      part_number,
      serial_number,
      barcode,
      qr_code,
      cost,
      currency_code,
      parent_asset_id,
      location_id,
      status,
      manufacturer,
      metadata
    } = req.body;
    
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    // Check if part exists
    const existing = await db.query(
      `SELECT * FROM parts WHERE id = ${placeholder}`,
      [id]
    );
    
    if (existing.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Part not found'
        }
      });
    }
    
    // Check for duplicate barcode/qr_code if changing
    if (barcode && barcode !== existing.rows[0].barcode) {
      const checkPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const existingBarcode = await db.query(
        `SELECT id FROM parts WHERE barcode = ${checkPlaceholder} AND id != ${dbType === 'mysql' ? '?' : '$2'}`,
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
    
    if (name !== undefined) {
      paramCount++;
      updates.push(`name = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(name);
    }
    
    if (part_number !== undefined) {
      paramCount++;
      updates.push(`part_number = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(part_number);
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
    
    if (cost !== undefined) {
      paramCount++;
      updates.push(`cost = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(cost);
    }
    
    if (parent_asset_id !== undefined) {
      paramCount++;
      updates.push(`parent_asset_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(parent_asset_id);
    }
    
    if (location_id !== undefined) {
      paramCount++;
      updates.push(`location_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(location_id);
    }
    
    if (status !== undefined) {
      paramCount++;
      updates.push(`status = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(status);
    }
    
    if (manufacturer !== undefined) {
      paramCount++;
      updates.push(`manufacturer = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
      params.push(manufacturer);
    }
    
    // Merge metadata updates to avoid wiping existing metadata.
    // Also allow currency_code to be updated without requiring callers to send full metadata.
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
        `UPDATE parts SET ${updates.join(', ')} WHERE id = ?`,
        params
      );
      
      result = await db.query(
        `SELECT p.*, 
                a.name as parent_asset_name,
                a.asset_tag as parent_asset_tag,
                l.name as location_name
         FROM parts p
         LEFT JOIN assets a ON p.parent_asset_id = a.id
         LEFT JOIN locations l ON p.location_id = l.id
         WHERE p.id = ?`,
        [id]
      );
    } else {
      result = await db.query(
        `UPDATE parts SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
        params
      );
      
      // Get related info
      const finalParentAssetId = parent_asset_id !== undefined ? parent_asset_id : existing.rows[0].parent_asset_id;
      const finalLocationId = location_id !== undefined ? location_id : existing.rows[0].location_id;
      
      const relatedInfo = await db.query(
        `SELECT a.name, a.asset_tag FROM assets a WHERE a.id = $1
         UNION ALL
         SELECT l.name, NULL FROM locations l WHERE l.id = $2`,
        [finalParentAssetId, finalLocationId]
      );
      
      if (relatedInfo.rows.length > 0) {
        result.rows[0].parent_asset_name = relatedInfo.rows[0].name;
        result.rows[0].parent_asset_tag = relatedInfo.rows[0].asset_tag;
        if (relatedInfo.rows.length > 1) {
          result.rows[0].location_name = relatedInfo.rows[1].name;
        }
      }
    }
    
    // Create audit log
    const auditPlaceholder = dbType === 'mysql' ? '?' : '$1';
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES (${auditPlaceholder}, 'part.updated', 'part', ${dbType === 'mysql' ? '?' : '$2'}, ${dbType === 'mysql' ? '?' : '$3'})`,
      [req.user.id, id, JSON.stringify(req.body)]
    );
    
    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Update part error:', error);
    next(error);
  }
});

// DELETE /api/v1/parts/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    // Check if part exists
    const existing = await db.query(
      `SELECT * FROM parts WHERE id = ${placeholder}`,
      [id]
    );
    
    if (existing.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'Part not found'
        }
      });
    }
    
    // Check if part is used in work orders
    const workOrderCheck = await db.query(
      `SELECT COUNT(*) as count FROM work_order_parts WHERE part_id = ${placeholder}`,
      [id]
    );
    
    const workOrderCount = dbType === 'mysql' 
      ? workOrderCheck.rows[0].count 
      : parseInt(workOrderCheck.rows[0].count);
    
    if (workOrderCount > 0) {
      return res.status(400).json({
        error: {
          code: 'HAS_DEPENDENCIES',
          message: `Cannot delete part: it is used in ${workOrderCount} work order(s)`
        }
      });
    }
    
    // Hard delete (parts are child records, safe to delete)
    await db.query(
      `DELETE FROM parts WHERE id = ${placeholder}`,
      [id]
    );
    
    // Create audit log
    const auditPlaceholder = dbType === 'mysql' ? '?' : '$1';
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES (${auditPlaceholder}, 'part.deleted', 'part', ${dbType === 'mysql' ? '?' : '$2'}, ${dbType === 'mysql' ? '?' : '$3'})`,
      [req.user.id, id, JSON.stringify({ deleted_at: new Date().toISOString() })]
    );
    
    res.json({ message: 'Part deleted successfully' });
  } catch (error) {
    logger.error('Delete part error:', error);
    next(error);
  }
});

// GET /api/v1/parts/:id/work-orders
router.get('/:id/work-orders', async (req, res, next) => {
  try {
    const { id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    const result = await db.query(
      `SELECT jc.*, 
              wop.quantity,
              wop.unit_cost,
              wop.total_cost,
              wop.installed_at,
              u.display_name as installed_by_name
       FROM work_order_parts wop
       JOIN job_cards jc ON wop.work_order_id = jc.id
       LEFT JOIN users u ON wop.installed_by = u.id
       WHERE wop.part_id = ${placeholder}
       ORDER BY wop.installed_at DESC`,
      [id]
    );
    
    res.json(result.rows);
  } catch (error) {
    logger.error('Get part work orders error:', error);
    next(error);
  }
});

module.exports = router;


