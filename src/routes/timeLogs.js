const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate } = require('../middleware/auth');
const redis = require('../utils/redis');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Helper function to check if table exists
async function tableExists(tableName) {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const checkQuery = dbType === 'mysql'
      ? `SHOW TABLES LIKE '${tableName}'`
      : `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '${tableName}') as exists`;
    const result = await db.query(checkQuery);
    const exists = dbType === 'mysql' ? result.rows.length > 0 : result.rows[0].exists;
    logger.info(`[TABLE-CHECK] ${tableName} exists: ${exists} (dbType: ${dbType})`);
    return exists;
  } catch (error) {
    logger.error(`[TABLE-CHECK] Error checking if ${tableName} exists:`, error);
    return false;
  }
}

// Helper function to check if column exists
async function columnExists(tableName, columnName) {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const checkQuery = dbType === 'mysql'
      ? `SHOW COLUMNS FROM ${tableName} LIKE '${columnName}'`
      : `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = '${tableName}' AND column_name = '${columnName}') as exists`;
    const result = await db.query(checkQuery);
    const exists = dbType === 'mysql' ? result.rows.length > 0 : result.rows[0].exists;
    logger.info(`[COLUMN-CHECK] ${tableName}.${columnName} exists: ${exists}`);
    return exists;
  } catch (error) {
    logger.error(`[COLUMN-CHECK] Error checking if ${tableName}.${columnName} exists:`, error);
    return false;
  }
}

// Helper: check if technician currently has an active break
// Single source of truth: active shift row with break_start_time IS NOT NULL
async function hasActiveBreak(technicianId) {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const shiftPh = dbType === 'mysql' ? '?' : '$1';
    
    // Query the current active shift
    const shiftResult = await db.query(
      `SELECT id, clock_out_time, break_start_time FROM technician_shifts 
       WHERE technician_id = ${shiftPh} 
         AND clock_out_time IS NULL
       ORDER BY clock_in_time DESC LIMIT 1`,
      [technicianId]
    );

    if (shiftResult.rows.length === 0) {
      logger.info(`[BREAK-CHECK] techId=${technicianId} shiftId=null clock_out=null break_start=null break_end=null breakActive=false (no active shift)`);
      return false;
    }

    const shift = shiftResult.rows[0];
    // Break is active if break_start_time is NOT NULL
    const breakActive = shift.break_start_time != null && shift.break_start_time !== '';
    
    logger.info(`[BREAK-CHECK] techId=${technicianId} shiftId=${shift.id} clock_out=${shift.clock_out_time} break_start=${shift.break_start_time} breakActive=${breakActive}`);
    return breakActive;
  } catch (err) {
    // If query fails (e.g., column doesn't exist), log and fail-open for backward compat
    logger.error(`[BREAK-CHECK] Error checking break state: ${err.message}`);
    return false;
  }
}

