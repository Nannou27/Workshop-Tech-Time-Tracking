const express = require('express');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

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

function safeParseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch (e) {
    return null;
  }
}

function buildNotesWithBreakState(existingNotes, breakState) {
  const parsed = safeParseJson(existingNotes);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return JSON.stringify({ ...parsed, break_state: breakState });
  }
  if (existingNotes && String(existingNotes).trim().length > 0) {
    return JSON.stringify({ notes_text: String(existingNotes), break_state: breakState });
  }
  return JSON.stringify({ break_state: breakState });
}

function appendBreakSegmentToNotes(existingNotes, segment) {
  const parsed = safeParseJson(existingNotes);
  const base = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : (existingNotes ? { notes_text: String(existingNotes) } : {});
  const prior = Array.isArray(base.break_segments) ? base.break_segments : [];
  return JSON.stringify({
    ...base,
    break_segments: [...prior, segment]
  });
}

function closeOpenBreakSegmentInNotes(existingNotes, endTimeIso) {
  const parsed = safeParseJson(existingNotes);
  const base = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : (existingNotes ? { notes_text: String(existingNotes) } : {});
  const prior = Array.isArray(base.break_segments) ? base.break_segments : [];
  if (!prior.length) return JSON.stringify(base);
  const lastOpenFromEnd = [...prior].reverse().findIndex(s => s && !s.end_time);
  if (lastOpenFromEnd < 0) return JSON.stringify(base);
  const realIdx = prior.length - 1 - lastOpenFromEnd;
  const seg = prior[realIdx];
  const start = seg?.start_time ? new Date(seg.start_time) : null;
  const end = endTimeIso ? new Date(endTimeIso) : null;
  const durationSeconds = (start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()))
    ? Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000))
    : (seg?.duration_seconds ?? null);
  const updated = prior.map((s, i) => i === realIdx ? { ...s, end_time: endTimeIso, duration_seconds: durationSeconds } : s);
  return JSON.stringify({ ...base, break_segments: updated });
}

function getBreakStartFromNotes(notes) {
  const parsed = safeParseJson(notes);
  const start = parsed?.break_state?.start_time || null;
  return typeof start === 'string' ? start : null;
}

function getTotalBreakSecondsFromNotes(notes) {
  const parsed = safeParseJson(notes);
  const total = parsed?.break_state?.total_break_seconds;
  const n = Number(total);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function normalizeDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string' && value.includes('/') && value.split('/').length === 3) {
    const [dd, mm, yyyy] = value.split('/').map(s => parseInt(s, 10));
    if (yyyy && mm && dd) return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  if (typeof value === 'string' && value.includes('T')) return value.slice(0, 10);
  return String(value).slice(0, 10);
}

function addShiftAdjustmentAudit(existingNotes, auditEntry) {
  const parsed = safeParseJson(existingNotes);
  const base = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : (existingNotes ? { notes_text: String(existingNotes) } : {});
  const prior = Array.isArray(base.shift_adjustments) ? base.shift_adjustments : [];
  return JSON.stringify({
    ...base,
    shift_adjustments: [...prior, auditEntry]
  });
}

function computeShiftUpdateChanges(existingShift, updates) {
  const changes = {};
  if (Object.prototype.hasOwnProperty.call(updates, 'clock_in_time')) {
    changes.clock_in_time = { from: existingShift.clock_in_time, to: updates.clock_in_time };
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'clock_out_time')) {
    changes.clock_out_time = { from: existingShift.clock_out_time, to: updates.clock_out_time };
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'break_seconds')) {
    changes.break_seconds = { from: existingShift.break_seconds ?? getTotalBreakSecondsFromNotes(existingShift.notes), to: updates.break_seconds };
  }
  return changes;
}

function isBusinessUnitAdmin(roleName) {
  return typeof roleName === 'string' && roleName.toLowerCase().includes('business unit admin');
}

