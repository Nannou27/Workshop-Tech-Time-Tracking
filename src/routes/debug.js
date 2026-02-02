const express = require('express');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// NON-PROD ONLY: Debug endpoints
if (process.env.NODE_ENV !== 'production') {
  router.use(authenticate);

  // GET /api/v1/debug/break-state - Show raw break state for debugging
  router.get('/break-state', async (req, res, next) => {
    try {
      const technicianId = req.query.technician_id || req.user.id;
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$1';

      const shiftResult = await db.query(
        `SELECT id, technician_id, clock_in_time, clock_out_time, break_start_time, break_seconds, notes
         FROM technician_shifts 
         WHERE technician_id = ${placeholder} AND clock_out_time IS NULL
         ORDER BY clock_in_time DESC LIMIT 1`,
        [technicianId]
      );

      if (shiftResult.rows.length === 0) {
        return res.json({
          technician_id: technicianId,
          shift_active: false,
          break_active: false,
          message: 'No active shift'
        });
      }

      const shift = shiftResult.rows[0];
      const breakActive = shift.break_start_time != null && shift.break_start_time !== '';

      let notesBreakState = null;
      try {
        const notesObj = typeof shift.notes === 'string' ? JSON.parse(shift.notes) : shift.notes;
        notesBreakState = notesObj?.break_state || null;
      } catch (e) {
        notesBreakState = { error: 'Could not parse notes' };
      }

      res.json({
        technician_id: technicianId,
        shift_id: shift.id,
        shift_active: true,
        break_start_time_raw: shift.break_start_time,
        break_seconds_raw: shift.break_seconds,
        break_active_computed: breakActive,
        notes_break_state: notesBreakState,
        clock_in_time: shift.clock_in_time,
        commit_sha: process.env.GIT_COMMIT || process.env.GITHUB_SHA || 'unknown'
      });
    } catch (error) {
      logger.error('Debug break-state error:', error);
      next(error);
    }
  });
}

module.exports = router;

