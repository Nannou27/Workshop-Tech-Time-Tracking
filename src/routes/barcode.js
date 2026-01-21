const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// POST /api/v1/barcode/scan
router.post('/scan', [
  body('barcode').optional().trim(),
  body('qr_code').optional().trim(),
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
    
    const { barcode, qr_code, location_id } = req.body;
    const dbType = process.env.DB_TYPE || 'postgresql';
    
    if (!barcode && !qr_code) {
      return res.status(400).json({
        error: {
          code: 'MISSING_IDENTIFIER',
          message: 'Either barcode or qr_code is required'
        }
      });
    }
    
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    const identifier = barcode || qr_code;
    const identifierField = barcode ? 'barcode' : 'qr_code';
    
    // Search in assets
    let assetResult = await db.query(
      `SELECT a.*, 
              bu.name as business_unit_name,
              l.name as location_name
       FROM assets a
       LEFT JOIN business_units bu ON a.business_unit_id = bu.id
       LEFT JOIN locations l ON a.location_id = l.id
       WHERE a.${identifierField} = ${placeholder}`,
      [identifier]
    );
    
    if (assetResult.rows.length > 0) {
      // Log the scan
      await logBarcodeScan(dbType, barcode, qr_code, 'asset', assetResult.rows[0].id, req.user.id, 'scan', location_id);
      
      return res.json({
        entity_type: 'asset',
        entity: assetResult.rows[0],
        found: true
      });
    }
    
    // Search in parts
    let partResult = await db.query(
      `SELECT p.*, 
              a.name as parent_asset_name,
              a.asset_tag as parent_asset_tag,
              l.name as location_name
       FROM parts p
       LEFT JOIN assets a ON p.parent_asset_id = a.id
       LEFT JOIN locations l ON p.location_id = l.id
       WHERE p.${identifierField} = ${placeholder}`,
      [identifier]
    );
    
    if (partResult.rows.length > 0) {
      // Log the scan
      await logBarcodeScan(dbType, barcode, qr_code, 'part', partResult.rows[0].id, req.user.id, 'scan', location_id);
      
      return res.json({
        entity_type: 'part',
        entity: partResult.rows[0],
        found: true
      });
    }
    
    // Search in job cards (if job_number is used as barcode)
    let jobCardResult = await db.query(
      `SELECT jc.*
       FROM job_cards jc
       WHERE jc.job_number = ${placeholder}`,
      [identifier]
    );
    
    if (jobCardResult.rows.length > 0) {
      // Log the scan
      await logBarcodeScan(dbType, barcode, qr_code, 'work_order', jobCardResult.rows[0].id, req.user.id, 'scan', location_id);
      
      return res.json({
        entity_type: 'work_order',
        entity: jobCardResult.rows[0],
        found: true
      });
    }
    
    // Not found
    await logBarcodeScan(dbType, barcode, qr_code, 'unknown', null, req.user.id, 'scan', location_id, 'Barcode/QR code not found');
    
    res.json({
      entity_type: null,
      entity: null,
      found: false,
      message: 'No entity found with this barcode/QR code'
    });
  } catch (error) {
    logger.error('Barcode scan error:', error);
    next(error);
  }
});