// GET /api/v1/shifts/active - Get technician's active shift
router.get('/active', async (req, res, next) => {
  try {
    const shiftsTableExists = await tableExists('technician_shifts');
    if (!shiftsTableExists) {
      return res.status(400).json({
        error: {
          code: 'SCHEMA_MISMATCH',
          message: 'Database schema is missing required table/column for this operation.'
        }
      });
    }

    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    const result = await db.query(
      `SELECT * FROM technician_shifts 
       WHERE technician_id = ${placeholder} 
       AND clock_out_time IS NULL
       ORDER BY clock_in_time DESC
       LIMIT 1`,
      [req.user.id]
    );

    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.json(null);
    }
  } catch (error) {
    logger.error('Get active shift error:', error);
    next(error);
  }
});

// ============================================================================
// ADMIN / BU ADMIN SHIFT MANAGEMENT (Option A: adjust real shift timestamps)
// ============================================================================

// GET /api/v1/shifts?technician_id=...&start_date=...&end_date=...&limit=...
// Returns shifts for a technician (BU admins are BU-scoped).
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const shiftsTableExists = await tableExists('technician_shifts');
    if (!shiftsTableExists) {
      return res.status(400).json({
        error: { code: 'SCHEMA_MISMATCH', message: 'Database schema is missing required table/column for this operation.' }
      });
    }

    const dbType = process.env.DB_TYPE || 'postgresql';
    const p = (n) => (dbType === 'mysql' ? '?' : `$${n}`);

    const { technician_id, start_date, end_date, limit = 100 } = req.query;
    if (!technician_id) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'technician_id is required' } });
    }

    const startDay = normalizeDateOnly(start_date);
    const endDay = normalizeDateOnly(end_date);

    const actorRole = req.user?.roleName;
    const actorBuId = req.user?.businessUnitId;
    const buScoped = isBusinessUnitAdmin(actorRole) && actorBuId;

    // Schema compatibility: older deployments may miss some columns.
    const hasShiftDate = await columnExists('technician_shifts', 'shift_date');
    const hasTsBusinessUnit = await columnExists('technician_shifts', 'business_unit_id');
    const hasBreakSeconds = await columnExists('technician_shifts', 'break_seconds');
    const hasClockInTime = await columnExists('technician_shifts', 'clock_in_time');
    const hasClockOutTime = await columnExists('technician_shifts', 'clock_out_time');
    const hasClockInLegacy = await columnExists('technician_shifts', 'clock_in');
    const hasClockOutLegacy = await columnExists('technician_shifts', 'clock_out');

    const clockInCol = hasClockInTime ? 'clock_in_time' : (hasClockInLegacy ? 'clock_in' : null);
    const clockOutCol = hasClockOutTime ? 'clock_out_time' : (hasClockOutLegacy ? 'clock_out' : null);
    if (!clockInCol) {
      return res.status(400).json({
        error: {
          code: 'SCHEMA_MISMATCH',
          message: 'Database schema is missing required table/column for this operation.',
          details: 'technician_shifts is missing clock_in_time/clock_in'
        }
      });
    }

    const shiftDateExpr = hasShiftDate ? 'ts.shift_date' : `DATE(ts.${clockInCol})`;

    let query = `
      SELECT 
        ts.id,
        ts.technician_id,
        ${shiftDateExpr} as shift_date,
        ts.${clockInCol} as clock_in_time,
        ${clockOutCol ? `ts.${clockOutCol}` : 'NULL'} as clock_out_time,
        ${hasBreakSeconds ? 'ts.break_seconds' : '0'} as break_seconds,
        ts.notes,
        u.display_name as technician_name,
        u.email as technician_email,
        u.business_unit_id as technician_business_unit_id
      FROM technician_shifts ts
      LEFT JOIN users u ON ts.technician_id = u.id
      WHERE ts.technician_id = ${p(1)}
    `;
    const params = [technician_id];
    let paramCount = 1;

    if (buScoped) {
      paramCount++;
      // MySQL cannot reuse a single placeholder in multiple positions; keep this single-param.
      if (hasTsBusinessUnit) {
        query += ` AND COALESCE(ts.business_unit_id, u.business_unit_id) = ${p(paramCount)}`;
      } else {
        query += ` AND u.business_unit_id = ${p(paramCount)}`;
      }
      params.push(actorBuId);
    }

    if (startDay) {
      paramCount++;
      query += ` AND ${shiftDateExpr} >= ${p(paramCount)}`;
      params.push(startDay);
    }
    if (endDay) {
      paramCount++;
      query += ` AND ${shiftDateExpr} <= ${p(paramCount)}`;
      params.push(endDay);
    }

    query += ` ORDER BY ${shiftDateExpr} DESC, ts.${clockInCol} DESC`;
    // MySQL can be finicky about parameter placeholders in LIMIT in some configurations.
    // Use a safely bounded integer literal instead.
    const safeLimit = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
    query += ` LIMIT ${safeLimit}`;

    const result = await db.query(query, params);
    res.json({ data: result.rows });
  } catch (error) {
    logger.error('List shifts (admin) error:', error);
    next(error);
  }
});

