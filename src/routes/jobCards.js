const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, authorize, requireAdminOrServiceAdvisor } = require('../middleware/auth');
const { validateRequiredFields, isFieldVisible } = require('../utils/fieldVisibility');

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

// Helper function to check if column exists
async function columnExists(tableName, columnName) {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    let checkQuery;
    if (dbType === 'mysql') {
      checkQuery = `SELECT COUNT(*) as count FROM information_schema.columns 
                    WHERE table_schema = DATABASE() 
                    AND table_name = '${tableName}' 
                    AND column_name = '${columnName}'`;
    } else {
      checkQuery = `SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = '${tableName}' AND column_name = '${columnName}'
      ) as exists`;
    }
    const result = await db.query(checkQuery);
    return dbType === 'mysql' ? result.rows[0].count > 0 : result.rows[0].exists;
  } catch (error) {
    return false;
  }
}

function safeParseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

// GET /api/v1/jobcards/lookup?job_number=JC...
// Lookup a job card by job_number (used for previous job linking)
router.get('/lookup', async (req, res, next) => {
  try {
    let { job_number, business_unit_id } = req.query;
    const jobNumber = String(job_number || '').trim();
    if (!jobNumber) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'job_number is required' } });
    }

    const dbType = process.env.DB_TYPE || 'postgresql';

    // ENFORCE business unit filtering for non-Super Admin users
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
      if (userRole && userRole.toLowerCase() !== 'super admin' && userBusinessUnitId) {
        business_unit_id = userBusinessUnitId;
      }
    }

    const hasJobCardsBU = await columnExists('job_cards', 'business_unit_id');
    const hasJobCardsCreatedBy = await columnExists('job_cards', 'created_by');
    const hasUsersBU = await columnExists('users', 'business_unit_id');

    const params = [];
    let queryText;
    if (dbType === 'mysql') {
      queryText = `SELECT id, job_number, customer_name, status, created_at FROM job_cards WHERE job_number = ?`;
      params.push(jobNumber);
      if (business_unit_id) {
        const bu = parseInt(business_unit_id, 10);
        if (hasJobCardsBU) {
          queryText += ` AND (business_unit_id = ? OR business_unit_id IS NULL)`;
          params.push(bu);
        } else if (hasUsersBU && hasJobCardsCreatedBy) {
          queryText += ` AND (EXISTS (SELECT 1 FROM users u WHERE u.id = job_cards.created_by AND (u.business_unit_id = ? OR u.business_unit_id IS NULL)) OR created_by IS NULL)`;
          params.push(bu);
        }
      }
      queryText += ` LIMIT 1`;
    } else {
      queryText = `SELECT id, job_number, customer_name, status, created_at FROM job_cards WHERE job_number = $1`;
      params.push(jobNumber);
      let idx = 1;
      if (business_unit_id) {
        const bu = parseInt(business_unit_id, 10);
        if (hasJobCardsBU) {
          idx++;
          queryText += ` AND (business_unit_id = $${idx} OR business_unit_id IS NULL)`;
          params.push(bu);
        } else if (hasUsersBU && hasJobCardsCreatedBy) {
          idx++;
          queryText += ` AND (EXISTS (SELECT 1 FROM users u WHERE u.id = job_cards.created_by AND (u.business_unit_id = $${idx} OR u.business_unit_id IS NULL)) OR created_by IS NULL)`;
          params.push(bu);
        }
      }
      queryText += ` LIMIT 1`;
    }

    const result = await db.query(queryText, params);
    if (!result.rows || result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Job card not found' } });
    }
    res.json({ data: result.rows[0] });
  } catch (error) {
    logger.error('Job card lookup error:', error);
    next(error);
  }
});

