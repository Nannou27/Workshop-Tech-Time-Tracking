const express = require('express');
const { query, body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { ensureTechnicianProfile, findTechnicianIntegrityIssues } = require('../services/technicianProfileService');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Helpers for schema compatibility
async function tableExists(tableName) {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const checkQuery = dbType === 'mysql'
      ? `SHOW TABLES LIKE '${tableName}'`
      : `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '${tableName}') as exists`;
    const result = await db.query(checkQuery);
    return dbType === 'mysql' ? result.rows.length > 0 : result.rows[0].exists;
  } catch {
    return false;
  }
}

async function columnExists(tableName, columnName) {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const checkQuery = dbType === 'mysql'
      ? `SHOW COLUMNS FROM ${tableName} LIKE '${columnName}'`
      : `SELECT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = '${tableName}' AND column_name = '${columnName}'
        ) as exists`;
    const result = await db.query(checkQuery);
    return dbType === 'mysql' ? result.rows.length > 0 : result.rows[0].exists;
  } catch {
    return false;
  }
}

// GET /api/v1/technicians/integrity
// Admin-only integrity check for orphan technicians and role mismatches.
// NOTE: Must be declared before "/:id" route to avoid being captured as an id param.
router.get('/integrity', requireAdmin, async (req, res, next) => {
  try {
    const result = await findTechnicianIntegrityIssues();
    res.json({ data: result.data });
  } catch (error) {
    next(error);
  }
});

// GET /api/v1/technicians
router.get('/', async (req, res, next) => {
  try {
    let { is_available, trade, search, business_unit_id } = req.query;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : (n) => `$${n}`;

    // Check if users.business_unit_id column exists (schema tolerance)
    const hasUsersBU = await columnExists('users', 'business_unit_id');
    
    // ENFORCE business unit filtering for non-Super Admin users
    const userCheckPlaceholder = dbType === 'mysql' ? '?' : '$1';
    
    if (hasUsersBU) {
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
        
        // If NOT Super Admin, FORCE filter by user's business unit
        if (userRole && userRole.toLowerCase() !== 'super admin' && userBusinessUnitId) {
          business_unit_id = userBusinessUnitId;
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
        const userRole = userResult.rows[0].role_name;
        if (userRole && userRole.toLowerCase() !== 'super admin') {
          logger.warn(`[SECURITY] Cannot enforce business unit filter for ${userRole} - users.business_unit_id column missing`);
        }
      }
    }

    let queryText = `
      SELECT 
        t.user_id,
        t.employee_code,
        t.trade,
        t.skill_tags,
        t.hourly_rate,
        t.max_concurrent_jobs,
        u.email,
        u.display_name,
        u.is_active,
        COUNT(DISTINCT CASE WHEN tl.status = 'active' THEN tl.id END) as active_timers,
        COUNT(DISTINCT CASE WHEN a.status IN ('assigned', 'in_progress') THEN a.id END) as active_assignments
      FROM technicians t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN time_logs tl ON t.user_id = tl.technician_id AND tl.status = 'active'
      LEFT JOIN assignments a ON t.user_id = a.technician_id AND a.status IN ('assigned', 'in_progress')
      WHERE u.is_active = true
    `;
    const params = [];
    let paramCount = 0;

    if (is_available !== undefined) {
      // This would need more complex logic to check schedule and capacity
      // For now, just filter by active status
    }

    if (trade) {
      paramCount++;
      queryText += ` AND t.trade = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`;
      params.push(trade);
    }

    if (search) {
      paramCount++;
      const searchPattern = `%${search}%`;
      if (dbType === 'mysql') {
        queryText += ` AND (u.display_name LIKE ? OR t.employee_code LIKE ?)`;
        params.push(searchPattern, searchPattern);
      } else {
        queryText += ` AND (u.display_name ILIKE $${paramCount} OR t.employee_code ILIKE $${paramCount + 1})`;
        params.push(searchPattern, searchPattern);
        paramCount++;
      }
    }
    
    // Add business_unit_id filter if provided (CRITICAL for multi-tenant security)
    if (business_unit_id) {
      try {
        // Check if business_unit_id column exists in users table
        const buColumnCheck = await db.query(
          dbType === 'mysql' 
            ? `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'business_unit_id'`
            : `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'business_unit_id'`
        );
        
        if (buColumnCheck.rows.length > 0) {
          paramCount++;
          queryText += ` AND u.business_unit_id = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`;
          params.push(business_unit_id);
        }
      } catch (error) {
        logger.warn('Error checking business_unit_id column:', error);
      }
    }

    // MySQL GROUP BY requires all non-aggregated columns
    queryText += ` GROUP BY t.user_id, t.employee_code, t.trade, t.skill_tags, t.hourly_rate, t.max_concurrent_jobs, u.email, u.display_name, u.is_active, u.id`;

    const result = await db.query(queryText, params);

    // Format response
    const technicians = result.rows.map(row => ({
      user_id: row.user_id,
      employee_code: row.employee_code,
      trade: row.trade,
      skill_tags: typeof row.skill_tags === 'string' ? JSON.parse(row.skill_tags) : row.skill_tags,
      hourly_rate: parseFloat(row.hourly_rate) || null,
      max_concurrent_jobs: row.max_concurrent_jobs,
      user: {
        id: row.user_id,
        email: row.email,
        display_name: row.display_name
      },
      is_available: (row.active_timers || 0) < row.max_concurrent_jobs,
      active_timers: parseInt(row.active_timers) || 0,
      active_assignments: parseInt(row.active_assignments) || 0
    }));

    res.json({
      data: technicians
    });
  } catch (error) {
    logger.error('Get technicians error:', error);
    next(error);
  }
});