// POST /api/v1/barcode/create-asset
router.post('/create-asset', [
  body('barcode').optional().trim(),
  body('qr_code').optional().trim(),
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
    
    const { barcode, qr_code, name, business_unit_id, location_id, ...assetData } = req.body;
    const dbType = process.env.DB_TYPE || 'postgresql';
    
    if (!barcode && !qr_code) {
      return res.status(400).json({
        error: {
          code: 'MISSING_IDENTIFIER',
          message: 'Either barcode or qr_code is required'
        }
      });
    }
    
    // Check if barcode/qr_code already exists
    const checkPlaceholder = dbType === 'mysql' ? '?' : '$1';
    if (barcode) {
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
    
    // Create asset using assets route logic
    const metadataValue = dbType === 'mysql' ? JSON.stringify(assetData.metadata || {}) : (assetData.metadata || {});
    
    let result;
    if (dbType === 'mysql') {
      result = await db.query(
        `INSERT INTO assets (name, serial_number, barcode, qr_code, asset_tag, cost, purchase_date, warranty_expiry, business_unit_id, location_id, parent_asset_id, status, asset_type, manufacturer, model, year, metadata, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name,
          assetData.serial_number || null,
          barcode || null,
          qr_code || null,
          assetData.asset_tag || null,
          assetData.cost || null,
          assetData.purchase_date || null,
          assetData.warranty_expiry || null,
          business_unit_id,
          location_id,
          assetData.parent_asset_id || null,
          assetData.status || 'active',
          assetData.asset_type || null,
          assetData.manufacturer || null,
          assetData.model || null,
          assetData.year || null,
          metadataValue,
          req.user.id
        ]
      );
      
      result = await db.query(
        `SELECT a.*, 
                bu.name as business_unit_name, 
                bu.code as business_unit_code,
                l.name as location_name
         FROM assets a
         LEFT JOIN business_units bu ON a.business_unit_id = bu.id
         LEFT JOIN locations l ON a.location_id = l.id
         WHERE a.id = LAST_INSERT_ID()`
      );
    } else {
      result = await db.query(
        `INSERT INTO assets (name, serial_number, barcode, qr_code, asset_tag, cost, purchase_date, warranty_expiry, business_unit_id, location_id, parent_asset_id, status, asset_type, manufacturer, model, year, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         RETURNING *`,
        [
          name,
          assetData.serial_number || null,
          barcode || null,
          qr_code || null,
          assetData.asset_tag || null,
          assetData.cost || null,
          assetData.purchase_date || null,
          assetData.warranty_expiry || null,
          business_unit_id,
          location_id,
          assetData.parent_asset_id || null,
          assetData.status || 'active',
          assetData.asset_type || null,
          assetData.manufacturer || null,
          assetData.model || null,
          assetData.year || null,
          metadataValue,
          req.user.id
        ]
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
    
    // Log barcode scan
    await logBarcodeScan(dbType, barcode, qr_code, 'asset', result.rows[0].id, req.user.id, 'create', location_id);
    
    // Create audit log
    const auditPlaceholder = dbType === 'mysql' ? '?' : '$1';
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES (${auditPlaceholder}, 'asset.created', 'asset', ${dbType === 'mysql' ? '?' : '$2'}, ${dbType === 'mysql' ? '?' : '$3'})`,
      [req.user.id, result.rows[0].id, JSON.stringify(req.body)]
    );
    
    res.status(201).json({
      entity_type: 'asset',
      entity: result.rows[0],
      created: true
    });
  } catch (error) {
    logger.error('Create asset from barcode error:', error);
    next(error);
  }
});

// GET /api/v1/barcode/scans
router.get('/scans', async (req, res, next) => {
  try {
    const { entity_type, entity_id, scanned_by, start_date, end_date, limit = 100 } = req.query;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$';
    
    let query = `
      SELECT bs.*, 
             u.display_name as scanned_by_name,
             l.name as location_name
      FROM barcode_scans bs
      LEFT JOIN users u ON bs.scanned_by = u.id
      LEFT JOIN locations l ON bs.location_id = l.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;
    
    if (entity_type) {
      paramCount++;
      query += ` AND bs.entity_type = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(entity_type);
    }
    
    if (entity_id) {
      paramCount++;
      query += ` AND bs.entity_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(entity_id);
    }
    
    if (scanned_by) {
      paramCount++;
      query += ` AND bs.scanned_by = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(scanned_by);
    }
    
    if (start_date) {
      paramCount++;
      query += ` AND bs.scanned_at >= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(start_date);
    }
    
    if (end_date) {
      paramCount++;
      query += ` AND bs.scanned_at <= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(end_date);
    }
    
    query += ` ORDER BY bs.scanned_at DESC`;
    
    const limitPlaceholder = dbType === 'mysql' ? '?' : `$${paramCount + 1}`;
    query += ` LIMIT ${limitPlaceholder}`;
    params.push(parseInt(limit));
    
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (error) {
    logger.error('Get barcode scans error:', error);
    next(error);
  }
});

// Helper function to log barcode scans
async function logBarcodeScan(dbType, barcode, qr_code, entityType, entityId, scannedBy, scanType, locationId, notes = null) {
  try {
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    await db.query(
      `INSERT INTO barcode_scans (barcode, qr_code, entity_type, entity_id, scanned_by, scan_type, location_id, notes)
       VALUES (${placeholder}, ${dbType === 'mysql' ? '?' : '$2'}, ${dbType === 'mysql' ? '?' : '$3'}, ${dbType === 'mysql' ? '?' : '$4'}, ${dbType === 'mysql' ? '?' : '$5'}, ${dbType === 'mysql' ? '?' : '$6'}, ${dbType === 'mysql' ? '?' : '$7'}, ${dbType === 'mysql' ? '?' : '$8'})`,
      [barcode || null, qr_code || null, entityType, entityId, scannedBy, scanType, locationId || null, notes]
    );
  } catch (error) {
    logger.error('Error logging barcode scan:', error);
    // Don't throw - logging failure shouldn't break the main operation
  }
}

module.exports = router;