// PATCH /api/v1/shifts/:id
// Body: { clock_in_time, clock_out_time|null, break_seconds, reason }
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const shiftsTableExists = await tableExists('technician_shifts');
    if (!shiftsTableExists) {
      return res.status(400).json({
        error: { code: 'SCHEMA_MISMATCH', message: 'Database schema is missing required table/column for this operation.' }
      });
    }

    const { id } = req.params;
    const { clock_in_time, clock_out_time, break_seconds, reason } = req.body || {};

    if (!reason || String(reason).trim().length < 3) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'reason is required (min 3 characters)' } });
    }

    const clockIn = clock_in_time ? new Date(clock_in_time) : null;
    const clockOut = (clock_out_time === null || clock_out_time === undefined || clock_out_time === '') ? null : new Date(clock_out_time);
    if (!clockIn || Number.isNaN(clockIn.getTime())) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'clock_in_time is required and must be a valid datetime' } });
    }
    if (clockOut && Number.isNaN(clockOut.getTime())) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'clock_out_time must be a valid datetime or null' } });
    }
    if (clockOut && clockOut < clockIn) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'clock_out_time must be after clock_in_time' } });
    }

    const bs = break_seconds === undefined ? undefined : Math.max(0, parseInt(break_seconds, 10) || 0);

    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$';

    // Load existing shift + technician BU for scoping
    const existing = await db.query(
      dbType === 'mysql'
        ? `SELECT ts.*, u.display_name as technician_name, u.business_unit_id as technician_business_unit_id
           FROM technician_shifts ts
           LEFT JOIN users u ON ts.technician_id = u.id
           WHERE ts.id = ? LIMIT 1`
        : `SELECT ts.*, u.display_name as technician_name, u.business_unit_id as technician_business_unit_id
           FROM technician_shifts ts
           LEFT JOIN users u ON ts.technician_id = u.id
           WHERE ts.id = $1 LIMIT 1`,
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Shift not found' } });
    }
    const shift = existing.rows[0];

    const actorRole = req.user?.roleName;
    const actorBuId = req.user?.businessUnitId;
    const buScoped = isBusinessUnitAdmin(actorRole) && actorBuId;
    if (buScoped) {
      const shiftBu = shift.business_unit_id;
      const techBu = shift.technician_business_unit_id;
      if (shiftBu !== actorBuId && techBu !== actorBuId) {
        return res.status(403).json({ error: { code: 'AUTHORIZATION_FAILED', message: 'Cannot adjust shifts outside your Business Unit' } });
      }
    }

    const hasBreakSeconds = await columnExists('technician_shifts', 'break_seconds');
    const hasBreakStartColumn = await columnExists('technician_shifts', 'break_start_time');

    // Prepare updates
    const updates = {
      clock_in_time: clockIn,
      clock_out_time: clockOut
    };
    if (bs !== undefined) updates.break_seconds = bs;

    const changes = computeShiftUpdateChanges(shift, updates);

    const auditEntry = {
      at: new Date().toISOString(),
      by_user_id: req.user?.id,
      by_name: req.user?.displayName || req.user?.email || null,
      reason: String(reason).trim(),
      changes
    };

    const newNotes = addShiftAdjustmentAudit(shift.notes, auditEntry);

    // Build SQL update dynamically for schema compatibility
    if (dbType === 'mysql') {
      const setParts = [`clock_in_time = ?`, `clock_out_time = ?`, `notes = ?`];
      const params = [clockIn, clockOut, newNotes];
      if (hasBreakSeconds && bs !== undefined) {
        setParts.push(`break_seconds = ?`);
        params.push(bs);
      } else if (!hasBreakSeconds && bs !== undefined) {
        // Keep notes JSON break_state in sync when the DB doesn't have break_seconds
        const notesWithBreak = buildNotesWithBreakState(newNotes, { start_time: null, total_break_seconds: bs });
        setParts[2] = `notes = ?`;
        params[2] = notesWithBreak;
      }
      if (hasBreakStartColumn) {
        // Any manual adjustment clears "currently on break" state
        setParts.push(`break_start_time = ?`);
        params.push(null);
      }
      params.push(id);
      await db.query(`UPDATE technician_shifts SET ${setParts.join(', ')} WHERE id = ?`, params);
      const refreshed = await db.query(`SELECT * FROM technician_shifts WHERE id = ?`, [id]);
      return res.json({ data: refreshed.rows[0] });
    }

    // PostgreSQL
    const setParts = [`clock_in_time = $1`, `clock_out_time = $2`, `notes = $3`];
    const params = [clockIn, clockOut, newNotes];
    let idx = 3;
    if (hasBreakSeconds && bs !== undefined) {
      idx++;
      setParts.push(`break_seconds = $${idx}`);
      params.push(bs);
    } else if (!hasBreakSeconds && bs !== undefined) {
      const notesWithBreak = buildNotesWithBreakState(newNotes, { start_time: null, total_break_seconds: bs });
      params[2] = notesWithBreak;
    }
    if (hasBreakStartColumn) {
      idx++;
      setParts.push(`break_start_time = $${idx}`);
      params.push(null);
    }
    idx++;
    params.push(id);
    const result = await db.query(
      `UPDATE technician_shifts SET ${setParts.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    res.json({ data: result.rows[0] });
  } catch (error) {
    logger.error('Adjust shift error:', error);
    next(error);
  }
});

// POST /api/v1/shifts/clock-in - Clock in to start shift
router.post('/clock-in', async (req, res, next) => {
  try {
    const shiftsTableExists = await tableExists('technician_shifts');
    if (!shiftsTableExists) {
      return res.status(400).json({
        error: {
          code: 'SCHEMA_MISMATCH',
          message: 'Database schema is missing required table/column for this operation.'
        }
      });
    }

    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    // Check if already clocked in
    const existingShift = await db.query(
      `SELECT id FROM technician_shifts 
       WHERE technician_id = ${placeholder} 
       AND clock_out_time IS NULL`,
      [req.user.id]
    );

    if (existingShift.rows.length > 0) {
      return res.status(400).json({
        error: {
          code: 'ALREADY_CLOCKED_IN',
          message: 'You are already clocked in. Please clock out first.'
        }
      });
    }

    const { business_unit_id } = req.body;
    const now = new Date();
    const today = now.toISOString().split('T')[0];

    let result;
    if (dbType === 'mysql') {
      await db.query(
        `INSERT INTO technician_shifts (technician_id, business_unit_id, shift_date, clock_in_time)
         VALUES (?, ?, ?, ?)`,
        [req.user.id, business_unit_id || null, today, now]
      );
      
      result = await db.query(
        `SELECT * FROM technician_shifts 
         WHERE technician_id = ? AND clock_out_time IS NULL 
         ORDER BY clock_in_time DESC LIMIT 1`,
        [req.user.id]
      );
    } else {
      result = await db.query(
        `INSERT INTO technician_shifts (technician_id, business_unit_id, shift_date, clock_in_time)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [req.user.id, business_unit_id || null, today, now]
      );
    }

    logger.info(`Technician ${req.user.id} clocked in at ${now}`);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    logger.error('Clock in error:', error);
    next(error);
  }
});

