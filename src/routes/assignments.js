const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate } = require('../middleware/auth');

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

// GET /api/v1/assignments
router.get('/', async (req, res, next) => {
  try {
    let { technician_id, job_card_id, status, business_unit_id } = req.query;

    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$';
    
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
    
    // Check if asset management tables exist
    const assetsTableExists = await tableExists('assets');
    const locationsTableExists = await tableExists('locations');
    
    // Use technician_id from query if provided, otherwise check if user is a technician
    let effectiveTechnicianId = technician_id;
    
    // If no technician_id provided, check if logged-in user is a technician and auto-filter
    if (!technician_id) {
      try {
        const dbTypeCheck = process.env.DB_TYPE || 'postgresql';
        const roleCheckPlaceholder = dbTypeCheck === 'mysql' ? '?' : '$1';
        
        // Get user's role to determine if they're a technician
        const roleResult = await db.query(
          `SELECT r.name as role_name FROM roles r 
           JOIN users u ON r.id = u.role_id 
           WHERE u.id = ${roleCheckPlaceholder}`,
          [req.user.id]
        );
        
        const userRole = roleResult.rows.length > 0 ? roleResult.rows[0].role_name : null;
        
        // If user is a technician, auto-filter by their ID
        if (userRole && (userRole === 'Technician' || userRole.toLowerCase() === 'technician')) {
          // Verify they have a technician profile
          const techCheck = await db.query(
            `SELECT user_id FROM technicians WHERE user_id = ${roleCheckPlaceholder}`,
            [req.user.id]
          );
          
          if (techCheck.rows.length > 0) {
            effectiveTechnicianId = req.user.id;
          }
        }
      } catch (error) {
        // If role check fails, just use technician_id from query (if provided)
        logger.warn('Error checking user role for auto-filter:', error);
      }
    }
    
    let queryText;
    // Build SELECT fields conditionally based on table existence
    let selectFields = `a.id, a.job_card_id, a.technician_id, a.status, 
               a.assigned_at, a.started_at, a.completed_at,
               a.notes,
               jc.job_number, jc.customer_name, jc.work_type, jc.priority,
               jc.vehicle_info, jc.metadata,
               (SELECT tlA.id FROM time_logs tlA
                 WHERE tlA.assignment_id = a.id AND tlA.technician_id = a.technician_id AND tlA.status = 'active'
                 ORDER BY tlA.id DESC LIMIT 1) as active_time_log_id,
               (SELECT tl2.id FROM time_logs tl2 
                 WHERE tl2.assignment_id = a.id AND tl2.technician_id = a.technician_id AND tl2.status = 'paused'
                 ORDER BY tl2.id DESC LIMIT 1) as paused_time_log_id`;
    
    let joinClauses = `FROM assignments a
        JOIN job_cards jc ON a.job_card_id = jc.id
        JOIN technicians t ON a.technician_id = t.user_id
        JOIN users u ON t.user_id = u.id
        LEFT JOIN users u2 ON a.assigned_by = u2.id`;
    
    // Add asset management fields if tables exist
    if (assetsTableExists && locationsTableExists) {
      selectFields += `, jc.job_type, jc.estimated_hours, jc.asset_id, jc.location_id,
               asset.name as asset_name, asset.asset_tag, asset.serial_number as asset_serial_number,
               loc.name as location_name`;
      joinClauses += `
        LEFT JOIN assets asset ON jc.asset_id = asset.id
        LEFT JOIN locations loc ON jc.location_id = loc.id`;
    }
    
    selectFields += `,
               u.display_name as technician_name, t.employee_code,
               u2.display_name as assigned_by_name`;
    
    if (dbType === 'mysql') {
      // For MySQL, calculate duration on the fly if duration_seconds is 0 or NULL
      queryText = `
        SELECT ${selectFields},
               COALESCE(SUM(
                 CASE 
                   WHEN tl.status IN ('finished', 'paused') THEN 
                     CASE 
                       WHEN tl.duration_seconds > 0 THEN tl.duration_seconds
                       WHEN tl.end_ts IS NOT NULL THEN TIMESTAMPDIFF(SECOND, tl.start_ts, tl.end_ts)
                       ELSE 0
                     END
                   ELSE 0
                 END
               ), 0) as total_time_seconds
        ${joinClauses}
        LEFT JOIN time_logs tl ON a.id = tl.assignment_id
        WHERE 1=1
      `;
    } else {
      // For PostgreSQL, use duration_seconds directly
      queryText = `
        SELECT ${selectFields},
               COALESCE(SUM(CASE WHEN tl.status IN ('finished', 'paused') THEN tl.duration_seconds ELSE 0 END), 0) as total_time_seconds
        ${joinClauses}
        LEFT JOIN time_logs tl ON a.id = tl.assignment_id
        WHERE 1=1
      `;
    }
    const params = [];
    let paramCount = 0;
    
    if (effectiveTechnicianId) {
      paramCount++;
      queryText += ` AND a.technician_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(effectiveTechnicianId);
    }

    if (job_card_id) {
      paramCount++;
      queryText += ` AND a.job_card_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(job_card_id);
    }

    if (status) {
      paramCount++;
      queryText += ` AND a.status = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
      params.push(status);
    }
    
    // Add business_unit_id filter if provided (CRITICAL for multi-tenant security)
    // Filter through job_cards business_unit_id
    if (business_unit_id) {
      try {
        // Check if business_unit_id column exists in job_cards table
        const buColumnCheck = await db.query(
          dbType === 'mysql' 
            ? `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_cards' AND COLUMN_NAME = 'business_unit_id'`
            : `SELECT column_name FROM information_schema.columns WHERE table_name = 'job_cards' AND column_name = 'business_unit_id'`
        );
        
        if (buColumnCheck.rows.length > 0) {
          paramCount++;
          queryText += ` AND jc.business_unit_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
          params.push(business_unit_id);
        }
      } catch (error) {
        logger.warn('Error checking business_unit_id column:', error);
      }
    }

    // Build GROUP BY clause conditionally
    let groupByFields = 'a.id, a.job_card_id, a.technician_id, a.status, a.assigned_at, a.started_at, a.completed_at, jc.job_number, jc.customer_name, jc.work_type, jc.priority, u.display_name, t.employee_code, u2.display_name';
    if (assetsTableExists && locationsTableExists) {
      groupByFields += ', jc.job_type, jc.estimated_hours, jc.asset_id, jc.location_id, asset.name, asset.asset_tag, asset.serial_number, loc.name';
    }
    queryText += ` GROUP BY ${groupByFields}`;
    queryText += ' ORDER BY a.assigned_at DESC';

    const result = await db.query(queryText, params);
    
    // Format time for each assignment
    result.rows.forEach(assignment => {
      const totalSeconds = assignment.total_time_seconds ? parseInt(assignment.total_time_seconds) : 0;
      if (totalSeconds > 0) {
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        assignment.total_time_formatted = hours > 0 
          ? `${hours}h ${minutes}m` 
          : `${minutes}m`;
        assignment.total_time_hours = (totalSeconds / 3600).toFixed(2);
      } else {
        assignment.total_time_formatted = '0m';
        assignment.total_time_hours = '0.00';
      }
    });

    res.json({
      data: result.rows || []
    });
  } catch (error) {
    logger.error('Get assignments error:', error);
    logger.error('Error stack:', error.stack);
    // Pass error to error handler middleware instead of silently returning empty
    next(error);
  }
});

// POST /api/v1/assignments
router.post('/',
  [
    body('job_card_id').isInt(),
    body('technician_id').isUUID()
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

      const { job_card_id, technician_id, notes } = req.body;

      // Verify job card exists (and enforce workflow: must be estimated before assignment)
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$1';
      const jobCardResult = await db.query(
        `SELECT id, estimated_hours FROM job_cards WHERE id = ${placeholder}`,
        [job_card_id]
      );

      if (jobCardResult.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: 'Job card not found'
          }
        });
      }

      const estimated = parseFloat(jobCardResult.rows[0].estimated_hours || 0) || 0;
      if (!(estimated > 0)) {
        return res.status(409).json({
          error: {
            code: 'MISSING_ESTIMATE',
            message: 'Supervisor estimate (estimated hours) is required before assigning a technician.'
          }
        });
      }

      // Verify technician exists
      const techResult = await db.query(
        `SELECT user_id FROM technicians WHERE user_id = ${placeholder}`,
        [technician_id]
      );

      if (techResult.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: 'Technician not found'
          }
        });
      }

      // Check for existing active assignment
      const placeholder2 = dbType === 'mysql' ? '?' : '$2';
      const existingResult = await db.query(
        `SELECT id FROM assignments 
         WHERE job_card_id = ${placeholder} AND technician_id = ${placeholder2} 
         AND status IN ('assigned', 'in_progress')`,
        [job_card_id, technician_id]
      );

      if (existingResult.rows.length > 0) {
        return res.status(409).json({
          error: {
            code: 'RESOURCE_CONFLICT',
            message: 'Assignment already exists'
          }
        });
      }
      let assignment;
      
      if (dbType === 'mysql') {
        await db.query(
          `INSERT INTO assignments (job_card_id, technician_id, assigned_by, notes)
           VALUES (?, ?, ?, ?)`,
          [job_card_id, technician_id, req.user.id, notes]
        );
        
        // Fetch the inserted record
        const result = await db.query(
          'SELECT id, job_card_id, technician_id, status, assigned_at FROM assignments WHERE job_card_id = ? AND technician_id = ? ORDER BY id DESC LIMIT 1',
          [job_card_id, technician_id]
        );
        assignment = result.rows[0];
      } else {
        const result = await db.query(
          `INSERT INTO assignments (job_card_id, technician_id, assigned_by, notes)
           VALUES ($1, $2, $3, $4)
           RETURNING id, job_card_id, technician_id, status, assigned_at`,
          [job_card_id, technician_id, req.user.id, notes]
        );
        assignment = result.rows[0];
      }

      // Create audit log
      await db.query(
        `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
         VALUES ($1, 'assignment.created', 'assignment', $2, $3)`,
        [req.user.id, assignment.id, JSON.stringify({ job_card_id, technician_id })]
      );

      // TODO: Emit WebSocket event
      // io.emit('assignment.created', assignment);

      res.status(201).json(assignment);
    } catch (error) {
      logger.error('Create assignment error:', error);
      next(error);
    }
  }
);

// PATCH /api/v1/assignments/:id
router.patch('/:id',
  [
    body('status').optional().isIn(['assigned', 'in_progress', 'completed', 'cancelled'])
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

      const assignmentId = req.params.id;
      const { technician_id, status, notes } = req.body;

      const dbType = process.env.DB_TYPE || 'postgresql';
      const updates = [];
      const params = [];
      let paramCount = 0;
      let isReassigning = false;
      let currentTechnicianId = null;

      // First, check if we're reassigning (technician_id is being changed)
      if (technician_id) {
        const checkPlaceholder = dbType === 'mysql' ? '?' : '$1';
        
        // Get current assignment to check if technician is changing
        const currentAssignment = await db.query(
          `SELECT technician_id, status FROM assignments WHERE id = ${checkPlaceholder}`,
          [assignmentId]
        );
        
        if (currentAssignment.rows.length > 0) {
          currentTechnicianId = String(currentAssignment.rows[0].technician_id).trim();
          const newTechnicianId = String(technician_id).trim();
          isReassigning = currentTechnicianId !== newTechnicianId;
          
          logger.info(`🔍 Reassignment check: currentTech="${currentTechnicianId}", newTech="${newTechnicianId}", isReassigning=${isReassigning}`);
        }
        
        // Add technician_id update
        paramCount++;
        if (dbType === 'mysql') {
          updates.push(`technician_id = ?`);
        } else {
          updates.push(`technician_id = $${paramCount}`);
        }
        params.push(technician_id);
      }

      // If reassigning, ALWAYS force status to 'assigned' and clear timestamps
      if (isReassigning) {
        logger.info(`✅ REASSIGNING DETECTED - Forcing status to 'assigned'`);
        
        // Remove ANY existing status update from the array
        const statusIndex = updates.findIndex(u => u.trim().startsWith('status ='));
        if (statusIndex !== -1) {
          updates.splice(statusIndex, 1);
          // Remove corresponding param
          let paramIndex = 0;
          for (let i = 0; i < statusIndex; i++) {
            if (updates[i].includes('?') || updates[i].includes('$')) paramIndex++;
          }
          if (paramIndex < params.length) {
            params.splice(paramIndex, 1);
            paramCount--;
          }
        }
        
        // FORCE status to 'assigned' - this is non-negotiable when reassigning
        paramCount++;
        if (dbType === 'mysql') {
          updates.push(`status = ?`);
        } else {
          updates.push(`status = $${paramCount}`);
        }
        params.push('assigned');
        updates.push(`started_at = NULL`);
        updates.push(`completed_at = NULL`);
        
        logger.info(`✅ FORCED status='assigned' for reassignment. Updates: ${updates.join(', ')}`);
      } else if (status && !technician_id) {
        // Only handle status update if NOT reassigning
        // Enforce workflow + data discipline (no skipping steps)
        const checkPlaceholder = dbType === 'mysql' ? '?' : '$1';
        const aInfo = await db.query(
          dbType === 'mysql'
            ? `SELECT a.status as assignment_status, a.job_card_id, a.technician_id, jc.estimated_hours
               FROM assignments a
               JOIN job_cards jc ON a.job_card_id = jc.id
               WHERE a.id = ?`
            : `SELECT a.status as assignment_status, a.job_card_id, a.technician_id, jc.estimated_hours
               FROM assignments a
               JOIN job_cards jc ON a.job_card_id = jc.id
               WHERE a.id = $1`,
          [assignmentId]
        );
        if (!aInfo.rows || aInfo.rows.length === 0) {
          return res.status(404).json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Assignment not found' } });
        }
        const currentStatus = aInfo.rows[0].assignment_status;
        const jobCardIdForCheck = aInfo.rows[0].job_card_id;
        const estimate = parseFloat(aInfo.rows[0].estimated_hours || 0) || 0;

        // Estimate required before work starts or completes
        if ((status === 'in_progress' || status === 'completed') && !(estimate > 0)) {
          return res.status(409).json({
            error: {
              code: 'MISSING_ESTIMATE',
              message: 'Estimated hours are required before starting or completing work. Please add supervisor estimate first.'
            }
          });
        }

        // No skipping: cannot complete from assigned
        if (status === 'completed' && currentStatus === 'assigned') {
          return res.status(409).json({
            error: {
              code: 'INVALID_WORKFLOW_STATE',
              message: 'Cannot complete an assignment that was never started. Start work first.'
            }
          });
        }

        // Data discipline: cannot complete without at least one time log segment
        if (status === 'completed') {
          const tlPh = dbType === 'mysql' ? '?' : '$';
          const tlRes = await db.query(
            dbType === 'mysql'
              ? `SELECT COUNT(*) as cnt
                 FROM time_logs
                 WHERE assignment_id = ? AND status IN ('finished','paused') AND (duration_seconds > 0 OR end_ts IS NOT NULL)`
              : `SELECT COUNT(*)::int as cnt
                 FROM time_logs
                 WHERE assignment_id = $1 AND status IN ('finished','paused') AND (duration_seconds > 0 OR end_ts IS NOT NULL)`,
            [assignmentId]
          );
          const cnt = parseInt(tlRes.rows?.[0]?.cnt || 0, 10) || 0;
          if (cnt <= 0) {
            return res.status(409).json({
              error: {
                code: 'MISSING_TIME_LOGS',
                message: 'Cannot complete an assignment without time logs. Start/stop the timer to record work.'
              }
            });
          }
        }

        paramCount++;
        const dbTypeForStatus = process.env.DB_TYPE || 'postgresql';
        if (dbTypeForStatus === 'mysql') {
          updates.push(`status = ?`);
        } else {
          updates.push(`status = $${paramCount}`);
        }
        params.push(status);

        if (status === 'in_progress') {
          if (dbTypeForStatus === 'mysql') {
            updates.push(`started_at = NOW()`);
          } else {
            updates.push(`started_at = now()`);
          }
        } else if (status === 'completed') {
          if (dbTypeForStatus === 'mysql') {
            updates.push(`completed_at = NOW()`);
          } else {
            updates.push(`completed_at = now()`);
          }
        } else if (status === 'assigned') {
          updates.push(`started_at = NULL`);
          updates.push(`completed_at = NULL`);
        }
      }

      if (notes !== undefined) {
        paramCount++;
        const dbTypeForNotes = process.env.DB_TYPE || 'postgresql';
        if (dbTypeForNotes === 'mysql') {
          updates.push(`notes = ?`);
        } else {
          updates.push(`notes = $${paramCount}`);
        }
        params.push(notes);
      }

      if (updates.length === 0) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'No fields to update'
          }
        });
      }
      
      // Verify new technician exists and check for conflicts (only if reassigning)
      if (technician_id && isReassigning) {
        const placeholder = dbType === 'mysql' ? '?' : '$1';
        const newTechResult = await db.query(
          `SELECT user_id FROM technicians WHERE user_id = ${placeholder}`,
          [technician_id]
        );

        if (newTechResult.rows.length === 0) {
          return res.status(404).json({
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'New technician not found'
            }
          });
        }

        // Get job_card_id for conflict check
        const jobCardResult = await db.query(
          `SELECT job_card_id FROM assignments WHERE id = ${placeholder}`,
          [assignmentId]
        );

        if (jobCardResult.rows.length > 0) {
          const jobCardId = jobCardResult.rows[0].job_card_id;
          const placeholder2 = dbType === 'mysql' ? '?' : '$2';
          const conflictCheck = await db.query(
            `SELECT id FROM assignments 
             WHERE job_card_id = ${placeholder} AND technician_id = ${placeholder2} 
             AND status IN ('assigned', 'in_progress') AND id != ${dbType === 'mysql' ? '?' : '$3'}`,
            dbType === 'mysql' ? [jobCardId, technician_id, assignmentId] : [jobCardId, technician_id, assignmentId]
          );

          if (conflictCheck.rows.length > 0) {
            return res.status(409).json({
              error: {
                code: 'RESOURCE_CONFLICT',
                message: 'Technician already has an active assignment for this job card'
              }
            });
          }
        }
      }
      
      if (updates.length === 0) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'No fields to update'
          }
        });
      }

      // Add updated_at
      if (dbType === 'mysql') {
        updates.push(`updated_at = NOW()`);
      } else {
        updates.push(`updated_at = now()`);
      }
      
      logger.info(`🔧 Updating assignment ${assignmentId}`);
      logger.info(`📝 Updates: ${updates.join(', ')}`);
      logger.info(`📊 Params before adding ID: ${JSON.stringify(params)}`);
      
      let result;
      
      if (dbType === 'mysql') {
        // Build MySQL query - all params use ?
        // Add assignmentId to params for WHERE clause
        params.push(assignmentId);
        const mysqlQuery = `UPDATE assignments SET ${updates.join(', ')} WHERE id = ?`;
        logger.info(`💾 Executing: ${mysqlQuery}`);
        logger.info(`📦 Final params: ${JSON.stringify(params)}`);
        
        const updateResult = await db.query(mysqlQuery, params);
        logger.info(`✅ Update executed. Affected rows: ${updateResult.affectedRows || 'N/A'}`);
        
        // Get updated record - VERIFY the status was actually updated
        const selectResult = await db.query(
          'SELECT * FROM assignments WHERE id = ?',
          [assignmentId]
        );
        
        if (selectResult.rows.length > 0) {
          const updatedAssignment = selectResult.rows[0];
          logger.info(`✅ Assignment after update: id=${updatedAssignment.id}, status="${updatedAssignment.status}", technician_id="${updatedAssignment.technician_id}"`);
          
          // CRITICAL: If reassigning and status is NOT 'assigned', force it directly
          if (isReassigning && updatedAssignment.status !== 'assigned') {
            logger.error(`❌ STATUS NOT UPDATED CORRECTLY! Expected 'assigned', got '${updatedAssignment.status}'. Forcing direct update...`);
            await db.query(
              'UPDATE assignments SET status = ?, started_at = NULL, completed_at = NULL WHERE id = ?',
              ['assigned', assignmentId]
            );
            // Re-fetch to verify
            const verifyResult = await db.query('SELECT * FROM assignments WHERE id = ?', [assignmentId]);
            if (verifyResult.rows.length > 0) {
              logger.info(`✅ FORCED UPDATE: status is now "${verifyResult.rows[0].status}"`);
              selectResult.rows[0] = verifyResult.rows[0];
            }
          }
        } else {
          logger.error(`❌ Assignment ${assignmentId} not found after update!`);
        }
        
        result = { rows: selectResult.rows };
      } else {
        // PostgreSQL - use $N placeholders
        const resultQuery = `UPDATE assignments SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;
        logger.info(`💾 Executing: ${resultQuery}`);
        logger.info(`📦 Params: ${JSON.stringify(params)}`);
        
        result = await db.query(resultQuery, params);
        
        if (result.rows.length > 0) {
          const updatedAssignment = result.rows[0];
          logger.info(`✅ Assignment after update: id=${updatedAssignment.id}, status="${updatedAssignment.status}", technician_id="${updatedAssignment.technician_id}"`);
          
          // CRITICAL: If reassigning and status is NOT 'assigned', force it directly
          if (isReassigning && updatedAssignment.status !== 'assigned') {
            logger.error(`❌ STATUS NOT UPDATED CORRECTLY! Expected 'assigned', got '${updatedAssignment.status}'. Forcing direct update...`);
            const forceResult = await db.query(
              `UPDATE assignments SET status = 'assigned', started_at = NULL, completed_at = NULL WHERE id = $1 RETURNING *`,
              [assignmentId]
            );
            if (forceResult.rows.length > 0) {
              logger.info(`✅ FORCED UPDATE: status is now "${forceResult.rows[0].status}"`);
              result.rows[0] = forceResult.rows[0];
            }
          }
        } else {
          logger.error(`❌ Assignment ${assignmentId} not found after update!`);
        }
      }

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: 'Assignment not found'
          }
        });
      }

      // Update job card status based on assignment status changes
      // This runs for ALL assignment updates, including reassignments
      if (result.rows.length > 0) {
        const assignment = result.rows[0];
        const jobCardId = assignment.job_card_id;
        const assignmentStatus = assignment.status; // Get the actual updated status
        const jobCardPlaceholder = dbType === 'mysql' ? '?' : '$1';
        
        // Check all assignments for this job card
        const allAssignmentsResult = await db.query(
          `SELECT COUNT(*) as total, 
                  SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count,
                  SUM(CASE WHEN status IN ('assigned', 'in_progress') THEN 1 ELSE 0 END) as active_count
           FROM assignments 
           WHERE job_card_id = ${jobCardPlaceholder} AND status != 'cancelled'`,
          [jobCardId]
        );
        
        const totalAssignments = parseInt(allAssignmentsResult.rows[0].total || 0);
        const completedAssignments = parseInt(allAssignmentsResult.rows[0].completed_count || 0);
        const activeAssignments = parseInt(allAssignmentsResult.rows[0].active_count || 0);
        
        // Get current job card status
        const jobCardStatusResult = await db.query(
          `SELECT status FROM job_cards WHERE id = ${jobCardPlaceholder}`,
          [jobCardId]
        );
        
        if (jobCardStatusResult.rows.length > 0) {
          const currentJobCardStatus = jobCardStatusResult.rows[0].status;
          
          // If assignment was set to completed, check if all are completed
          if (assignmentStatus === 'completed' && totalAssignments > 0 && totalAssignments === completedAssignments) {
            // All assignments completed - set job card to completed
            await db.query(
              `UPDATE job_cards SET status = 'completed', completed_at = ${dbType === 'mysql' ? 'NOW()' : 'now()'} 
               WHERE id = ${jobCardPlaceholder}`,
              [jobCardId]
            );
          } 
          // If we have active assignments (assigned or in_progress), job card should be in_progress
          else if (activeAssignments > 0) {
            // If job card is completed but we have active assignments (reassignment happened)
            if (currentJobCardStatus === 'completed') {
              await db.query(
                `UPDATE job_cards SET status = 'in_progress', completed_at = NULL 
                 WHERE id = ${jobCardPlaceholder}`,
                [jobCardId]
              );
            }
            // If job card is open but we have active assignments
            else if (currentJobCardStatus === 'open') {
              await db.query(
                `UPDATE job_cards SET status = 'in_progress' 
                 WHERE id = ${jobCardPlaceholder}`,
                [jobCardId]
              );
            }
          }
          // If at least one assignment is completed but no active assignments, and job card is open
          else if (completedAssignments > 0 && activeAssignments === 0 && currentJobCardStatus === 'open') {
            await db.query(
              `UPDATE job_cards SET status = 'in_progress' 
               WHERE id = ${jobCardPlaceholder}`,
              [jobCardId]
            );
          }
        }
      }

      // Create audit log
      const auditPlaceholder = dbType === 'mysql' ? '?' : '$1';
      await db.query(
        `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
         VALUES (${auditPlaceholder}, 'assignment.updated', 'assignment', ${dbType === 'mysql' ? '?' : '$2'}, ${dbType === 'mysql' ? '?' : '$3'})`,
        [req.user.id, assignmentId, JSON.stringify(req.body)]
      );

      // FINAL VERIFICATION: Ensure status is 'assigned' if reassigning
      const finalAssignment = result.rows[0];
      if (isReassigning && finalAssignment.status !== 'assigned') {
        logger.error(`🚨 CRITICAL: Final assignment status is "${finalAssignment.status}" but should be "assigned"!`);
        // Force it one more time
        finalAssignment.status = 'assigned';
        finalAssignment.started_at = null;
        finalAssignment.completed_at = null;
        logger.info(`🔧 Overriding response to force status='assigned'`);
      }
      
      logger.info(`📤 Returning assignment: id=${finalAssignment.id}, status="${finalAssignment.status}", technician_id="${finalAssignment.technician_id}"`);
      res.json(finalAssignment);
    } catch (error) {
      logger.error('Update assignment error:', error);
      next(error);
    }
  }
);

// DELETE /api/v1/assignments/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const assignmentId = req.params.id;

      const dbType = process.env.DB_TYPE || 'postgresql';
      let result;
      
      if (dbType === 'mysql') {
        await db.query(
          'UPDATE assignments SET status = ? WHERE id = ?',
          ['cancelled', assignmentId]
        );
        result = await db.query(
          'SELECT id FROM assignments WHERE id = ?',
          [assignmentId]
        );
      } else {
        result = await db.query(
          'UPDATE assignments SET status = $1 WHERE id = $2 RETURNING id',
          ['cancelled', assignmentId]
        );
      }

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'Assignment not found'
        }
      });
    }

    // Create audit log
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES ($1, 'assignment.cancelled', 'assignment', $2, $3)`,
      [req.user.id, assignmentId, JSON.stringify({ cancelled: true })]
    );

    res.json({
      message: 'Assignment cancelled successfully'
    });
  } catch (error) {
    logger.error('Delete assignment error:', error);
    next(error);
  }
});

module.exports = router;