// GET /api/v1/technicians/:id
router.get('/:id', async (req, res, next) => {
  try {
    const technicianId = req.params.id;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';

    const result = await db.query(
      `SELECT 
        t.user_id,
        t.employee_code,
        t.trade,
        t.skill_tags,
        t.hourly_rate,
        t.max_concurrent_jobs,
        t.metadata,
        u.email,
        u.display_name
       FROM technicians t
       JOIN users u ON t.user_id = u.id
       WHERE t.user_id = ${placeholder}`,
      [String(technicianId)]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'Technician not found'
        }
      });
    }

    const tech = result.rows[0];
    tech.skill_tags = typeof tech.skill_tags === 'string' ? JSON.parse(tech.skill_tags) : tech.skill_tags;
    tech.user = {
      id: tech.user_id,
      email: tech.email,
      display_name: tech.display_name
    };

    // Get schedule (if scheduling tables exist)
    const schedulesTableExists = await tableExists('tech_schedules');
    if (schedulesTableExists) {
      const scheduleResult = await db.query(
        `SELECT weekday, start_time, end_time, timezone 
         FROM tech_schedules 
         WHERE technician_id = ${placeholder} AND is_active = true
         ORDER BY weekday`,
        [String(technicianId)]
      );
      tech.schedule = scheduleResult.rows;
    } else {
      tech.schedule = [];
    }

    res.json(tech);
  } catch (error) {
    logger.error('Get technician error:', error);
    next(error);
  }
});