// POST /api/v1/shifts/clock-out - Clock out to end shift
router.post('/clock-out', async (req, res, next) => {
  try {
    const shiftsTableExists = await tableExists('technician_shifts');
    if (!shiftsTableExists) {
      return res.status(400).json({
        error: {
          code: 'SCHEMA_MISMATCH',
          message: 'Database schema is missing required table/column for this operation.'
        }
      });
    }

    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    // Find active shift
    const activeShift = await db.query(
      `SELECT * FROM technician_shifts 
       WHERE technician_id = ${placeholder} 
       AND clock_out_time IS NULL
       ORDER BY clock_in_time DESC LIMIT 1`,
      [req.user.id]
    );

    if (activeShift.rows.length === 0) {
      return res.status(400).json({
        error: {
          code: 'NOT_CLOCKED_IN',
          message: 'You are not currently clocked in.'
        }
      });
    }

    const shift = activeShift.rows[0];
    const now = new Date();
    const clockInTime = new Date(shift.clock_in_time);

    // Exclude breaks from reported total hours if available
    const hasBreakSeconds = await columnExists('technician_shifts', 'break_seconds');
    const breakStartFromNotes = getBreakStartFromNotes(shift.notes);
    const hasBreakStartColumn = await columnExists('technician_shifts', 'break_start_time');
    const breakStart =
      (hasBreakStartColumn && shift.break_start_time) ? new Date(shift.break_start_time) :
      (breakStartFromNotes ? new Date(breakStartFromNotes) : null);

    const priorBreakSeconds = hasBreakSeconds
      ? (Number(shift.break_seconds) || 0)
      : getTotalBreakSecondsFromNotes(shift.notes);

    const ongoingBreakSeconds = breakStart ? Math.max(0, Math.floor((now - breakStart) / 1000)) : 0;
    const totalSeconds = Math.max(0, Math.floor((now - clockInTime) / 1000) - priorBreakSeconds - ongoingBreakSeconds);
    const totalHours = (totalSeconds / 3600).toFixed(2);

    // If clocking out while on break, finalize that break
    if (breakStart) {
      const newTotalBreakSeconds = priorBreakSeconds + ongoingBreakSeconds;
      if (dbType === 'mysql') {
        if (hasBreakSeconds) {
          await db.query(`UPDATE technician_shifts SET break_seconds = ? WHERE id = ?`, [newTotalBreakSeconds, shift.id]);
        } else {
          const notes = buildNotesWithBreakState(shift.notes, { start_time: null, total_break_seconds: newTotalBreakSeconds });
          await db.query(`UPDATE technician_shifts SET notes = ? WHERE id = ?`, [notes, shift.id]);
        }
        if (hasBreakStartColumn) {
          await db.query(`UPDATE technician_shifts SET break_start_time = ? WHERE id = ?`, [null, shift.id]);
        } else {
          const notes = buildNotesWithBreakState(shift.notes, { start_time: null, total_break_seconds: newTotalBreakSeconds });
          await db.query(`UPDATE technician_shifts SET notes = ? WHERE id = ?`, [notes, shift.id]);
        }
      } else {
        if (hasBreakSeconds) {
          await db.query(`UPDATE technician_shifts SET break_seconds = $1 WHERE id = $2`, [newTotalBreakSeconds, shift.id]);
        } else {
          const notes = buildNotesWithBreakState(shift.notes, { start_time: null, total_break_seconds: newTotalBreakSeconds });
          await db.query(`UPDATE technician_shifts SET notes = $1 WHERE id = $2`, [notes, shift.id]);
        }
        if (hasBreakStartColumn) {
          await db.query(`UPDATE technician_shifts SET break_start_time = $1 WHERE id = $2`, [null, shift.id]);
        } else {
          const notes = buildNotesWithBreakState(shift.notes, { start_time: null, total_break_seconds: newTotalBreakSeconds });
          await db.query(`UPDATE technician_shifts SET notes = $1 WHERE id = $2`, [notes, shift.id]);
        }
      }
    }

    // Update shift with clock out time
    if (dbType === 'mysql') {
      await db.query(
        `UPDATE technician_shifts SET clock_out_time = ? WHERE id = ?`,
        [now, shift.id]
      );
    } else {
      await db.query(
        `UPDATE technician_shifts SET clock_out_time = $1 WHERE id = $2`,
        [now, shift.id]
      );
    }

    logger.info(`Technician ${req.user.id} clocked out. Total shift: ${totalHours} hours`);
    
    res.json({
      message: 'Clocked out successfully',
      total_hours: totalHours,
      clock_in_time: shift.clock_in_time,
      clock_out_time: now
    });
  } catch (error) {
    logger.error('Clock out error:', error);
    next(error);
  }
});

