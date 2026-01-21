const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireAdmin } = require('../middleware/auth');
const NetSuiteService = require('../services/netsuiteService');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Helper function to get NetSuite settings
async function getNetSuiteSettings() {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const keyColumn = dbType === 'mysql' ? '`key`' : 'key';
    const result = await db.query(
      `SELECT ${keyColumn} as key, value FROM system_settings WHERE category = 'netsuite'`
    );

    const settings = {};
    result.rows.forEach(row => {
      try {
        settings[row.key.replace('netsuite.', '')] = JSON.parse(row.value);
      } catch (e) {
        settings[row.key.replace('netsuite.', '')] = row.value;
      }
    });

    return settings;
  } catch (error) {
    logger.error('Error getting NetSuite settings:', error);
    return {};
  }
}

// GET /api/v1/netsuite/config
// Get NetSuite configuration (sensitive fields masked)
router.get('/config', requireAdmin, async (req, res, next) => {
  try {
    const settings = await getNetSuiteSettings();
    
    // Mask sensitive information
    const config = {
      enabled: settings.enabled === 'true' || settings.enabled === true,
      sync_mode: settings.sync_mode || 'batch',
      batch_sync_schedule: settings.batch_sync_schedule || '0 2 * * *',
      account_id: settings.account_id ? `${settings.account_id.substring(0, 3)}***` : null,
      consumer_key: settings.consumer_key ? '***' : null,
      consumer_secret: settings.consumer_secret ? '***' : null,
      token_id: settings.token_id ? '***' : null,
      token_secret: settings.token_secret ? '***' : null,
      base_url: settings.account_id ? `https://${settings.account_id}.suitetalk.api.netsuite.com` : null,
      field_mappings: settings.field_mappings ? JSON.parse(settings.field_mappings) : {}
    };

    res.json({ data: config });
  } catch (error) {
    logger.error('Get NetSuite config error:', error);
    next(error);
  }
});

// POST /api/v1/netsuite/config
// Update NetSuite configuration
router.post('/config', requireAdmin,
  [
    body('account_id').optional().trim().isLength({ min: 1, max: 50 }),
    body('consumer_key').optional().trim().isLength({ min: 1, max: 255 }),
    body('consumer_secret').optional().trim().isLength({ min: 1, max: 255 }),
    body('token_id').optional().trim().isLength({ min: 1, max: 255 }),
    body('token_secret').optional().trim().isLength({ min: 1, max: 255 }),
    body('enabled').optional().isBoolean(),
    body('sync_mode').optional().isIn(['real-time', 'batch']),
    body('batch_sync_schedule').optional().trim(),
    body('field_mappings').optional().isObject()
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

      const {
        account_id,
        consumer_key,
        consumer_secret,
        token_id,
        token_secret,
        enabled,
        sync_mode,
        batch_sync_schedule,
        field_mappings
      } = req.body;

      const dbType = process.env.DB_TYPE || 'postgresql';
      const keyColumn = dbType === 'mysql' ? '`key`' : 'key';

      const updates = [];
      if (account_id !== undefined) updates.push({ key: 'netsuite.account_id', value: account_id });
      if (consumer_key !== undefined) updates.push({ key: 'netsuite.consumer_key', value: consumer_key });
      if (consumer_secret !== undefined) updates.push({ key: 'netsuite.consumer_secret', value: consumer_secret });
      if (token_id !== undefined) updates.push({ key: 'netsuite.token_id', value: token_id });
      if (token_secret !== undefined) updates.push({ key: 'netsuite.token_secret', value: token_secret });
      if (enabled !== undefined) updates.push({ key: 'netsuite.enabled', value: enabled.toString() });
      if (sync_mode !== undefined) updates.push({ key: 'netsuite.sync_mode', value: sync_mode });
      if (batch_sync_schedule !== undefined) updates.push({ key: 'netsuite.batch_sync_schedule', value: batch_sync_schedule });
      if (field_mappings !== undefined) updates.push({ key: 'netsuite.field_mappings', value: JSON.stringify(field_mappings) });

      for (const update of updates) {
        if (dbType === 'mysql') {
          await db.query(
            `INSERT INTO system_settings (${keyColumn}, value, description, category, updated_by, updated_at)
             VALUES (?, ?, ?, 'netsuite', ?, NOW())
             ON DUPLICATE KEY UPDATE value = ?, updated_by = ?, updated_at = NOW()`,
            [update.key, JSON.stringify(update.value), `NetSuite: ${update.key}`, req.user.id, JSON.stringify(update.value), req.user.id]
          );
        } else {
          await db.query(
            `INSERT INTO system_settings (key, value, description, category, updated_by, updated_at)
             VALUES ($1, $2, $3, 'netsuite', $4, now())
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $4, updated_at = now()`,
            [update.key, JSON.stringify(update.value), `NetSuite: ${update.key}`, req.user.id]
          );
        }
      }

      await db.query(
        `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
         VALUES ($1, 'netsuite.config.updated', 'netsuite_config', 'system', $2)`,
        [req.user.id, JSON.stringify({ updated_fields: updates.map(u => u.key) })]
      );

      res.json({
        message: 'NetSuite configuration updated successfully',
        updated_fields: updates.map(u => u.key)
      });
    } catch (error) {
      logger.error('Update NetSuite config error:', error);
      next(error);
    }
  }
);