// GET /api/v1/jobcards/plate-history?license_plate=...&limit=5
// Returns recent job cards for a given plate with complaint + bike condition review (stored in metadata).
router.get('/plate-history', async (req, res, next) => {
  try {
    let { license_plate, limit = 5, business_unit_id } = req.query;
    const plateRaw = String(license_plate || '').trim();
    if (!plateRaw) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'license_plate is required' } });
    }

    const normalizedPlate = plateRaw.toUpperCase().replace(/\s+/g, '');
    const dbType = process.env.DB_TYPE || 'postgresql';

    // ENFORCE business unit filtering for non-Super Admin users (same approach as list endpoint)
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
      if (userRole && userRole.toLowerCase() !== 'super admin' && userBusinessUnitId) {
        business_unit_id = userBusinessUnitId;
      }
    }

    const hasJobCardsBU = await columnExists('job_cards', 'business_unit_id');
    const hasJobCardsCreatedBy = await columnExists('job_cards', 'created_by');
    const hasUsersBU = await columnExists('users', 'business_unit_id');

    const safeLimit = Math.min(20, Math.max(1, parseInt(limit, 10) || 5));

    let queryText;
    const params = [];

    if (dbType === 'mysql') {
      queryText = `
        SELECT jc.id, jc.job_number, jc.created_at, jc.work_type, jc.vehicle_info, jc.metadata
        FROM job_cards jc
        WHERE UPPER(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(jc.vehicle_info, '$.license_plate')), ' ', '')) = ?
      `;
      params.push(normalizedPlate);

      if (business_unit_id) {
        const bu = parseInt(business_unit_id, 10);
        if (hasJobCardsBU) {
          queryText += ` AND (jc.business_unit_id = ? OR jc.business_unit_id IS NULL)`;
          params.push(bu);
        } else if (hasUsersBU && hasJobCardsCreatedBy) {
          queryText += ` AND (EXISTS (SELECT 1 FROM users u WHERE u.id = jc.created_by AND (u.business_unit_id = ? OR u.business_unit_id IS NULL)) OR jc.created_by IS NULL)`;
          params.push(bu);
        }
      }

      queryText += ` ORDER BY jc.created_at DESC LIMIT ${safeLimit}`;
    } else {
      queryText = `
        SELECT jc.id, jc.job_number, jc.created_at, jc.work_type, jc.vehicle_info, jc.metadata
        FROM job_cards jc
        WHERE UPPER(REPLACE(COALESCE(jc.vehicle_info->>'license_plate',''), ' ', '')) = $1
      `;
      params.push(normalizedPlate);

      let idx = 1;
      if (business_unit_id) {
        const bu = parseInt(business_unit_id, 10);
        if (hasJobCardsBU) {
          idx++;
          queryText += ` AND (jc.business_unit_id = $${idx} OR jc.business_unit_id IS NULL)`;
          params.push(bu);
        } else if (hasUsersBU && hasJobCardsCreatedBy) {
          idx++;
          queryText += ` AND (EXISTS (SELECT 1 FROM users u WHERE u.id = jc.created_by AND (u.business_unit_id = $${idx} OR u.business_unit_id IS NULL)) OR jc.created_by IS NULL)`;
          params.push(bu);
        }
      }

      queryText += ` ORDER BY jc.created_at DESC LIMIT ${safeLimit}`;
    }

    const result = await db.query(queryText, params);
    const rows = (result.rows || []).map(r => {
      const meta = safeParseJson(r.metadata) || r.metadata || {};
      const wod = (meta && typeof meta === 'object') ? (meta.work_order_details || {}) : {};
      return {
        id: r.id,
        job_number: r.job_number,
        created_at: r.created_at,
        work_type: r.work_type,
        complaint: wod.complaint || wod.problem_description || null,
        bike_condition_review: wod.bike_condition_review || null
      };
    });

    res.json({ data: rows });
  } catch (error) {
    logger.error('Plate history error:', error);
    next(error);
  }
});