// POST /api/v1/shifts/start-break - Start break (pause shift timer)
router.post('/start-break', async (req, res, next) => {
  try {
    const shiftsTableExists = await tableExists('technician_shifts');
    if (!shiftsTableExists) {
      return res.status(400).json({
        error: {
          code: 'SCHEMA_MISMATCH',
          message: 'Database schema is missing required table/column for this operation.'
        }
      });
    }

    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    // Find active shift
    const activeShift = await db.query(
      `SELECT * FROM technician_shifts 
       WHERE technician_id = ${placeholder} 
       AND clock_out_time IS NULL
       ORDER BY clock_in_time DESC LIMIT 1`,
      [req.user.id]
    );

    if (activeShift.rows.length === 0) {
      return res.status(400).json({
        error: {
          code: 'NOT_CLOCKED_IN',
          message: 'You must be clocked in to start a break.'
        }
      });
    }

    const shift = activeShift.rows[0];
    const now = new Date();

    const hasBreakStartColumn = await columnExists('technician_shifts', 'break_start_time');
    const hasBreakSeconds = await columnExists('technician_shifts', 'break_seconds');

    const breakStartExisting = (hasBreakStartColumn && shift.break_start_time)
      ? String(shift.break_start_time)
      : getBreakStartFromNotes(shift.notes);

    if (breakStartExisting) {
      return res.status(400).json({
        error: {
          code: 'ALREADY_ON_BREAK',
          message: 'Break already started. Please end the break first.'
        }
      });
    }

    // Persist break start time; if schema doesn't have a break_start_time column, store in notes JSON.
    if (dbType === 'mysql') {
      if (hasBreakStartColumn) {
        await db.query(`UPDATE technician_shifts SET break_start_time = ? WHERE id = ?`, [now, shift.id]);
      }
      // Always keep notes JSON enriched with break_state + segments (even if schema has break_start_time)
      const priorTotal = hasBreakSeconds ? (Number(shift.break_seconds) || 0) : getTotalBreakSecondsFromNotes(shift.notes);
      let notes = buildNotesWithBreakState(shift.notes, { start_time: now.toISOString(), total_break_seconds: priorTotal });
      notes = appendBreakSegmentToNotes(notes, { start_time: now.toISOString(), end_time: null, duration_seconds: null });
      await db.query(`UPDATE technician_shifts SET notes = ? WHERE id = ?`, [notes, shift.id]);
    } else {
      if (hasBreakStartColumn) {
        await db.query(`UPDATE technician_shifts SET break_start_time = $1 WHERE id = $2`, [now, shift.id]);
      }
      const priorTotal = hasBreakSeconds ? (Number(shift.break_seconds) || 0) : getTotalBreakSecondsFromNotes(shift.notes);
      let notes = buildNotesWithBreakState(shift.notes, { start_time: now.toISOString(), total_break_seconds: priorTotal });
      notes = appendBreakSegmentToNotes(notes, { start_time: now.toISOString(), end_time: null, duration_seconds: null });
      await db.query(`UPDATE technician_shifts SET notes = $1 WHERE id = $2`, [notes, shift.id]);
    }

    logger.info(`Technician ${req.user.id} started break`);
    
    res.json({
      message: 'Break started',
      shift_id: shift.id,
      break_start_time: now.toISOString()
    });
  } catch (error) {
    logger.error('Start break error:', error);
    next(error);
  }
});