// POST /api/v1/netsuite/test-connection
// Test NetSuite connection
router.post('/test-connection', requireAdmin, async (req, res, next) => {
  try {
    const settings = await getNetSuiteSettings();
    
    if (!settings.account_id || !settings.consumer_key || !settings.consumer_secret || 
        !settings.token_id || !settings.token_secret) {
      return res.status(400).json({
        error: {
          code: 'CONFIGURATION_INCOMPLETE',
          message: 'NetSuite configuration is incomplete. Please provide all required credentials.'
        }
      });
    }

    const netsuiteService = new NetSuiteService(settings);
    const testResult = await netsuiteService.testConnection();

    if (testResult.success) {
      res.json({
        message: 'Connection successful',
        data: {
          account_id: settings.account_id,
          base_url: `https://${settings.account_id}.suitetalk.api.netsuite.com`,
          connection_status: 'connected'
        }
      });
    } else {
      res.status(400).json({
        error: {
          code: 'CONNECTION_FAILED',
          message: testResult.error || 'Failed to connect to NetSuite'
        }
      });
    }
  } catch (error) {
    logger.error('Test NetSuite connection error:', error);
    next(error);
  }
});

// GET /api/v1/netsuite/sync-status
// Get sync queue status
router.get('/sync-status', requireAdmin, async (req, res, next) => {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const tableExists = await checkTableExists('netsuite_sync_log');
    
    if (!tableExists) {
      return res.json({
        data: {
          total: 0,
          pending: 0,
          completed: 0,
          failed: 0,
          retrying: 0
        }
      });
    }

    const result = await db.query(`
      SELECT 
        sync_status,
        COUNT(*) as count
      FROM netsuite_sync_log
      GROUP BY sync_status
    `);

    const statusCounts = {
      total: 0,
      pending: 0,
      completed: 0,
      failed: 0,
      retrying: 0
    };

    result.rows.forEach(row => {
      const count = parseInt(row.count);
      statusCounts.total += count;
      statusCounts[row.sync_status] = count;
    });

    res.json({ data: statusCounts });
  } catch (error) {
    logger.error('Get sync status error:', error);
    next(error);
  }
});

// GET /api/v1/netsuite/sync-queue
// Get sync queue entries
router.get('/sync-queue', requireAdmin, async (req, res, next) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const tableExists = await checkTableExists('netsuite_sync_log');
    
    if (!tableExists) {
      return res.json({ data: [], pagination: { total: 0, limit: parseInt(limit), offset: parseInt(offset) } });
    }

    let query = `
      SELECT 
        id,
        entity_type,
        entity_id,
        sync_status,
        sync_data,
        error_message,
        retry_count,
        created_at,
        updated_at,
        synced_at
      FROM netsuite_sync_log
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;

    if (status) {
      paramCount++;
      query += ` AND sync_status = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`;
      params.push(status);
    }

    query += ` ORDER BY created_at DESC LIMIT ${dbType === 'mysql' ? '?' : `$${paramCount + 1}`} OFFSET ${dbType === 'mysql' ? '?' : `$${paramCount + 2}`}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);
    const countResult = await db.query(
      `SELECT COUNT(*) as total FROM netsuite_sync_log${status ? ` WHERE sync_status = ${dbType === 'mysql' ? '?' : '$1'}` : ''}`,
      status ? [status] : []
    );

    res.json({
      data: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].total),
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    logger.error('Get sync queue error:', error);
    next(error);
  }
});