// GET /api/v1/jobcards
router.get('/', async (req, res, next) => {
  try {
    let { status, priority, assigned_to, created_after, created_before, search, asset_id, location_id, job_type, business_unit_id, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : (n) => `$${n}`;

    // ENFORCE business unit filtering for non-Super Admin users
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
      
      // If NOT Super Admin, FORCE filter by user's business unit
      if (userRole && userRole.toLowerCase() !== 'super admin' && userBusinessUnitId) {
        business_unit_id = userBusinessUnitId;
        logger.info(`[SECURITY] Enforcing business unit filter for ${userRole}: BU ${userBusinessUnitId}`);
      }
    }

    // Check if asset management tables exist
    const assetsTableExists = await tableExists('assets');
    const locationsTableExists = await tableExists('locations');

    // Build SELECT fields conditionally
    let selectFields = `jc.id, jc.job_number, jc.customer_name, jc.vehicle_info, 
               jc.work_type, jc.priority, jc.status, jc.estimated_hours, 
               jc.actual_hours, jc.created_at, jc.updated_at,
               u.display_name as created_by_name`;
    
    let joinClauses = `FROM job_cards jc
        LEFT JOIN users u ON jc.created_by = u.id`;
    
    // Add asset management fields if tables exist
    if (assetsTableExists && locationsTableExists) {
      selectFields += `, jc.asset_id, jc.location_id, jc.job_type, jc.parent_work_order_id,
               a.name as asset_name, a.asset_tag as asset_tag,
               l.name as location_name,
               parent.job_number as parent_work_order_number`;
      joinClauses += `
        LEFT JOIN assets a ON jc.asset_id = a.id
        LEFT JOIN locations l ON jc.location_id = l.id
        LEFT JOIN job_cards parent ON jc.parent_work_order_id = parent.id`;
    }
    
    let queryText;
    if (dbType === 'mysql') {
      // For MySQL, calculate duration on the fly if duration_seconds is 0 or NULL
      queryText = `
        SELECT ${selectFields},
               COALESCE(SUM(
                 CASE 
                   WHEN tl.status = 'finished' THEN 
                     CASE 
                       WHEN tl.duration_seconds > 0 THEN tl.duration_seconds
                       WHEN tl.end_ts IS NOT NULL THEN TIMESTAMPDIFF(SECOND, tl.start_ts, tl.end_ts)
                       ELSE 0
                     END
                   ELSE 0
                 END
               ), 0) as total_time_seconds
        ${joinClauses}
        LEFT JOIN time_logs tl ON jc.id = tl.job_card_id
        WHERE 1=1
      `;
    } else {
      // For PostgreSQL, use duration_seconds directly
      queryText = `
        SELECT ${selectFields},
               COALESCE(SUM(CASE WHEN tl.status = 'finished' THEN tl.duration_seconds ELSE 0 END), 0) as total_time_seconds
        ${joinClauses}
        LEFT JOIN time_logs tl ON jc.id = tl.job_card_id
        WHERE 1=1
      `;
    }
    const params = [];
    let paramCount = 0;

    // Apply filters based on role
    if (req.user.roleId !== 1) { // Not admin - filter by assignments for technicians
      // TODO: Add assignment-based filtering for technicians
    }

    if (status) {
      const statuses = status.split(',');
      if (dbType === 'mysql') {
        paramCount++;
        queryText += ` AND jc.status IN (${statuses.map(() => '?').join(',')})`;
        params.push(...statuses);
      } else {
        paramCount++;
        queryText += ` AND jc.status = ANY($${paramCount})`;
        params.push(statuses);
      }
    }

    if (priority) {
      paramCount++;
      queryText += ` AND jc.priority = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`;
      params.push(parseInt(priority));
    }

    if (assigned_to) {
      paramCount++;
      queryText += ` AND EXISTS (
        SELECT 1 FROM assignments a 
        WHERE a.job_card_id = jc.id 
        AND a.technician_id = ${dbType === 'mysql' ? '?' : `$${paramCount}`}
        AND a.status IN ('assigned', 'in_progress')
      )`;
      params.push(assigned_to);
    }

    if (created_after) {
      paramCount++;
      queryText += ` AND jc.created_at >= ${dbType === 'mysql' ? '?' : `$${paramCount}`}`;
      params.push(created_after);
    }

    if (created_before) {
      paramCount++;
      queryText += ` AND jc.created_at <= ${dbType === 'mysql' ? '?' : `$${paramCount}`}`;
      params.push(created_before);
    }

    // Only add asset/location filters if tables exist
    if (assetsTableExists && locationsTableExists) {
      if (asset_id) {
        paramCount++;
        queryText += ` AND jc.asset_id = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`;
        params.push(asset_id);
      }
      
      if (location_id) {
        paramCount++;
        queryText += ` AND jc.location_id = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`;
        params.push(location_id);
      }
      
      if (job_type) {
        paramCount++;
        queryText += ` AND jc.job_type = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`;
        params.push(job_type);
      }
    }
    
    // Add business_unit_id filter if provided (CRITICAL for multi-tenant security)
    const buColumnExists = await columnExists('job_cards', 'business_unit_id');
    if (business_unit_id && buColumnExists) {
      paramCount++;
      queryText += ` AND jc.business_unit_id = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`;
      params.push(business_unit_id);
    }
    
    if (search) {
      paramCount++;
      const searchPattern = `%${search}%`;
      if (dbType === 'mysql') {
        queryText += ` AND (
          jc.job_number LIKE ? OR 
          jc.customer_name LIKE ? OR
          JSON_EXTRACT(jc.vehicle_info, '$') LIKE ?
        )`;
        params.push(searchPattern, searchPattern, searchPattern);
      } else {
        queryText += ` AND (
          jc.job_number ILIKE $${paramCount} OR 
          jc.customer_name ILIKE $${paramCount} OR
          jc.vehicle_info::text ILIKE $${paramCount}
        )`;
        params.push(searchPattern);
      }
    }

    // Add GROUP BY for aggregate function (required when using SUM)
    let groupByFields = `jc.id, jc.job_number, jc.customer_name, jc.vehicle_info, 
                            jc.work_type, jc.priority, jc.status, jc.estimated_hours, 
                            jc.actual_hours, jc.created_at, jc.updated_at, u.display_name`;
    if (assetsTableExists && locationsTableExists) {
      groupByFields += `, jc.asset_id, jc.location_id, jc.job_type, jc.parent_work_order_id, a.name, a.asset_tag, l.name, parent.job_number`;
    }
    queryText += ` GROUP BY ${groupByFields}`;

    paramCount++;
    queryText += ` ORDER BY jc.created_at DESC LIMIT ${dbType === 'mysql' ? '?' : `$${paramCount}`}`;
    params.push(parseInt(limit));
    paramCount++;
    queryText += ` OFFSET ${dbType === 'mysql' ? '?' : `$${paramCount}`}`;
    params.push(offset);

    const result = await db.query(queryText, params);
    
    // Format time for each job card
    result.rows.forEach(jobCard => {
      const totalSeconds = jobCard.total_time_seconds ? parseInt(jobCard.total_time_seconds) : 0;
      if (totalSeconds > 0) {
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        jobCard.total_time_formatted = hours > 0 
          ? `${hours}h ${minutes}m` 
          : `${minutes}m`;
        jobCard.total_time_hours = (totalSeconds / 3600).toFixed(2);
      } else {
        // Fallback to actual_hours if available
        if (jobCard.actual_hours && parseFloat(jobCard.actual_hours) > 0) {
          const hours = Math.floor(jobCard.actual_hours);
          const minutes = Math.round((jobCard.actual_hours - hours) * 60);
          jobCard.total_time_formatted = hours > 0 
            ? `${hours}h ${minutes}m` 
            : `${minutes}m`;
          jobCard.total_time_hours = parseFloat(jobCard.actual_hours).toFixed(2);
        } else {
          jobCard.total_time_formatted = '-';
          jobCard.total_time_hours = '0.00';
        }
      }
    });

    // Get assignments for each job card and check if job card status needs updating
    const assignmentPlaceholder = dbType === 'mysql' ? '?' : '$1';
    for (const jobCard of result.rows) {
      const assignmentsResult = await db.query(
        `SELECT a.id, a.status, a.assigned_at, a.technician_id,
                u.id as technician_user_id, u.display_name as technician_name,
                t.employee_code
         FROM assignments a
         JOIN technicians t ON a.technician_id = t.user_id
         JOIN users u ON t.user_id = u.id
         WHERE a.job_card_id = ${assignmentPlaceholder}`,
        [jobCard.id]
      );
      jobCard.assignments = assignmentsResult.rows;
      
      // Check if job card status should be updated based on assignments
      if (jobCard.assignments.length > 0) {
        const totalAssignments = jobCard.assignments.length;
        const completedAssignments = jobCard.assignments.filter(a => a.status === 'completed').length;
        const cancelledAssignments = jobCard.assignments.filter(a => a.status === 'cancelled').length;
        const activeAssignments = totalAssignments - completedAssignments - cancelledAssignments;
        
        // If all assignments are completed and job card is not completed, update it
        if (completedAssignments > 0 && activeAssignments === 0 && jobCard.status !== 'completed') {
          await db.query(
            `UPDATE job_cards SET status = 'completed', completed_at = ${dbType === 'mysql' ? 'NOW()' : 'now()'} 
             WHERE id = ${assignmentPlaceholder}`,
            [jobCard.id]
          );
          jobCard.status = 'completed';
        } 
        // If at least one assignment is completed and job card is still open, update to in_progress
        else if (completedAssignments > 0 && jobCard.status === 'open') {
          await db.query(
            `UPDATE job_cards SET status = 'in_progress' 
             WHERE id = ${assignmentPlaceholder}`,
            [jobCard.id]
          );
          jobCard.status = 'in_progress';
        }
      }
    }

    res.json({
      data: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: result.rows.length,
        total_pages: Math.ceil(result.rows.length / limit)
      }
    });
  } catch (error) {
    logger.error('Get job cards error:', error);
    next(error);
  }
});