// POST /api/v1/shifts/end-break - End break (resume shift timer)
router.post('/end-break', async (req, res, next) => {
  try {
    const shiftsTableExists = await tableExists('technician_shifts');
    if (!shiftsTableExists) {
      return res.status(400).json({
        error: {
          code: 'SCHEMA_MISMATCH',
          message: 'Database schema is missing required table/column for this operation.'
        }
      });
    }

    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';

    const activeShift = await db.query(
      `SELECT * FROM technician_shifts 
       WHERE technician_id = ${placeholder} 
       AND clock_out_time IS NULL
       ORDER BY clock_in_time DESC LIMIT 1`,
      [req.user.id]
    );

    if (activeShift.rows.length === 0) {
      return res.status(400).json({
        error: {
          code: 'NOT_CLOCKED_IN',
          message: 'You must be clocked in to end a break.'
        }
      });
    }

    const shift = activeShift.rows[0];
    const now = new Date();

    const hasBreakStartColumn = await columnExists('technician_shifts', 'break_start_time');
    const hasBreakSeconds = await columnExists('technician_shifts', 'break_seconds');

    const breakStartIso = (hasBreakStartColumn && shift.break_start_time)
      ? new Date(shift.break_start_time).toISOString()
      : getBreakStartFromNotes(shift.notes);

    if (!breakStartIso) {
      return res.status(400).json({
        error: {
          code: 'NOT_ON_BREAK',
          message: 'No active break to end.'
        }
      });
    }

    const breakStart = new Date(breakStartIso);
    const addedSeconds = Math.max(0, Math.floor((now - breakStart) / 1000));

    const priorTotalSeconds = hasBreakSeconds
      ? (Number(shift.break_seconds) || 0)
      : getTotalBreakSecondsFromNotes(shift.notes);

    const newTotalSeconds = priorTotalSeconds + addedSeconds;

    if (dbType === 'mysql') {
      if (hasBreakSeconds) {
        await db.query(`UPDATE technician_shifts SET break_seconds = ? WHERE id = ?`, [newTotalSeconds, shift.id]);
      }
      if (hasBreakStartColumn) {
        await db.query(`UPDATE technician_shifts SET break_start_time = ? WHERE id = ?`, [null, shift.id]);
      }

      // Keep notes JSON in sync for UI (and for DBs without break_start_time/break_seconds)
      let notes = buildNotesWithBreakState(shift.notes, { start_time: null, total_break_seconds: newTotalSeconds });
      notes = closeOpenBreakSegmentInNotes(notes, now.toISOString());
      await db.query(`UPDATE technician_shifts SET notes = ? WHERE id = ?`, [notes, shift.id]);
    } else {
      if (hasBreakSeconds) {
        await db.query(`UPDATE technician_shifts SET break_seconds = $1 WHERE id = $2`, [newTotalSeconds, shift.id]);
      }
      if (hasBreakStartColumn) {
        await db.query(`UPDATE technician_shifts SET break_start_time = $1 WHERE id = $2`, [null, shift.id]);
      }

      let notes = buildNotesWithBreakState(shift.notes, { start_time: null, total_break_seconds: newTotalSeconds });
      notes = closeOpenBreakSegmentInNotes(notes, now.toISOString());
      await db.query(`UPDATE technician_shifts SET notes = $1 WHERE id = $2`, [notes, shift.id]);
    }

    logger.info(`Technician ${req.user.id} ended break. Added ${addedSeconds}s`);
    res.json({
      message: 'Break ended',
      break_seconds_added: addedSeconds,
      total_break_seconds: newTotalSeconds
    });
  } catch (error) {
    logger.error('End break error:', error);
    next(error);
  }
});

