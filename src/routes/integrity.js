const express = require('express');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/v1/integrity
// Super Admin: integrity scan for orphan/loose records across core workflows.
router.get('/', requireSuperAdmin, async (req, res, next) => {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';

    const q = async (sqlMy, sqlPg, params = []) => {
      const sql = dbType === 'mysql' ? sqlMy : sqlPg;
      const result = await db.query(sql, params);
      return result.rows || [];
    };

    // Orphan time logs (assignment missing)
    const orphanTimeLogs = await q(
      `SELECT tl.id, tl.assignment_id, tl.technician_id, tl.job_card_id, tl.status
       FROM time_logs tl
       LEFT JOIN assignments a ON tl.assignment_id = a.id
       WHERE a.id IS NULL
       ORDER BY tl.id DESC
       LIMIT 50`,
      `SELECT tl.id, tl.assignment_id, tl.technician_id, tl.job_card_id, tl.status
       FROM time_logs tl
       LEFT JOIN assignments a ON tl.assignment_id = a.id
       WHERE a.id IS NULL
       ORDER BY tl.id DESC
       LIMIT 50`
    );

    // Time log mismatch (assignment.job_card_id differs)
    const mismatchedTimeLogs = await q(
      `SELECT tl.id, tl.assignment_id, tl.job_card_id as timelog_job_card_id, a.job_card_id as assignment_job_card_id
       FROM time_logs tl
       JOIN assignments a ON tl.assignment_id = a.id
       WHERE tl.job_card_id <> a.job_card_id
       ORDER BY tl.id DESC
       LIMIT 50`,
      `SELECT tl.id, tl.assignment_id, tl.job_card_id as timelog_job_card_id, a.job_card_id as assignment_job_card_id
       FROM time_logs tl
       JOIN assignments a ON tl.assignment_id = a.id
       WHERE tl.job_card_id <> a.job_card_id
       ORDER BY tl.id DESC
       LIMIT 50`
    );

    // Orphan assignments (job card missing)
    const orphanAssignments = await q(
      `SELECT a.id, a.job_card_id, a.technician_id, a.status
       FROM assignments a
       LEFT JOIN job_cards jc ON a.job_card_id = jc.id
       WHERE jc.id IS NULL
       ORDER BY a.id DESC
       LIMIT 50`,
      `SELECT a.id, a.job_card_id, a.technician_id, a.status
       FROM assignments a
       LEFT JOIN job_cards jc ON a.job_card_id = jc.id
       WHERE jc.id IS NULL
       ORDER BY a.id DESC
       LIMIT 50`
    );

    // Orphan technician profiles (already covered by /technicians/integrity, but include quick counts)
    const orphanTechProfiles = await q(
      `SELECT t.user_id
       FROM technicians t
       LEFT JOIN users u ON t.user_id = u.id
       WHERE u.id IS NULL
       LIMIT 50`,
      `SELECT t.user_id
       FROM technicians t
       LEFT JOIN users u ON t.user_id = u.id
       WHERE u.id IS NULL
       LIMIT 50`
    );

    const response = {
      data: {
        orphan_time_logs: {
          count: orphanTimeLogs.length,
          samples: orphanTimeLogs
        },
        mismatched_time_logs: {
          count: mismatchedTimeLogs.length,
          samples: mismatchedTimeLogs
        },
        orphan_assignments: {
          count: orphanAssignments.length,
          samples: orphanAssignments
        },
        orphan_technician_profiles: {
          count: orphanTechProfiles.length,
          samples: orphanTechProfiles
        }
      }
    };

    res.json(response);
  } catch (err) {
    logger.error('Integrity scan error:', err);
    next(err);
  }
});

module.exports = router;