// GET /api/v1/jobcards/:id
router.get('/:id', async (req, res, next) => {
  try {
    const jobCardId = req.params.id;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    // Check if asset management tables exist
    const assetsTableExists = await tableExists('assets');
    const locationsTableExists = await tableExists('locations');
    
    let selectFields = `jc.*, u.display_name as created_by_name`;
    let joinClauses = `FROM job_cards jc
       LEFT JOIN users u ON jc.created_by = u.id`;
    
    if (assetsTableExists && locationsTableExists) {
      selectFields += `, a.name as asset_name, a.asset_tag as asset_tag, a.serial_number as asset_serial_number,
              l.name as location_name, l.address as location_address,
              parent.job_number as parent_work_order_number, parent.customer_name as parent_customer_name`;
      joinClauses += `
       LEFT JOIN assets a ON jc.asset_id = a.id
       LEFT JOIN locations l ON jc.location_id = l.id
       LEFT JOIN job_cards parent ON jc.parent_work_order_id = parent.id`;
    }
    
    const result = await db.query(
      `SELECT ${selectFields}
       ${joinClauses}
       WHERE jc.id = ${placeholder}`,
      [jobCardId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'Job card not found'
        }
      });
    }

    const jobCard = result.rows[0];

    // Get notes
    const notesResult = await db.query(
      `SELECT jcn.id, jcn.note_text, jcn.is_internal, jcn.created_at,
              u.display_name as author_name
       FROM job_card_notes jcn
       JOIN users u ON jcn.author_id = u.id
       WHERE jcn.job_card_id = ${placeholder}
       ORDER BY jcn.created_at DESC`,
      [jobCardId]
    );
    jobCard.notes = notesResult.rows;

    // Get attachments
    const attachmentsResult = await db.query(
      `SELECT id, file_name, file_path, file_size, mime_type, created_at
       FROM job_card_attachments
       WHERE job_card_id = ${placeholder}
       ORDER BY created_at DESC`,
      [jobCardId]
    );
    jobCard.attachments = attachmentsResult.rows;

    // Get assignments
    const assignmentsResult = await db.query(
      `SELECT a.id, a.status, a.assigned_at, a.started_at, a.completed_at,
              u.id as technician_id, u.display_name as technician_name,
              t.employee_code
       FROM assignments a
       JOIN technicians t ON a.technician_id = t.user_id
       JOIN users u ON t.user_id = u.id
       WHERE a.job_card_id = ${placeholder}`,
      [jobCardId]
    );
    jobCard.assignments = assignmentsResult.rows;

    // Get time logs
    const timeLogsResult = await db.query(
      `SELECT id, start_ts, end_ts, duration_seconds, status, notes
       FROM time_logs
       WHERE job_card_id = ${placeholder}
       ORDER BY start_ts DESC`,
      [jobCardId]
    );
    jobCard.time_logs = timeLogsResult.rows;

    res.json(jobCard);
  } catch (error) {
    logger.error('Get job card error:', error);
    next(error);
  }
});