// GET /api/v1/timelogs
router.get('/', async (req, res, next) => {
  try {
    const { technician_id, job_card_id, assignment_id, status, start_date, end_date, limit } = req.query;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$';

    let queryText = `
      SELECT id, assignment_id, technician_id, job_card_id, 
             start_ts, end_ts, duration_seconds, status, notes,
             is_manually_corrected, created_at
      FROM time_logs
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;

    // Filter by technician (if not admin, only own logs)
    if (technician_id) {
      paramCount++;
      queryText += ` AND technician_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(technician_id);
    } else if (req.user.roleId !== 1) {
      paramCount++;
      queryText += ` AND technician_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(req.user.id);
    }

    if (job_card_id) {
      paramCount++;
      queryText += ` AND job_card_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(job_card_id);
    }

    if (assignment_id) {
      paramCount++;
      queryText += ` AND assignment_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(assignment_id);
    }

    if (status) {
      paramCount++;
      queryText += ` AND status = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(status);
    }

    if (start_date) {
      paramCount++;
      queryText += ` AND start_ts >= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(start_date);
    }

    if (end_date) {
      paramCount++;
      queryText += ` AND start_ts <= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(end_date);
    }

    queryText += ' ORDER BY start_ts DESC';

    if (limit) {
      paramCount++;
      queryText += ` LIMIT ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(parseInt(limit));
    }

    const result = await db.query(queryText, params);

    res.json({
      data: result.rows
    });
  } catch (error) {
    logger.error('Get time logs error:', error);
    next(error);
  }
});

// POST /api/v1/timelogs/start
router.post('/start',
  [
    body('assignment_id').isInt()
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

      const { assignment_id, notes } = req.body;
      const technicianId = req.user.id;
      
      // Convert undefined to null for SQL
      const notesValue = notes !== undefined ? notes : null;

      // Get database type early for use throughout the function
      const dbType = process.env.DB_TYPE || 'postgresql';

      // Verify assignment exists and belongs to technician (or admin can start for any)
      const placeholder = dbType === 'mysql' ? '?' : '$1';
      const assignmentResult = await db.query(
        `SELECT a.id, a.technician_id, a.job_card_id, a.status
         FROM assignments a
         WHERE a.id = ${placeholder}`,
        [assignment_id]
      );

      if (assignmentResult.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: 'Assignment not found'
          }
        });
      }

      const assignment = assignmentResult.rows[0];

      // Check if technician owns assignment (unless admin)
      if (assignment.technician_id !== technicianId && req.user.roleId !== 1) {
        return res.status(403).json({
          error: {
            code: 'AUTHORIZATION_FAILED',
            message: 'Assignment does not belong to this technician'
          }
        });
      }

      // ENFORCE: Cannot start/resume job timer while on break (centralized check)
      const onBreak = await hasActiveBreak(technicianId);
      if (onBreak) {
        logger.warn(`[TIMER-START] BLOCKED: Technician ${technicianId} attempted to start timer while on break`);
        return res.status(409).json({
          error: {
            code: 'ON_BREAK',
            message: 'You cannot start a job timer while on break. Please end your break first.'
          }
        });
      }

      // ENFORCE: Technician must be clocked in before starting a job timer.
      const shiftsTableExists = await tableExists('technician_shifts');
      if (!shiftsTableExists) {
        logger.warn('[TIMER-START] Cannot enforce clock-in rule: technician_shifts table does not exist');
      } else {
        const shiftPh = dbType === 'mysql' ? '?' : '$1';
        const activeShiftResult = await db.query(
          `SELECT id FROM technician_shifts 
           WHERE technician_id = ${shiftPh} AND clock_out_time IS NULL
           ORDER BY clock_in_time DESC LIMIT 1`,
          [technicianId]
        );
        
        if (activeShiftResult.rows.length === 0) {
          return res.status(400).json({
            error: {
              code: 'NOT_CLOCKED_IN',
              message: 'You must clock in to your shift before starting a job timer.'
            }
          });
        }
      }

      // Enforce workflow: assignment cannot be completed/cancelled when starting a timer
      if (assignment.status === 'completed' || assignment.status === 'cancelled') {
        return res.status(409).json({
          error: {
            code: 'INVALID_WORKFLOW_STATE',
            message: `Cannot start timer for an assignment in status "${assignment.status}".`
          }
        });
      }

      // Enforce workflow: supervisor estimate required before time tracking starts
      const jobCardPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const jobCardResult = await db.query(
        `SELECT id, estimated_hours FROM job_cards WHERE id = ${jobCardPlaceholder}`,
        [assignment.job_card_id]
      );
      if (jobCardResult.rows.length === 0) {
        return res.status(400).json({
          error: {
            code: 'RELATIONSHIP_ERROR',
            message: 'Assignment is linked to a missing job card. Please contact an administrator.'
          }
        });
      }
      const estimated = parseFloat(jobCardResult.rows[0].estimated_hours || 0) || 0;
      if (!(estimated > 0)) {
        return res.status(409).json({
          error: {
            code: 'MISSING_ESTIMATE',
            message: 'Estimated hours are required before a technician can start time tracking. Please add supervisor estimate first.'
          }
        });
      }

      // Acquire distributed lock
      const lockKey = `timer:lock:${technicianId}`;
      const lockAcquired = await redis.acquireLock(lockKey, 5000); // 5 second lock

      if (!lockAcquired) {
        return res.status(423).json({
          error: {
            code: 'LOCK_ACQUISITION_FAILED',
            message: 'Could not acquire lock, please retry'
          }
        });
      }

      try {
        // Check for existing active timer (unless multi-tasking enabled)
        let multiTaskingEnabled = false;
        try {
          const keyColumn = dbType === 'mysql' ? '`key`' : 'key';
          const ms = await db.query(
            dbType === 'mysql'
              ? `SELECT value FROM system_settings WHERE ${keyColumn} = ? LIMIT 1`
              : `SELECT value FROM system_settings WHERE key = $1 LIMIT 1`,
            ['timer.multi_tasking_enabled']
          );
          if (ms.rows && ms.rows[0] && ms.rows[0].value != null) {
            const v = typeof ms.rows[0].value === 'string' ? JSON.parse(ms.rows[0].value) : ms.rows[0].value;
            multiTaskingEnabled = !!(v?.enabled ?? v?.value ?? v);
          }
        } catch {
          // Backward-compatible key name used by some schemas
          try {
            const keyColumn = dbType === 'mysql' ? '`key`' : 'key';
            const ms2 = await db.query(
              dbType === 'mysql'
                ? `SELECT value FROM system_settings WHERE ${keyColumn} = ? LIMIT 1`
                : `SELECT value FROM system_settings WHERE key = $1 LIMIT 1`,
              ['timer.multi_tasking_allowed']
            );
            if (ms2.rows && ms2.rows[0] && ms2.rows[0].value != null) {
              const v2 = typeof ms2.rows[0].value === 'string' ? JSON.parse(ms2.rows[0].value) : ms2.rows[0].value;
              multiTaskingEnabled = String(v2).toLowerCase() === 'true' || v2 === true;
            } else {
              multiTaskingEnabled = false;
            }
          } catch {
            multiTaskingEnabled = false;
          }
        }
        if (!multiTaskingEnabled) {
          const activeTimerPlaceholder = dbType === 'mysql' ? '?' : '$1';
          const activeTimerResult = await db.query(
            `SELECT id FROM time_logs 
             WHERE technician_id = ${activeTimerPlaceholder} AND status = 'active'`,
            [technicianId]
          );

          if (activeTimerResult.rows.length > 0) {
            await redis.releaseLock(lockKey);
            return res.status(409).json({
              error: {
                code: 'TIMER_ALREADY_ACTIVE',
                message: 'Another timer is already active. Stop it first or enable multi-tasking.'
              }
            });
          }
        }

        // Create time log
        let timeLog;
        
        if (dbType === 'mysql') {
          await db.query(
            `INSERT INTO time_logs 
             (assignment_id, technician_id, job_card_id, start_ts, status, notes)
             VALUES (?, ?, ?, NOW(), 'active', ?)`,
            [assignment_id, technicianId, assignment.job_card_id, notesValue]
          );
          
          // Fetch the inserted record
          const result = await db.query(
            `SELECT id, assignment_id, technician_id, job_card_id, start_ts, status, notes 
             FROM time_logs 
             WHERE assignment_id = ? AND technician_id = ? AND status = 'active' 
             ORDER BY id DESC LIMIT 1`,
            [assignment_id, technicianId]
          );
          timeLog = result.rows[0];
        } else {
          const result = await db.query(
            `INSERT INTO time_logs 
             (assignment_id, technician_id, job_card_id, start_ts, status, notes)
             VALUES ($1, $2, $3, now(), 'active', $4)
             RETURNING id, assignment_id, technician_id, job_card_id, start_ts, status, notes`,
            [assignment_id, technicianId, assignment.job_card_id, notesValue]
          );
          timeLog = result.rows[0];
        }

        // Update assignment status
        const updatePlaceholder = dbType === 'mysql';
        if (dbType === 'mysql') {
          await db.query(
            `UPDATE assignments SET status = 'in_progress', started_at = COALESCE(started_at, NOW()) WHERE id = ?`,
            [assignment_id]
          );
        } else {
          await db.query(
            `UPDATE assignments SET status = 'in_progress', started_at = COALESCE(started_at, now()) WHERE id = $1`,
            [assignment_id]
          );
        }

        // Create audit log
        const auditPlaceholder1 = dbType === 'mysql' ? '?' : '$1';
        const auditPlaceholder2 = dbType === 'mysql' ? '?' : '$2';
        const auditPlaceholder3 = dbType === 'mysql' ? '?' : '$3';
        await db.query(
          `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
           VALUES (${auditPlaceholder1}, 'timelog.started', 'time_log', ${auditPlaceholder2}, ${auditPlaceholder3})`,
          [req.user.id, timeLog.id, JSON.stringify({ assignment_id })]
        );

        await redis.releaseLock(lockKey);

        res.status(201).json(timeLog);
      } catch (innerError) {
        await redis.releaseLock(lockKey);
        throw innerError;
      }
    } catch (error) {
      logger.error('Start timer error:', error);
      next(error);
    }
  }
);

// POST /api/v1/timelogs/:id/pause
router.post('/:id/pause',
  [
    body('notes').optional()
  ],
  async (req, res, next) => {
    try {
      const { notes } = req.body;
      const timeLogId = req.params.id;

      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$1';

      // Get time log
      const result = await db.query(
        `SELECT * FROM time_logs WHERE id = ${placeholder}`,
        [timeLogId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: 'Time log not found'
          }
        });
      }

      const timeLog = result.rows[0];

      // Check if technician owns time log (unless admin)
      if (timeLog.technician_id !== req.user.id && req.user.roleId !== 1) {
        return res.status(403).json({
          error: {
            code: 'AUTHORIZATION_FAILED',
            message: 'Time log does not belong to this technician'
          }
        });
      }

      if (timeLog.status !== 'active') {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Time log is not active'
          }
        });
      }

      // Calculate duration before pausing
      const pauseTs = new Date();
      const startTs = new Date(timeLog.start_ts);
      const durationSeconds = Math.floor((pauseTs - startTs) / 1000);
      
      // Update time log
      if (dbType === 'mysql') {
        await db.query(
          `UPDATE time_logs 
           SET end_ts = NOW(), status = 'paused', notes = COALESCE(?, notes), duration_seconds = ?
           WHERE id = ?`,
          [notes, durationSeconds, timeLogId]
        );
      } else {
        await db.query(
          `UPDATE time_logs 
           SET end_ts = NOW(), status = 'paused', notes = COALESCE($1, notes), duration_seconds = $2
           WHERE id = $3`,
          [notes, durationSeconds, timeLogId]
        );
      }
      
      // Fetch updated record
      const updatedPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const updatedResult = await db.query(
        `SELECT id, end_ts, status, notes FROM time_logs WHERE id = ${updatedPlaceholder}`,
        [timeLogId]
      );

      // Create audit log
      const auditPlaceholder1 = dbType === 'mysql' ? '?' : '$1';
      const auditPlaceholder2 = dbType === 'mysql' ? '?' : '$2';
      const auditPlaceholder3 = dbType === 'mysql' ? '?' : '$3';
      await db.query(
        `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
         VALUES (${auditPlaceholder1}, 'timelog.paused', 'time_log', ${auditPlaceholder2}, ${auditPlaceholder3})`,
        [req.user.id, timeLogId, JSON.stringify({})]
      );

      res.json(updatedResult.rows[0]);
    } catch (error) {
      logger.error('Pause timer error:', error);
      next(error);
    }
  }
);

// POST /api/v1/timelogs/:id/resume
router.post('/:id/resume',
  [
    body('notes').optional()
  ],
  async (req, res, next) => {
  try {
    const { notes } = req.body;
    const technicianId = req.user.id;

    // Get the paused time log's assignment
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder1 = dbType === 'mysql' ? '?' : '$1';
    const placeholder2 = dbType === 'mysql' ? '?' : '$2';
    const pausedTimeLogResult = await db.query(
      `SELECT assignment_id, job_card_id FROM time_logs 
       WHERE id = ${placeholder1} AND technician_id = ${placeholder2} AND status = 'paused'`,
      [req.params.id, technicianId]
    );

    if (pausedTimeLogResult.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'Paused time log not found'
        }
      });
    }

    const pausedTimeLog = pausedTimeLogResult.rows[0];

    // ENFORCE: Cannot resume job timer while on break (centralized check)
    const onBreak = await hasActiveBreak(technicianId);
    logger.info(`[RESUME] techId=${technicianId}, breakActive=${onBreak}, pausedTimeLogId=${req.params.id}`);
    
    if (onBreak) {
      logger.warn(`[RESUME] BLOCKED: Technician ${technicianId} attempted to resume timer while on break`);
      return res.status(409).json({
        error: {
          code: 'ON_BREAK',
          message: 'You cannot resume a job timer while on break. Please end your break first.'
        }
      });
    }
    
    logger.info(`[RESUME] Break check passed, allowing resume for technician ${technicianId}`);

    // ENFORCE: Check for existing active timer (unless multi-tasking enabled)
    let multiTaskingEnabled = false;
    try {
      const keyColumn = dbType === 'mysql' ? '`key`' : 'key';
      const ms = await db.query(
        dbType === 'mysql'
          ? `SELECT value FROM system_settings WHERE ${keyColumn} = ? LIMIT 1`
          : `SELECT value FROM system_settings WHERE key = $1 LIMIT 1`,
        ['timer.multi_tasking_enabled']
      );
      if (ms.rows && ms.rows[0] && ms.rows[0].value != null) {
        const v = typeof ms.rows[0].value === 'string' ? JSON.parse(ms.rows[0].value) : ms.rows[0].value;
        multiTaskingEnabled = !!(v?.enabled ?? v?.value ?? v);
      }
    } catch {
      multiTaskingEnabled = false;
    }
    
    if (!multiTaskingEnabled) {
      const activeTimerPh = dbType === 'mysql' ? '?' : '$1';
      const activeTimerResult = await db.query(
        `SELECT id FROM time_logs WHERE technician_id = ${activeTimerPh} AND status = 'active'`,
        [technicianId]
      );
      if (activeTimerResult.rows.length > 0) {
        return res.status(409).json({
          error: {
            code: 'TIMER_ALREADY_ACTIVE',
            message: 'Another timer is already active. Stop it first or enable multi-tasking.'
          }
        });
      }
    }

    // Create new time log segment
    const notesValue = notes !== undefined ? notes : null;

    let result;
    
    if (dbType === 'mysql') {
      await db.query(
        `INSERT INTO time_logs 
         (assignment_id, technician_id, job_card_id, start_ts, status, notes)
         VALUES (?, ?, ?, NOW(), 'active', ?)`,
        [pausedTimeLog.assignment_id, technicianId, pausedTimeLog.job_card_id, notesValue]
      );
      
      // Fetch the inserted record
      result = await db.query(
        `SELECT id, assignment_id, technician_id, job_card_id, start_ts, status, notes 
         FROM time_logs 
         WHERE assignment_id = ? AND technician_id = ? AND status = 'active' 
         ORDER BY id DESC LIMIT 1`,
        [pausedTimeLog.assignment_id, technicianId]
      );
    } else {
      result = await db.query(
        `INSERT INTO time_logs 
         (assignment_id, technician_id, job_card_id, start_ts, status, notes)
         VALUES ($1, $2, $3, now(), 'active', $4)
         RETURNING id, assignment_id, technician_id, job_card_id, start_ts, status, notes`,
        [pausedTimeLog.assignment_id, technicianId, pausedTimeLog.job_card_id, notesValue]
      );
    }

    // Create audit log
    const auditPlaceholder1 = dbType === 'mysql' ? '?' : '$1';
    const auditPlaceholder2 = dbType === 'mysql' ? '?' : '$2';
    const auditPlaceholder3 = dbType === 'mysql' ? '?' : '$3';
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES (${auditPlaceholder1}, 'timelog.resumed', 'time_log', ${auditPlaceholder2}, ${auditPlaceholder3})`,
      [technicianId, result.rows[0].id, JSON.stringify({ previous_segment: req.params.id })]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Resume timer error:', error);
    next(error);
  }
});