// PUT /api/v1/technicians/:id/schedule
// Replace weekly schedule for a technician.
// Body: { schedule: [{weekday,start_time,end_time,timezone}] }
const { requireAdminOrServiceAdvisor } = require('../middleware/auth');
router.put('/:id/schedule',
  requireAdminOrServiceAdvisor,
  [
    body('schedule').isArray().withMessage('schedule must be an array'),
    body('schedule.*.weekday').isInt({ min: 0, max: 6 }).withMessage('weekday must be 0-6'),
    body('schedule.*.start_time').isString().withMessage('start_time must be a string'),
    body('schedule.*.end_time').isString().withMessage('end_time must be a string'),
    body('schedule.*.timezone').optional().isString()
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
        });
      }

      const technicianId = String(req.params.id);
      const schedule = req.body.schedule || [];

      const dbType = process.env.DB_TYPE || 'postgresql';

      const schedulesTableExists = await tableExists('tech_schedules');
      if (!schedulesTableExists) {
        return res.status(400).json({
          error: {
            code: 'SCHEMA_MISMATCH',
            message: 'Database schema is missing required table/column for this operation.',
            details: 'tech_schedules table is missing. Apply scheduling section from schema_mysql.sql/schema.sql.'
          }
        });
      }

      // Enforce BU scoping for non-Super Admin actors (same as PATCH)
      const actorPh = dbType === 'mysql' ? '?' : '$1';
      const actorResult = await db.query(
        `SELECT u.business_unit_id, r.name as role_name
         FROM users u
         JOIN roles r ON u.role_id = r.id
         WHERE u.id = ${actorPh}`,
        [req.user.id]
      );
      const actorRole = actorResult.rows[0]?.role_name || null;
      const actorBu = actorResult.rows[0]?.business_unit_id || null;

      if (!actorRole) {
        return res.status(403).json({ error: { code: 'AUTHORIZATION_FAILED', message: 'Role not found' } });
      }
      if (actorRole.toLowerCase() !== 'super admin') {
        if (!actorBu) {
          return res.status(403).json({ error: { code: 'AUTHORIZATION_FAILED', message: 'You must be assigned to a business unit' } });
        }
        const targetBu = await db.query(
          dbType === 'mysql'
            ? `SELECT business_unit_id FROM users WHERE id = ?`
            : `SELECT business_unit_id FROM users WHERE id = $1`,
          [technicianId]
        );
        if (targetBu.rows.length === 0 || !targetBu.rows[0].business_unit_id || String(targetBu.rows[0].business_unit_id) !== String(actorBu)) {
          return res.status(403).json({ error: { code: 'AUTHORIZATION_FAILED', message: 'Cannot modify technicians outside your business unit' } });
        }
      }

      // Basic time validation (HH:MM or HH:MM:SS) and end > start check (best effort)
      const timeRe = /^\d{2}:\d{2}(:\d{2})?$/;
      for (const row of schedule) {
        if (!timeRe.test(row.start_time) || !timeRe.test(row.end_time)) {
          return res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: 'start_time/end_time must be HH:MM (or HH:MM:SS)' }
          });
        }
      }

      // Replace schedule
      if (dbType === 'mysql') {
        await db.query(`DELETE FROM tech_schedules WHERE technician_id = ?`, [technicianId]);
        for (const row of schedule) {
          await db.query(
            `INSERT INTO tech_schedules (technician_id, start_time, end_time, weekday, timezone, is_active)
             VALUES (?, ?, ?, ?, ?, true)`,
            [technicianId, row.start_time, row.end_time, row.weekday, row.timezone || 'Asia/Dubai']
          );
        }
      } else {
        await db.query(`DELETE FROM tech_schedules WHERE technician_id = $1`, [technicianId]);
        for (const row of schedule) {
          await db.query(
            `INSERT INTO tech_schedules (technician_id, start_time, end_time, weekday, timezone, is_active)
             VALUES ($1, $2, $3, $4, $5, true)`,
            [technicianId, row.start_time, row.end_time, row.weekday, row.timezone || 'Asia/Dubai']
          );
        }
      }

      const placeholder = dbType === 'mysql' ? '?' : '$1';
      const refreshed = await db.query(
        `SELECT weekday, start_time, end_time, timezone
         FROM tech_schedules
         WHERE technician_id = ${placeholder} AND is_active = true
         ORDER BY weekday`,
        [technicianId]
      );

      res.json({ data: refreshed.rows });
    } catch (error) {
      logger.error('Update technician schedule error:', error);
      next(error);
    }
  }
);

// POST /api/v1/technicians
router.post('/',
  requireAdminOrServiceAdvisor,
  [
    body('user_id').notEmpty(),
    body('employee_code').notEmpty().trim()
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

      const { user_id, employee_code, trade, hourly_rate, max_concurrent_jobs, skill_tags = [] } = req.body;

      const ensured = await ensureTechnicianProfile({
        actorUserId: req.user.id,
        targetUserId: user_id,
        employeeNumberFallback: null,
        profileInput: {
          employee_code,
          trade,
          hourly_rate,
          max_concurrent_jobs,
          skill_tags
        },
        allowUpdate: false
      });

      if (!ensured.ok) {
        return res.status(ensured.error.code === 'RESOURCE_CONFLICT' ? 409 : 400).json({
          error: ensured.error
        });
      }

      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$1';
      const result = await db.query(
        `SELECT 
           t.user_id, t.employee_code, t.trade, t.hourly_rate, t.max_concurrent_jobs,
           u.email, u.display_name
         FROM technicians t
         JOIN users u ON t.user_id = u.id
         WHERE t.user_id = ${placeholder}`,
        [String(user_id)]
      );

      const technician = result.rows[0] || { user_id, employee_code: ensured.employee_code };
      technician.skill_tags = skill_tags;

      // Create audit log
      const auditPlaceholder = dbType === 'mysql' ? '?' : '$1';
      await db.query(
        `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
         VALUES (${auditPlaceholder}, 'technician.created', 'technician', ${dbType === 'mysql' ? '?' : '$2'}, ${dbType === 'mysql' ? '?' : '$3'})`,
        [req.user.id, user_id, JSON.stringify({ employee_code })]
      );

      res.status(201).json(technician);
    } catch (error) {
      logger.error('Create technician error:', error);
      next(error);
    }
  }
);