// POST /api/v1/jobcards
router.post('/',
  [
    body('job_number').notEmpty().trim(),
    // Customer/Company name should be optional (non-mandatory)
    body('customer_name').optional({ checkFalsy: true }).trim().isLength({ max: 255 }),
    body('priority').optional().isInt({ min: 1, max: 5 })
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
        job_number,
        customer_name,
        vehicle_info,
        work_type,
        priority = 3,
        estimated_hours,
        asset_id,
        location_id,
        job_type,
        parent_work_order_id,
        problem_description,
        bike_condition_review,
        job_category,
        previous_job_number,
        metadata = {}
      } = req.body;

      // Normalize optional fields so empty strings don't get treated as "required"
      const normalizedCustomerName = (typeof customer_name === 'string' && customer_name.trim()) ? customer_name.trim() : null;
      const normalizedWorkType = (typeof work_type === 'string' && work_type.trim()) ? work_type.trim() : null;
      const normalizedProblemDescription = (typeof problem_description === 'string' && problem_description.trim()) ? problem_description.trim() : null;
      const normalizedLocationId =
        location_id === undefined || location_id === null || location_id === ''
          ? null
          : location_id;

      // Check if job number exists
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$1';
      const existing = await db.query(
        `SELECT id FROM job_cards WHERE job_number = ${placeholder}`,
        [job_number]
      );

      if (existing.rows.length > 0) {
        return res.status(409).json({
          error: {
            code: 'RESOURCE_CONFLICT',
            message: 'Job card with this number already exists'
          }
        });
      }

      // Enforce "required" only when BU explicitly sets is_required=true via field visibility.
      // Default is non-mandatory when there is no field_visibility_settings row.
      const requiredKeys = new Set();
      try {
        const userBuRes = await db.query(
          `SELECT business_unit_id FROM users WHERE id = ${dbType === 'mysql' ? '?' : '$1'}`,
          [req.user.id]
        );
        const buId = userBuRes.rows?.[0]?.business_unit_id;
        if (buId) {
          const buPh = dbType === 'mysql' ? '?' : '$1';
          const reqRes = await db.query(
            `SELECT section_name, field_name, is_required
             FROM field_visibility_settings
             WHERE business_unit_id = ${buPh}
               AND (
                 (section_name = 'customer_info' AND field_name = 'customer_name')
                 OR (section_name = 'work_order_details' AND field_name = 'work_type')
                 OR (section_name = 'work_order_details' AND field_name = 'problem_description')
                 OR (section_name = 'location_assignment' AND field_name = 'location_id')
               )`,
            [buId]
          );
          (reqRes.rows || []).forEach(r => {
            if (r.is_required) requiredKeys.add(`${r.section_name}.${r.field_name}`);
          });
        }
      } catch (e) {
        // If field visibility tables aren't installed yet, default to non-mandatory.
        logger.warn('Could not evaluate BU required fields (defaulting to non-mandatory):', e);
      }

      const missing = [];
      if (requiredKeys.has('customer_info.customer_name') && !normalizedCustomerName) missing.push('Company Name');
      if (requiredKeys.has('work_order_details.work_type') && !normalizedWorkType) missing.push('Work Type');
      if (requiredKeys.has('work_order_details.problem_description') && !normalizedProblemDescription) missing.push('Complaint / Rider Issue');
      if (requiredKeys.has('location_assignment.location_id') && !normalizedLocationId) missing.push('Location');

      if (missing.length) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: missing.map(field => ({ field, msg: `${field} is required` }))
          }
        });
      }

      // Validate asset_id if provided
      if (asset_id) {
        const assetPlaceholder = dbType === 'mysql' ? '?' : '$1';
        const assetCheck = await db.query(
          `SELECT id FROM assets WHERE id = ${assetPlaceholder}`,
          [asset_id]
        );
        if (assetCheck.rows.length === 0) {
          return res.status(400).json({
            error: {
              code: 'INVALID_ASSET',
              message: 'Asset not found'
            }
          });
        }
      }
      
      // Validate location_id if provided
      if (normalizedLocationId) {
        const locPlaceholder = dbType === 'mysql' ? '?' : '$1';
        const locCheck = await db.query(
          `SELECT id FROM locations WHERE id = ${locPlaceholder}`,
          [normalizedLocationId]
        );
        if (locCheck.rows.length === 0) {
          return res.status(400).json({
            error: {
              code: 'INVALID_LOCATION',
              message: 'Location not found'
            }
          });
        }
      }
      
      // Validate parent_work_order_id if provided
      if (parent_work_order_id) {
        const parentPlaceholder = dbType === 'mysql' ? '?' : '$1';
        const parentCheck = await db.query(
          `SELECT id FROM job_cards WHERE id = ${parentPlaceholder}`,
          [parent_work_order_id]
        );
        if (parentCheck.rows.length === 0) {
          return res.status(400).json({
            error: {
              code: 'INVALID_PARENT_WORK_ORDER',
              message: 'Parent work order not found'
            }
          });
        }
      }

      // If previous_job_number is provided and parent_work_order_id isn't, resolve it server-side for robustness.
      let resolvedParentWorkOrderId = parent_work_order_id || null;
      if (!resolvedParentWorkOrderId && previous_job_number) {
        const lookupPh = dbType === 'mysql' ? '?' : '$1';
        const lookup = await db.query(
          `SELECT id FROM job_cards WHERE job_number = ${lookupPh} LIMIT 1`,
          [String(previous_job_number).trim()]
        );
        if (lookup.rows.length > 0) {
          resolvedParentWorkOrderId = lookup.rows[0].id;
        }
      }
      
      // Set business_unit_id from the logged-in user
      let businessUnitIdForInsert = null;
      
      // Try to get business_unit_id from the user
      try {
        const userPlaceholder = dbType === 'mysql' ? '?' : '$1';
        const userResult = await db.query(
          `SELECT business_unit_id FROM users WHERE id = ${userPlaceholder}`,
          [req.user.id]
        );
        
        if (userResult.rows.length > 0 && userResult.rows[0].business_unit_id) {
          businessUnitIdForInsert = userResult.rows[0].business_unit_id;
        }
      } catch (error) {
        logger.warn('Could not fetch user business_unit_id:', error);
      }
      
      // Normalize metadata and capture optional work order details
      const normalizedMetadata = (metadata && typeof metadata === 'object') ? { ...metadata } : {};
      if (normalizedProblemDescription) {
        if (!normalizedMetadata.work_order_details || typeof normalizedMetadata.work_order_details !== 'object') {
          normalizedMetadata.work_order_details = {};
        }
        normalizedMetadata.work_order_details.problem_description = String(normalizedProblemDescription);
        // Keep a dedicated complaint field too (new UI uses this concept)
        if (!normalizedMetadata.work_order_details.complaint) {
          normalizedMetadata.work_order_details.complaint = String(normalizedProblemDescription);
        }
      }
      if (bike_condition_review) {
        if (!normalizedMetadata.work_order_details || typeof normalizedMetadata.work_order_details !== 'object') {
          normalizedMetadata.work_order_details = {};
        }
        normalizedMetadata.work_order_details.bike_condition_review = String(bike_condition_review);
      }
      if (job_category) {
        if (!normalizedMetadata.work_order_details || typeof normalizedMetadata.work_order_details !== 'object') {
          normalizedMetadata.work_order_details = {};
        }
        normalizedMetadata.work_order_details.job_category = String(job_category);
      }
      if (previous_job_number) {
        if (!normalizedMetadata.work_order_details || typeof normalizedMetadata.work_order_details !== 'object') {
          normalizedMetadata.work_order_details = {};
        }
        normalizedMetadata.work_order_details.previous_job_number = String(previous_job_number);
        if (resolvedParentWorkOrderId) normalizedMetadata.work_order_details.previous_job_card_id = resolvedParentWorkOrderId;
      }

      // Check if business_unit_id column exists
      const buColumnExists = await columnExists('job_cards', 'business_unit_id');
      
      let jobCard;
      
      if (dbType === 'mysql') {
        const insertFields = buColumnExists
          ? `(job_number, customer_name, vehicle_info, work_type, priority, estimated_hours, asset_id, location_id, job_type, parent_work_order_id, business_unit_id, created_by, metadata)`
          : `(job_number, customer_name, vehicle_info, work_type, priority, estimated_hours, asset_id, location_id, job_type, parent_work_order_id, created_by, metadata)`;
        
        const insertValues = buColumnExists
          ? `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          : `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        
        const insertParams = buColumnExists
          ? [
              job_number,
              normalizedCustomerName,
              JSON.stringify(vehicle_info || {}),
              normalizedWorkType,
              priority,
              estimated_hours,
              asset_id || null,
              normalizedLocationId,
              job_type || null,
              resolvedParentWorkOrderId || null,
              businessUnitIdForInsert,
              req.user.id,
              JSON.stringify(normalizedMetadata)
            ]
          : [
              job_number,
              normalizedCustomerName,
              JSON.stringify(vehicle_info || {}),
              normalizedWorkType,
              priority,
              estimated_hours,
              asset_id || null,
              normalizedLocationId,
              job_type || null,
              resolvedParentWorkOrderId || null,
              req.user.id,
              JSON.stringify(normalizedMetadata)
            ];
        
        await db.query(
          `INSERT INTO job_cards ${insertFields} VALUES ${insertValues}`,
          insertParams
        );
        
        // Fetch the inserted record
        const result = await db.query(
          'SELECT id, job_number, status, created_at FROM job_cards WHERE job_number = ?',
          [job_number]
        );
        jobCard = result.rows[0];
      } else {
        const insertFields = buColumnExists
          ? `(job_number, customer_name, vehicle_info, work_type, priority, estimated_hours, asset_id, location_id, job_type, parent_work_order_id, business_unit_id, created_by, metadata)`
          : `(job_number, customer_name, vehicle_info, work_type, priority, estimated_hours, asset_id, location_id, job_type, parent_work_order_id, created_by, metadata)`;
        
        const insertValues = buColumnExists
          ? `($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`
          : `($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`;
        
        const insertParams = buColumnExists
          ? [
              job_number,
              normalizedCustomerName,
              JSON.stringify(vehicle_info || {}),
              normalizedWorkType,
              priority,
              estimated_hours,
              asset_id || null,
              normalizedLocationId,
              job_type || null,
              resolvedParentWorkOrderId || null,
              businessUnitIdForInsert,
              req.user.id,
              JSON.stringify(normalizedMetadata)
            ]
          : [
              job_number,
              normalizedCustomerName,
              JSON.stringify(vehicle_info || {}),
              normalizedWorkType,
              priority,
              estimated_hours,
              asset_id || null,
              normalizedLocationId,
              job_type || null,
              resolvedParentWorkOrderId || null,
              req.user.id,
              JSON.stringify(normalizedMetadata)
            ];
        
        const result = await db.query(
          `INSERT INTO job_cards ${insertFields} VALUES ${insertValues} RETURNING id, job_number, status, created_at`,
          insertParams
        );
        jobCard = result.rows[0];
      }

      // Create audit log (placeholders will be converted by connection.js for MySQL)
      await db.query(
        `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
         VALUES ($1, 'jobcard.created', 'job_card', $2, $3)`,
        [req.user.id, jobCard.id, JSON.stringify({ job_number: jobCard.job_number })]
      );

      res.status(201).json(jobCard);
    } catch (error) {
      logger.error('Create job card error:', error);
      next(error);
    }
  }
);