// GET /api/v1/shifts/history - Get shift history
router.get('/history', async (req, res, next) => {
  try {
    const { start_date, end_date, limit = 30 } = req.query;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$';
    
    let query = `
      SELECT 
        ts.*,
        CASE 
          WHEN ts.clock_out_time IS NOT NULL 
          THEN TIMESTAMPDIFF(SECOND, ts.clock_in_time, ts.clock_out_time) / 3600.0
          ELSE TIMESTAMPDIFF(SECOND, ts.clock_in_time, NOW()) / 3600.0
        END as total_hours
      FROM technician_shifts ts
      WHERE ts.technician_id = ${placeholder}
    `;
    const params = [req.user.id];
    let paramCount = 1;

    if (start_date) {
      paramCount++;
      query += ` AND ts.shift_date >= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(start_date);
    }

    if (end_date) {
      paramCount++;
      query += ` AND ts.shift_date <= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(end_date);
    }

    query += ` ORDER BY ts.shift_date DESC, ts.clock_in_time DESC`;
    
    paramCount++;
    query += ` LIMIT ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
    params.push(parseInt(limit));

    const result = await db.query(query, params);
    res.json({
      data: result.rows || []
    });
  } catch (error) {
    logger.error('Get shift history error:', error);
    next(error);
  }
});

module.exports = router;


