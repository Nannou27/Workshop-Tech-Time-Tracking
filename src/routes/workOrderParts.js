const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

function safeJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function getPartInventory(partId) {
  const dbType = process.env.DB_TYPE || 'postgresql';
  const placeholder = dbType === 'mysql' ? '?' : '$1';
  const res = await db.query(
    `SELECT id, metadata FROM parts WHERE id = ${placeholder}`,
    [partId]
  );
  if (!res.rows || res.rows.length === 0) return null;
  const row = res.rows[0];
  const meta = safeJson(row.metadata) || row.metadata || {};
  const qty = (meta && typeof meta === 'object' && meta.quantity_in_stock != null)
    ? parseInt(meta.quantity_in_stock, 10)
    : null;
  const currency = (meta && typeof meta === 'object' && meta.currency_code) ? String(meta.currency_code) : null;
  return { id: row.id, meta: (meta && typeof meta === 'object') ? meta : {}, quantity_in_stock: Number.isFinite(qty) ? qty : null, currency_code: currency };
}

async function setPartInventory(partId, nextQty, meta) {
  const dbType = process.env.DB_TYPE || 'postgresql';
  const placeholder = dbType === 'mysql' ? '?' : '$';
  const m = (meta && typeof meta === 'object') ? { ...meta } : {};
  m.quantity_in_stock = nextQty;
  const metadataValue = dbType === 'mysql' ? JSON.stringify(m) : m;

  if (dbType === 'mysql') {
    await db.query(`UPDATE parts SET metadata = ? WHERE id = ?`, [metadataValue, partId]);
  } else {
    await db.query(`UPDATE parts SET metadata = $1 WHERE id = $2`, [metadataValue, partId]);
  }
}

// Helper function to check if table exists
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