// PATCH /api/v1/jobcards/:id
router.patch('/:id',
  requireAdminOrServiceAdvisor,
  [
    body('status').optional().isIn(['open', 'in_progress', 'on_hold', 'completed', 'cancelled']),
    body('priority').optional().isInt({ min: 1, max: 5 }),
    // Allow clearing these fields (non-mandatory)
    body('customer_name').optional({ checkFalsy: true }).trim().isLength({ max: 255 }),
    body('work_type').optional({ checkFalsy: true }).trim().isLength({ max: 255 }),
    body('estimated_hours').optional({ nullable: true }).isFloat({ min: 0 }),
    body('problem_description').optional({ nullable: true }).trim(),
    body('bike_condition_review').optional({ nullable: true }).trim(),
    body('job_category').optional({ nullable: true }).trim(),
    body('previous_job_number').optional({ nullable: true }).trim()
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

      const jobCardId = req.params.id;
      const dbType = process.env.DB_TYPE || 'postgresql';

      // Enforce BU scoping for non-Super Admin users
      const roleName = String(req.user?.roleName || '').toLowerCase();
      const isSuperAdmin = roleName === 'super admin';
      const userBu = req.user?.businessUnitId || null;
      const hasJobCardsBU = await columnExists('job_cards', 'business_unit_id');
      const hasJobCardsCreatedBy = await columnExists('job_cards', 'created_by');
      const hasUsersBU = await columnExists('users', 'business_unit_id');

      const jcPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const selectCols = [
        'jc.id',
        'jc.metadata',
        hasJobCardsBU ? 'jc.business_unit_id' : null,
        hasJobCardsCreatedBy ? 'jc.created_by' : null,
        (hasJobCardsCreatedBy && hasUsersBU) ? 'u.business_unit_id as creator_business_unit_id' : null
      ].filter(Boolean).join(', ');

      const join = (hasJobCardsCreatedBy && hasUsersBU)
        ? 'LEFT JOIN users u ON jc.created_by = u.id'
        : '';

      const existingRes = await db.query(
        `SELECT ${selectCols} FROM job_cards jc ${join} WHERE jc.id = ${jcPlaceholder}`,
        [jobCardId]
      );

      if (!existingRes.rows || existingRes.rows.length === 0) {
        return res.status(404).json({
          error: { code: 'RESOURCE_NOT_FOUND', message: 'Job card not found' }
        });
      }

      const existing = existingRes.rows[0];
      if (!isSuperAdmin && userBu) {
        const bu = parseInt(userBu, 10);
        let allowed = false;
        if (hasJobCardsBU) {
          allowed = allowed || existing.business_unit_id === bu || existing.business_unit_id == null;
        }
        if (!allowed && hasJobCardsCreatedBy && hasUsersBU) {
          allowed = allowed || existing.creator_business_unit_id === bu || existing.creator_business_unit_id == null || existing.created_by == null;
        }
        if (!allowed) {
          return res.status(403).json({
            error: { code: 'AUTHORIZATION_FAILED', message: 'You do not have permission to update this job card' }
          });
        }
      }

      const {
        status,
        priority,
        customer_name,
        vehicle_info,
        work_type,
        estimated_hours,
        asset_id,
        location_id,
        job_type,
        parent_work_order_id,
        metadata,
        problem_description,
        bike_condition_review,
        job_category,
        previous_job_number
      } = req.body;

      const updates = [];
      const params = [];
      let paramCount = 0;

      if (status !== undefined) {
        paramCount++;
        const ph = dbType === 'mysql' ? '?' : `$${paramCount}`;
        updates.push(`status = ${ph}`);
        params.push(status);
        
        if (status === 'completed') {
          // Only set completed_at if column exists (schema compatibility)
          if (await columnExists('job_cards', 'completed_at')) {
            updates.push(dbType === 'mysql' ? `completed_at = NOW()` : `completed_at = now()`);
          }
        }
      }

      if (priority !== undefined) {
        paramCount++;
        const ph = dbType === 'mysql' ? '?' : `$${paramCount}`;
        updates.push(`priority = ${ph}`);
        params.push(priority);
      }

      if (customer_name !== undefined) {
        paramCount++;
        const ph = dbType === 'mysql' ? '?' : `$${paramCount}`;
        updates.push(`customer_name = ${ph}`);
        params.push(customer_name);
      }

      if (vehicle_info !== undefined) {
        paramCount++;
        const ph = dbType === 'mysql' ? '?' : `$${paramCount}`;
        updates.push(`vehicle_info = ${ph}`);
        params.push(dbType === 'mysql' ? JSON.stringify(vehicle_info || {}) : (vehicle_info || {}));
      }

      if (work_type !== undefined) {
        paramCount++;
        const ph = dbType === 'mysql' ? '?' : `$${paramCount}`;
        updates.push(`work_type = ${ph}`);
        params.push(work_type);
      }

      if (estimated_hours !== undefined) {
        paramCount++;
        const ph = dbType === 'mysql' ? '?' : `$${paramCount}`;
        updates.push(`estimated_hours = ${ph}`);
        params.push(estimated_hours);
      }

      if (asset_id !== undefined) {
        paramCount++;
        const ph = dbType === 'mysql' ? '?' : `$${paramCount}`;
        updates.push(`asset_id = ${ph}`);
        params.push(asset_id);
      }
      
      if (location_id !== undefined) {
        paramCount++;
        const ph = dbType === 'mysql' ? '?' : `$${paramCount}`;
        updates.push(`location_id = ${ph}`);
        params.push(location_id);
      }
      
      if (job_type !== undefined) {
        paramCount++;
        const ph = dbType === 'mysql' ? '?' : `$${paramCount}`;
        updates.push(`job_type = ${ph}`);
        params.push(job_type);
      }
      
      if (parent_work_order_id !== undefined) {
        paramCount++;
        const ph = dbType === 'mysql' ? '?' : `$${paramCount}`;
        updates.push(`parent_work_order_id = ${ph}`);
        params.push(parent_work_order_id);
      }
      
      // Merge work order details into metadata (do not wipe existing metadata)
      const shouldUpdateWorkOrderDetails =
        metadata !== undefined ||
        problem_description !== undefined ||
        bike_condition_review !== undefined ||
        job_category !== undefined ||
        previous_job_number !== undefined;

      if (shouldUpdateWorkOrderDetails) {
        const existingMetaRaw = existing.metadata;
        const existingMeta = safeParseJson(existingMetaRaw) || existingMetaRaw || {};
        const base = (existingMeta && typeof existingMeta === 'object') ? { ...existingMeta } : {};
        const incoming = (metadata && typeof metadata === 'object') ? metadata : {};

        // Shallow merge top-level
        const merged = { ...base, ...incoming };

        // Deep-merge work_order_details
        const baseWod = (base.work_order_details && typeof base.work_order_details === 'object') ? base.work_order_details : {};
        const incWod = (incoming.work_order_details && typeof incoming.work_order_details === 'object') ? incoming.work_order_details : {};
        merged.work_order_details = { ...baseWod, ...incWod };

        if (problem_description !== undefined) {
          const val = problem_description ? String(problem_description) : null;
          merged.work_order_details.problem_description = val;
          if (!merged.work_order_details.complaint) merged.work_order_details.complaint = val;
        }
        if (bike_condition_review !== undefined) {
          merged.work_order_details.bike_condition_review = bike_condition_review ? String(bike_condition_review) : null;
        }
        if (job_category !== undefined) {
          merged.work_order_details.job_category = job_category ? String(job_category) : null;
        }
        if (previous_job_number !== undefined) {
          merged.work_order_details.previous_job_number = previous_job_number ? String(previous_job_number) : null;
        }

        paramCount++;
        const ph = dbType === 'mysql' ? '?' : `$${paramCount}`;
        updates.push(`metadata = ${ph}`);
        params.push(dbType === 'mysql' ? JSON.stringify(merged) : merged);
      }

      if (updates.length === 0) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'No fields to update'
          }
        });
      }
      
      if (dbType === 'mysql') {
        updates.push(`updated_at = NOW()`);
        params.push(jobCardId);
        
        await db.query(
          `UPDATE job_cards SET ${updates.join(', ')} WHERE id = ?`,
          params
        );
        
        const result = await db.query(
          'SELECT id, status, updated_at FROM job_cards WHERE id = ?',
          [jobCardId]
        );
        
        if (result.rows.length === 0) {
          return res.status(404).json({
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'Job card not found'
            }
          });
        }

        // Create audit log
        await db.query(
          `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
           VALUES (?, 'jobcard.updated', 'job_card', ?, ?)`,
          [req.user.id, jobCardId, JSON.stringify(req.body)]
        );

        res.json(result.rows[0]);
      } else {
        updates.push(`updated_at = now()`);
        paramCount++;
        params.push(jobCardId);

        const result = await db.query(
          `UPDATE job_cards SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING id, status, updated_at`,
          params
        );

        if (result.rows.length === 0) {
          return res.status(404).json({
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'Job card not found'
            }
          });
        }

        // Create audit log
        await db.query(
          `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
           VALUES ($1, 'jobcard.updated', 'job_card', $2, $3)`,
          [req.user.id, jobCardId, JSON.stringify(req.body)]
        );

        res.json(result.rows[0]);
      }
    } catch (error) {
      logger.error('Update job card error:', error);
      next(error);
    }
  }
);

module.exports = router;