// POST /api/v1/netsuite/sync-now
// Manually trigger sync
router.post('/sync-now', requireAdmin, async (req, res, next) => {
  try {
    const { entity_type, entity_id } = req.body;
    const settings = await getNetSuiteSettings();

    if (!settings.enabled || settings.enabled !== 'true') {
      return res.status(400).json({
        error: {
          code: 'SYNC_DISABLED',
          message: 'NetSuite sync is disabled. Enable it in configuration first.'
        }
      });
    }

    // Queue the sync
    const dbType = process.env.DB_TYPE || 'postgresql';
    const tableExists = await checkTableExists('netsuite_sync_log');
    
    if (!tableExists) {
      return res.status(500).json({
        error: {
          code: 'TABLE_NOT_FOUND',
          message: 'netsuite_sync_log table does not exist. Please run migration.'
        }
      });
    }

    // Get entity data based on type
    let syncData = {};
    if (entity_type === 'time_log' && entity_id) {
      const timeLogResult = await db.query(
        `SELECT tl.*, a.job_card_id, jc.job_number, t.employee_code, u.display_name
         FROM time_logs tl
         LEFT JOIN assignments a ON tl.assignment_id = a.id
         LEFT JOIN job_cards jc ON a.job_card_id = jc.id
         LEFT JOIN technicians t ON tl.technician_id = t.user_id
         LEFT JOIN users u ON tl.technician_id = u.id
         WHERE tl.id = ${dbType === 'mysql' ? '?' : '$1'}`,
        [entity_id]
      );
      if (timeLogResult.rows.length > 0) {
        syncData = timeLogResult.rows[0];
      }
    }

    const syncLogId = await db.query(
      `INSERT INTO netsuite_sync_log (entity_type, entity_id, sync_status, sync_data, created_at)
       VALUES (${dbType === 'mysql' ? '?, ?, ?, ?, NOW()' : '$1, $2, $3, $4, now()'})
       ${dbType === 'mysql' ? '' : 'RETURNING id'}`,
      [entity_type, entity_id, 'pending', JSON.stringify(syncData)]
    );

    const logId = dbType === 'mysql' ? syncLogId.insertId : syncLogId.rows[0].id;

    // Process sync if real-time mode
    if (settings.sync_mode === 'real-time') {
      try {
        const netsuiteService = new NetSuiteService(settings);
        const syncResult = await netsuiteService.syncEntity(entity_type, syncData, settings.field_mappings);
        
        if (syncResult.success) {
          await db.query(
            `UPDATE netsuite_sync_log 
             SET sync_status = 'completed', 
                 netsuite_record_id = ${dbType === 'mysql' ? '?' : '$1'},
                 synced_at = ${dbType === 'mysql' ? 'NOW()' : 'now()'},
                 updated_at = ${dbType === 'mysql' ? 'NOW()' : 'now()'}
             WHERE id = ${dbType === 'mysql' ? '?' : '$2'}`,
            [syncResult.netsuiteId, logId]
          );
        } else {
          await db.query(
            `UPDATE netsuite_sync_log 
             SET sync_status = 'failed', 
                 error_message = ${dbType === 'mysql' ? '?' : '$1'},
                 retry_count = retry_count + 1,
                 updated_at = ${dbType === 'mysql' ? 'NOW()' : 'now()'}
             WHERE id = ${dbType === 'mysql' ? '?' : '$2'}`,
            [syncResult.error, logId]
          );
        }
      } catch (syncError) {
        logger.error('Sync error:', syncError);
        await db.query(
          `UPDATE netsuite_sync_log 
           SET sync_status = 'failed', 
               error_message = ${dbType === 'mysql' ? '?' : '$1'},
               retry_count = retry_count + 1,
               updated_at = ${dbType === 'mysql' ? 'NOW()' : 'now()'}
           WHERE id = ${dbType === 'mysql' ? '?' : '$2'}`,
          [syncError.message, logId]
        );
      }
    }

    res.json({
      message: 'Sync queued successfully',
      data: {
        sync_log_id: logId,
        sync_mode: settings.sync_mode,
        status: settings.sync_mode === 'real-time' ? 'processing' : 'queued'
      }
    });
  } catch (error) {
    logger.error('Sync now error:', error);
    next(error);
  }
});