// PATCH /api/v1/technicians/:id
// Update technician profile fields (team management)
router.patch('/:id',
  requireAdminOrServiceAdvisor,
  [
    body('employee_code').optional().trim(),
    body('trade').optional({ nullable: true }).trim(),
    body('hourly_rate').optional({ nullable: true }).isFloat().toFloat(),
    body('max_concurrent_jobs').optional().isInt({ min: 1, max: 20 }).toInt()
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

      const technicianId = req.params.id;
      const { employee_code, trade, hourly_rate, max_concurrent_jobs } = req.body;

      const dbType = process.env.DB_TYPE || 'postgresql';
      const ph = dbType === 'mysql' ? '?' : '$';

      // Enforce BU scoping for non-Super Admin actors
      const actorPh = dbType === 'mysql' ? '?' : '$1';
      const actorResult = await db.query(
        `SELECT u.business_unit_id, r.name as role_name
         FROM users u
         JOIN roles r ON u.role_id = r.id
         WHERE u.id = ${actorPh}`,
        [req.user.id]
      );

      let actorRole = null;
      let actorBu = null;
      if (actorResult.rows.length > 0) {
        actorRole = actorResult.rows[0].role_name;
        actorBu = actorResult.rows[0].business_unit_id;
      }

      if (!actorRole) {
        return res.status(403).json({
          error: { code: 'AUTHORIZATION_FAILED', message: 'Role not found' }
        });
      }

      if (actorRole.toLowerCase() !== 'super admin') {
        if (!actorBu) {
          return res.status(403).json({
            error: { code: 'AUTHORIZATION_FAILED', message: 'You must be assigned to a business unit' }
          });
        }

        const targetBu = await db.query(
          dbType === 'mysql'
            ? `SELECT business_unit_id FROM users WHERE id = ?`
            : `SELECT business_unit_id FROM users WHERE id = $1`,
          [String(technicianId)]
        );

        if (targetBu.rows.length === 0 || !targetBu.rows[0].business_unit_id || String(targetBu.rows[0].business_unit_id) !== String(actorBu)) {
          return res.status(403).json({
            error: { code: 'AUTHORIZATION_FAILED', message: 'Cannot modify technicians outside your business unit' }
          });
        }
      }

      const updates = [];
      const params = [];
      let paramCount = 0;

      if (employee_code !== undefined) {
        paramCount++;
        updates.push(`employee_code = ${ph}${dbType === 'mysql' ? '' : paramCount}`);
        params.push(employee_code || null);
      }
      if (trade !== undefined) {
        paramCount++;
        updates.push(`trade = ${ph}${dbType === 'mysql' ? '' : paramCount}`);
        params.push(trade || null);
      }
      if (hourly_rate !== undefined) {
        paramCount++;
        updates.push(`hourly_rate = ${ph}${dbType === 'mysql' ? '' : paramCount}`);
        params.push(hourly_rate);
      }
      if (max_concurrent_jobs !== undefined) {
        paramCount++;
        updates.push(`max_concurrent_jobs = ${ph}${dbType === 'mysql' ? '' : paramCount}`);
        params.push(max_concurrent_jobs);
      }

      if (updates.length === 0) {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'No fields to update' }
        });
      }

      if (dbType === 'mysql') {
        params.push(String(technicianId));
        await db.query(
          `UPDATE technicians SET ${updates.join(', ')}, updated_at = NOW() WHERE user_id = ?`,
          params
        );

        const result = await db.query(
          `SELECT 
             t.user_id, t.employee_code, t.trade, t.hourly_rate, t.max_concurrent_jobs,
             u.email, u.display_name, u.is_active
           FROM technicians t
           JOIN users u ON t.user_id = u.id
           WHERE t.user_id = ?`,
          [String(technicianId)]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Technician not found' } });
        }

        return res.json(result.rows[0]);
      }

      // PostgreSQL
      paramCount++;
      params.push(String(technicianId));
      const result = await db.query(
        `UPDATE technicians SET ${updates.join(', ')}, updated_at = now()
         WHERE user_id = $${paramCount}
         RETURNING *`,
        params
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Technician not found' } });
      }

      res.json(result.rows[0]);
    } catch (error) {
      logger.error('Update technician error:', error);
      next(error);
    }
  }
);

module.exports = router;