// GET /api/v1/work-orders/:work_order_id/parts
router.get('/:work_order_id/parts', async (req, res, next) => {
  try {
    const { work_order_id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';

    // Check if work_order_parts table exists
    const partsTableExists = await tableExists('work_order_parts');
    if (!partsTableExists) {
      return res.json({ data: [] }); // Return empty array if table doesn't exist
    }

    const result = await db.query(
      `SELECT wop.id, wop.work_order_id, wop.part_id, wop.quantity, 
              wop.unit_cost, wop.total_cost, wop.installed_at, wop.notes,
              p.name as part_name, p.part_number, p.serial_number, p.barcode, p.qr_code,
              u.display_name as installed_by_name
       FROM work_order_parts wop
       LEFT JOIN parts p ON wop.part_id = p.id
       LEFT JOIN users u ON wop.installed_by = u.id
       WHERE wop.work_order_id = ${placeholder}
       ORDER BY wop.installed_at DESC`,
      [work_order_id]
    );

    const rows = (result.rows || []).map(r => {
      let currency_code = null;
      let notes_text = r.notes || null;
      if (typeof r.notes === 'string') {
        try {
          const parsed = JSON.parse(r.notes);
          if (parsed && typeof parsed === 'object') {
            currency_code = parsed.currency_code || null;
            notes_text = parsed.text || null;
          }
        } catch {
          // keep as plain text
        }
      }
      return { ...r, currency_code, notes_text };
    });

    res.json({ data: rows });
  } catch (error) {
    logger.error('Get work order parts error:', error);
    next(error);
  }
});

// POST /api/v1/work-orders/:work_order_id/parts
router.post('/:work_order_id/parts',
  [
    body('part_id').isInt().withMessage('Part ID must be an integer'),
    body('quantity').optional().isInt({ min: 1 }).withMessage('Quantity must be a positive integer'),
    body('unit_cost').optional().isFloat({ min: 0 }).withMessage('Unit cost must be a positive number'),
    body('currency_code').optional().isString().isLength({ min: 3, max: 3 }),
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

      const { work_order_id } = req.params;
      const { part_id, quantity = 1, unit_cost, currency_code, notes } = req.body;
      const dbType = process.env.DB_TYPE || 'postgresql';

      // Check if work_order_parts table exists
      const partsTableExists = await tableExists('work_order_parts');
      if (!partsTableExists) {
        return res.status(501).json({
          error: {
            code: 'NOT_IMPLEMENTED',
            message: 'Work order parts feature not available. Please run the migration.'
          }
        });
      }

      // Verify work order exists
      const workOrderCheck = await db.query(
        `SELECT id FROM job_cards WHERE id = ${dbType === 'mysql' ? '?' : '$1'}`,
        [work_order_id]
      );
      if (workOrderCheck.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: 'Work order not found'
          }
        });
      }

      // Verify part exists + fetch cost + inventory metadata
      const partCheck = await db.query(
        `SELECT id, cost, metadata FROM parts WHERE id = ${dbType === 'mysql' ? '?' : '$1'}`,
        [part_id]
      );
      if (partCheck.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: 'Part not found'
          }
        });
      }

      // Inventory check: if quantity_in_stock is tracked, enforce it
      const partMeta = safeJson(partCheck.rows[0].metadata) || partCheck.rows[0].metadata || {};
      const trackedStock = (partMeta && typeof partMeta === 'object' && partMeta.quantity_in_stock != null)
        ? parseInt(partMeta.quantity_in_stock, 10)
        : null;
      if (Number.isFinite(trackedStock)) {
        if (trackedStock < quantity) {
          return res.status(400).json({
            error: {
              code: 'INSUFFICIENT_STOCK',
              message: `Not enough stock. Available: ${trackedStock}, requested: ${quantity}`
            }
          });
        }
      }

      // Use part's default cost if unit_cost not provided
      const finalUnitCost = unit_cost !== undefined ? unit_cost : (partCheck.rows[0].cost || 0);
      const totalCost = quantity * finalUnitCost;

      // Store currency code inside notes as JSON (schema-safe) when provided.
      const normalizedCurrency = currency_code ? String(currency_code).toUpperCase().trim() : null;
      const finalNotes = normalizedCurrency
        ? JSON.stringify({ text: notes || null, currency_code: normalizedCurrency })
        : (notes || null);

      let newWorkOrderPart;
      if (dbType === 'mysql') {
        await db.query(
          `INSERT INTO work_order_parts (work_order_id, part_id, quantity, unit_cost, installed_by, notes)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [work_order_id, part_id, quantity, finalUnitCost, req.user.id, finalNotes]
        );
        const result = await db.query(
          `SELECT wop.*, p.name as part_name, p.part_number, p.serial_number,
                  u.display_name as installed_by_name
           FROM work_order_parts wop
           LEFT JOIN parts p ON wop.part_id = p.id
           LEFT JOIN users u ON wop.installed_by = u.id
           WHERE wop.work_order_id = ? AND wop.part_id = ?
           ORDER BY wop.id DESC LIMIT 1`,
          [work_order_id, part_id]
        );
        newWorkOrderPart = result.rows[0];
      } else {
        const result = await db.query(
          `INSERT INTO work_order_parts (work_order_id, part_id, quantity, unit_cost, installed_by, notes)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [work_order_id, part_id, quantity, finalUnitCost, req.user.id, finalNotes]
        );
        newWorkOrderPart = result.rows[0];

        // Get related info
        const partInfo = await db.query(
          `SELECT name, part_number, serial_number FROM parts WHERE id = $1`,
          [part_id]
        );
        if (partInfo.rows.length > 0) {
          newWorkOrderPart.part_name = partInfo.rows[0].name;
          newWorkOrderPart.part_number = partInfo.rows[0].part_number;
          newWorkOrderPart.serial_number = partInfo.rows[0].serial_number;
        }
        newWorkOrderPart.installed_by_name = req.user.display_name || req.user.email;
      }

      // Create audit log
      await db.query(
        `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
         VALUES ($1, 'work_order_part.added', 'work_order_part', $2, $3)`,
        [req.user.id, newWorkOrderPart.id, JSON.stringify({ work_order_id, part_id, quantity, unit_cost: finalUnitCost, currency_code: normalizedCurrency })]
      );

      res.status(201).json(newWorkOrderPart);

      // Decrement inventory stock (best-effort after insert)
      try {
        if (Number.isFinite(trackedStock)) {
          await setPartInventory(part_id, Math.max(0, trackedStock - quantity), partMeta);
        }
      } catch (invErr) {
        logger.warn('Inventory decrement failed (non-fatal):', invErr);
      }
    } catch (error) {
      logger.error('Add work order part error:', error);
      next(error);
    }
  }
);