// POST /api/v1/netsuite/retry-failed
// Retry failed syncs
router.post('/retry-failed', requireAdmin, async (req, res, next) => {
  try {
    const { limit = 10 } = req.query;
    const settings = await getNetSuiteSettings();

    if (!settings.enabled || settings.enabled !== 'true') {
      return res.status(400).json({
        error: {
          code: 'SYNC_DISABLED',
          message: 'NetSuite sync is disabled.'
        }
      });
    }

    const dbType = process.env.DB_TYPE || 'postgresql';
    const tableExists = await checkTableExists('netsuite_sync_log');
    
    if (!tableExists) {
      return res.status(500).json({
        error: {
          code: 'TABLE_NOT_FOUND',
          message: 'netsuite_sync_log table does not exist.'
        }
      });
    }

    const failedSyncs = await db.query(
      `SELECT * FROM netsuite_sync_log 
       WHERE sync_status = 'failed' AND retry_count < 5
       ORDER BY created_at ASC
       LIMIT ${dbType === 'mysql' ? '?' : '$1'}`,
      [parseInt(limit)]
    );

    const netsuiteService = new NetSuiteService(settings);
    let retried = 0;
    let succeeded = 0;
    let failed = 0;

    for (const syncLog of failedSyncs.rows) {
      try {
        const syncData = typeof syncLog.sync_data === 'string' ? JSON.parse(syncLog.sync_data) : syncLog.sync_data;
        const syncResult = await netsuiteService.syncEntity(syncLog.entity_type, syncData, settings.field_mappings);
        
        if (syncResult.success) {
          await db.query(
            `UPDATE netsuite_sync_log 
             SET sync_status = 'completed', 
                 netsuite_record_id = ${dbType === 'mysql' ? '?' : '$1'},
                 synced_at = ${dbType === 'mysql' ? 'NOW()' : 'now()'},
                 updated_at = ${dbType === 'mysql' ? 'NOW()' : 'now()'}
             WHERE id = ${dbType === 'mysql' ? '?' : '$2'}`,
            [syncResult.netsuiteId, syncLog.id]
          );
          succeeded++;
        } else {
          await db.query(
            `UPDATE netsuite_sync_log 
             SET error_message = ${dbType === 'mysql' ? '?' : '$1'},
                 retry_count = retry_count + 1,
                 updated_at = ${dbType === 'mysql' ? 'NOW()' : 'now()'}
             WHERE id = ${dbType === 'mysql' ? '?' : '$2'}`,
            [syncResult.error, syncLog.id]
          );
          failed++;
        }
        retried++;
      } catch (error) {
        logger.error(`Retry sync error for log ${syncLog.id}:`, error);
        await db.query(
          `UPDATE netsuite_sync_log 
           SET error_message = ${dbType === 'mysql' ? '?' : '$1'},
               retry_count = retry_count + 1,
               updated_at = ${dbType === 'mysql' ? 'NOW()' : 'now()'}
           WHERE id = ${dbType === 'mysql' ? '?' : '$2'}`,
          [error.message, syncLog.id]
        );
        failed++;
        retried++;
      }
    }

    res.json({
      message: 'Retry completed',
      data: {
        retried,
        succeeded,
        failed
      }
    });
  } catch (error) {
    logger.error('Retry failed syncs error:', error);
    next(error);
  }
});

// Helper function to check if table exists
async function checkTableExists(tableName) {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    let checkQuery;
    
    if (dbType === 'mysql') {
      checkQuery = `SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${tableName}'`;
    } else {
      checkQuery = `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '${tableName}') as exists`;
    }
    
    const result = await db.query(checkQuery);
    return dbType === 'mysql' ? result.rows[0].count > 0 : result.rows[0].exists;
  } catch (error) {
    return false;
  }
}

module.exports = router;