// GET /api/v1/timelogs/active
router.get('/active', async (req, res, next) => {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';

    let queryText = `
      SELECT tl.id, tl.assignment_id, tl.technician_id, tl.job_card_id,
             tl.start_ts, tl.duration_seconds, tl.status,
             jc.job_number, jc.customer_name,
             (SELECT COALESCE(SUM(duration_seconds), 0)
              FROM time_logs tl2
              WHERE tl2.assignment_id = tl.assignment_id
                AND tl2.technician_id = tl.technician_id
                AND tl2.status IN ('paused', 'finished')
             ) as accumulated_seconds
      FROM time_logs tl
      JOIN job_cards jc ON tl.job_card_id = jc.id
      WHERE tl.status = 'active'
    `;
    const params = [];

    // If not admin, only show own active timers
    if (req.user.roleId !== 1) {
      queryText += ` AND tl.technician_id = ${placeholder}`;
      params.push(req.user.id);
    }

    queryText += ' ORDER BY tl.start_ts DESC';

    const result = await db.query(queryText, params);

    res.json({
      data: result.rows
    });
  } catch (error) {
    logger.error('Get active timers error:', error);
    next(error);
  }
});

// POST /api/v1/timelogs/:id/stop
router.post('/:id/stop',
  [
    body('notes').optional()
  ],
  async (req, res, next) => {
    try {
      const { notes } = req.body;
      const timeLogId = req.params.id;
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$1';

      // Get time log
      const result = await db.query(
        `SELECT * FROM time_logs WHERE id = ${placeholder}`,
        [timeLogId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: 'Time log not found'
          }
        });
      }

      const timeLog = result.rows[0];

      // Check ownership
      if (timeLog.technician_id !== req.user.id && req.user.roleId !== 1) {
        return res.status(403).json({
          error: {
            code: 'AUTHORIZATION_FAILED',
            message: 'Time log does not belong to this technician'
          }
        });
      }

      if (timeLog.status !== 'active') {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Time log is not active'
          }
        });
      }

      // Calculate final duration
      const stopTs = new Date();
      const startTs = new Date(timeLog.start_ts);
      const durationSeconds = Math.floor((stopTs - startTs) / 1000);
      
      // Update time log to finished
      if (dbType === 'mysql') {
        await db.query(
          `UPDATE time_logs 
           SET end_ts = NOW(), status = 'finished', notes = COALESCE(?, notes), duration_seconds = ?
           WHERE id = ?`,
          [notes, durationSeconds, timeLogId]
        );
      } else {
        await db.query(
          `UPDATE time_logs 
           SET end_ts = NOW(), status = 'finished', notes = COALESCE($1, notes), duration_seconds = $2
           WHERE id = $3`,
          [notes, durationSeconds, timeLogId]
        );
      }

      // Mark assignment as completed
      if (dbType === 'mysql') {
        await db.query(
          `UPDATE assignments SET status = 'completed', completed_at = NOW() WHERE id = ?`,
          [timeLog.assignment_id]
        );
      } else {
        await db.query(
          `UPDATE assignments SET status = 'completed', completed_at = now() WHERE id = $1`,
          [timeLog.assignment_id]
        );
      }

      // Fetch updated record
      const updatedResult = await db.query(
        `SELECT id, end_ts, status, duration_seconds FROM time_logs WHERE id = ${placeholder}`,
        [timeLogId]
      );

      // Create audit log
      const auditPh1 = dbType === 'mysql' ? '?' : '$1';
      const auditPh2 = dbType === 'mysql' ? '?' : '$2';
      const auditPh3 = dbType === 'mysql' ? '?' : '$3';
      await db.query(
        `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
         VALUES (${auditPh1}, 'timelog.stopped', 'time_log', ${auditPh2}, ${auditPh3})`,
        [req.user.id, timeLogId, JSON.stringify({ duration_seconds: durationSeconds })]
      );

      res.json(updatedResult.rows[0]);
    } catch (error) {
      logger.error('Stop timer error:', error);
      next(error);
    }
  }
);

module.exports = router;