// PATCH /api/v1/work-orders/:work_order_id/parts/:id
router.patch('/:work_order_id/parts/:id',
  [
    body('quantity').optional().isInt({ min: 1 }).withMessage('Quantity must be a positive integer'),
    body('unit_cost').optional().isFloat({ min: 0 }).withMessage('Unit cost must be a positive number'),
    body('currency_code').optional().isString().isLength({ min: 3, max: 3 }),
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

      const { work_order_id, id } = req.params;
      const { quantity, unit_cost, currency_code, notes } = req.body;
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$';

      // Check if work_order_parts table exists
      const partsTableExists = await tableExists('work_order_parts');
      if (!partsTableExists) {
        return res.status(501).json({
          error: {
            code: 'NOT_IMPLEMENTED',
            message: 'Work order parts feature not available. Please run the migration.'
          }
        });
      }

      // Verify the work order part exists and belongs to the work order
      const checkResult = await db.query(
        `SELECT id, part_id, quantity, unit_cost, notes FROM work_order_parts 
         WHERE id = ${dbType === 'mysql' ? '?' : '$1'} AND work_order_id = ${dbType === 'mysql' ? '?' : '$2'}`,
        [id, work_order_id]
      );
      if (checkResult.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: 'Work order part not found'
          }
        });
      }

      const updates = [];
      const params = [];
      let paramCount = 0;

      if (quantity !== undefined) {
        paramCount++;
        updates.push(`quantity = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
        params.push(quantity);
      }

      if (unit_cost !== undefined) {
        paramCount++;
        updates.push(`unit_cost = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
        params.push(unit_cost);
      }

      // notes + currency_code are stored together in notes JSON for schema compatibility
      if (notes !== undefined || currency_code !== undefined) {
        const normalizedCurrency = currency_code ? String(currency_code).toUpperCase().trim() : null;
        let existingNotes = checkResult.rows[0].notes;
        let existingObj = null;
        if (typeof existingNotes === 'string') {
          try { existingObj = JSON.parse(existingNotes); } catch { existingObj = null; }
        }
        const baseText = (existingObj && typeof existingObj === 'object') ? (existingObj.text || null) : (existingNotes || null);
        const baseCurrency = (existingObj && typeof existingObj === 'object') ? (existingObj.currency_code || null) : null;
        const nextText = notes !== undefined ? (notes || null) : baseText;
        const nextCurrency = currency_code !== undefined ? normalizedCurrency : baseCurrency;
        const nextNotes = nextCurrency ? JSON.stringify({ text: nextText, currency_code: nextCurrency }) : nextText;

        paramCount++;
        updates.push(`notes = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
        params.push(nextNotes);
      }

      if (updates.length === 0) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'No fields to update'
          }
        });
      }

      // Inventory adjustment if quantity changed (tracked parts only)
      const oldQty = parseInt(checkResult.rows[0].quantity, 10) || 0;
      const newQty = quantity !== undefined ? quantity : oldQty;
      const qtyDelta = newQty - oldQty; // + means more used -> decrement stock

      // Calculate total_cost
      const finalQuantity = newQty;
      const finalUnitCost = unit_cost !== undefined ? unit_cost : checkResult.rows[0].unit_cost;
      const totalCost = finalQuantity * finalUnitCost;

      if (dbType === 'mysql') {
        // MySQL doesn't support updating computed columns directly, but we can update the base columns
        const mysqlUpdates = updates.map((update, index) => {
          return update.replace(/\$\d+/g, '?');
        });
        params.push(id, work_order_id);

        await db.query(
          `UPDATE work_order_parts SET ${mysqlUpdates.join(', ')} 
           WHERE id = ? AND work_order_id = ?`,
          params
        );

        const result = await db.query(
          `SELECT wop.*, p.name as part_name, p.part_number, p.serial_number,
                  u.display_name as installed_by_name
           FROM work_order_parts wop
           LEFT JOIN parts p ON wop.part_id = p.id
           LEFT JOIN users u ON wop.installed_by = u.id
           WHERE wop.id = ? AND wop.work_order_id = ?`,
          [id, work_order_id]
        );
        if (result.rows.length === 0) {
          return res.status(404).json({
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'Work order part not found'
            }
          });
        }
        res.json(result.rows[0]);
      } else {
        paramCount++;
        params.push(id);
        paramCount++;
        params.push(work_order_id);

        const result = await db.query(
          `UPDATE work_order_parts SET ${updates.join(', ')} 
           WHERE id = $${paramCount - 1} AND work_order_id = $${paramCount}
           RETURNING *`,
          params
        );

        if (result.rows.length === 0) {
          return res.status(404).json({
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'Work order part not found'
            }
          });
        }

        // Get related info
        const partInfo = await db.query(
          `SELECT name, part_number, serial_number FROM parts WHERE id = $1`,
          [result.rows[0].part_id]
        );
        if (partInfo.rows.length > 0) {
          result.rows[0].part_name = partInfo.rows[0].name;
          result.rows[0].part_number = partInfo.rows[0].part_number;
          result.rows[0].serial_number = partInfo.rows[0].serial_number;
        }

        res.json(result.rows[0]);
      }

      // Apply inventory delta (best-effort)
      try {
        if (qtyDelta !== 0) {
          const inv = await getPartInventory(checkResult.rows[0].part_id);
          if (inv && Number.isFinite(inv.quantity_in_stock)) {
            const nextQty = qtyDelta > 0
              ? inv.quantity_in_stock - qtyDelta
              : inv.quantity_in_stock + Math.abs(qtyDelta);
            if (qtyDelta > 0 && nextQty < 0) {
              // Do not allow negative stock; clamp and warn
              await setPartInventory(inv.id, 0, inv.meta);
            } else {
              await setPartInventory(inv.id, nextQty, inv.meta);
            }
          }
        }
      } catch (invErr) {
        logger.warn('Inventory update (PATCH) failed (non-fatal):', invErr);
      }

      // Create audit log
      await db.query(
        `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
         VALUES ($1, 'work_order_part.updated', 'work_order_part', $2, $3)`,
        [req.user.id, id, JSON.stringify(req.body)]
      );
    } catch (error) {
      logger.error('Update work order part error:', error);
      next(error);
    }
  }
);

// DELETE /api/v1/work-orders/:work_order_id/parts/:id
router.delete('/:work_order_id/parts/:id', async (req, res, next) => {
  try {
    const { work_order_id, id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';

    // Check if work_order_parts table exists
    const partsTableExists = await tableExists('work_order_parts');
    if (!partsTableExists) {
      return res.status(501).json({
        error: {
          code: 'NOT_IMPLEMENTED',
          message: 'Work order parts feature not available. Please run the migration.'
        }
      });
    }

    // Verify the work order part exists and belongs to the work order
    const checkResult = await db.query(
      `SELECT id, part_id, quantity FROM work_order_parts 
       WHERE id = ${dbType === 'mysql' ? '?' : '$1'} AND work_order_id = ${dbType === 'mysql' ? '?' : '$2'}`,
      [id, work_order_id]
    );
    if (checkResult.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'Work order part not found'
        }
      });
    }

    await db.query(
      `DELETE FROM work_order_parts 
       WHERE id = ${dbType === 'mysql' ? '?' : '$1'} AND work_order_id = ${dbType === 'mysql' ? '?' : '$2'}`,
      [id, work_order_id]
    );

    // Increment inventory stock back (best-effort)
    try {
      const inv = await getPartInventory(checkResult.rows[0].part_id);
      const qty = parseInt(checkResult.rows[0].quantity, 10) || 0;
      if (inv && Number.isFinite(inv.quantity_in_stock) && qty > 0) {
        await setPartInventory(inv.id, inv.quantity_in_stock + qty, inv.meta);
      }
    } catch (invErr) {
      logger.warn('Inventory increment failed (non-fatal):', invErr);
    }

    // Create audit log
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES ($1, 'work_order_part.deleted', 'work_order_part', $2, $3)`,
      [req.user.id, id, JSON.stringify({ work_order_id })]
    );

    res.json({
      message: 'Work order part removed successfully'
    });
  } catch (error) {
    logger.error('Delete work order part error:', error);
    next(error);
  }
});

module.exports = router;

