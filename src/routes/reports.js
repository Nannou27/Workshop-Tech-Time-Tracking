const express = require('express');
const { query, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate } = require('../middleware/auth');
const { isFieldVisible } = require('../utils/fieldVisibility');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// GET /api/v1/reports/jobcard-times
router.get('/jobcard-times',
  [
    query('from').isISO8601().toDate(),
    query('to').isISO8601().toDate(),
    query('format').optional().isIn(['json', 'csv', 'pdf'])
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

      const { from, to, technician_id, job_card_id, format = 'json' } = req.query;
      const dbType = process.env.DB_TYPE || 'postgresql';

      let queryText = `
        SELECT 
          ${dbType === 'mysql' ? 'DATE(tl.start_ts)' : 'DATE(tl.start_ts)'} as date,
          jc.id as job_card_id,
          jc.job_number,
          jc.customer_name,
          jc.work_type,
          jc.status as job_card_status,
          jc.priority,
          jc.estimated_hours,
          u.id as technician_id,
          u.display_name as technician_name,
          t.employee_code,
          tl.start_ts as start_time,
          tl.end_ts as end_time,
          tl.duration_seconds / 3600.0 as duration_hours,
          tl.duration_seconds,
          tl.notes,
          tl.status as time_log_status
        FROM time_logs tl
        JOIN job_cards jc ON tl.job_card_id = jc.id
        JOIN technicians t ON tl.technician_id = t.user_id
        JOIN users u ON t.user_id = u.id
        WHERE tl.status = 'finished'
          AND tl.start_ts >= ${dbType === 'mysql' ? '?' : '$1'}
          AND tl.start_ts <= ${dbType === 'mysql' ? '?' : '$2'}
      `;
      const params = [fromDate.toISOString(), toDate.toISOString()];
      let paramCount = 2;

      if (technician_id) {
        paramCount++;
        queryText += ` AND tl.technician_id = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`;
        params.push(technician_id);
      }

      if (job_card_id) {
        paramCount++;
        queryText += ` AND tl.job_card_id = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`;
        params.push(job_card_id);
      }

      queryText += ' ORDER BY tl.start_ts DESC';

      const result = await db.query(queryText, params);

      // Calculate summary
      const summary = {
        total_hours: result.rows.reduce((sum, row) => sum + parseFloat(row.duration_hours || 0), 0),
        total_job_cards: new Set(result.rows.map(row => row.job_number)).size,
        average_hours_per_job: 0
      };
      summary.average_hours_per_job = summary.total_job_cards > 0 
        ? summary.total_hours / summary.total_job_cards 
        : 0;

      const reportData = {
        report: {
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
          generated_at: new Date().toISOString()
        },
        data: result.rows,
        summary
      };

      if (format === 'json') {
        res.json(reportData);
      } else if (format === 'csv') {
        // TODO: Generate CSV
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="jobcard-times-${from}-${to}.csv"`);
        // Simple CSV generation
        const csv = [
          'Date,Job Card Number,Technician,Start Time,End Time,Duration (Hours),Notes,Status',
          ...result.rows.map(row => 
            `${row.date},${row.job_number},${row.technician_name},${row.start_time},${row.end_time},${row.duration_hours},${row.notes || ''},${row.status}`
          ).join('\n')
        ].join('\n');
        res.send(csv);
      } else if (format === 'pdf') {
        // TODO: Generate PDF
        res.status(501).json({
          error: {
            code: 'NOT_IMPLEMENTED',
            message: 'PDF export not yet implemented'
          }
        });
      }
    } catch (error) {
      logger.error('Generate report error:', error);
      next(error);
    }
  }
);

// GET /api/v1/reports/comprehensive
router.get('/comprehensive', async (req, res, next) => {
  try {
    // business_unit_id is OPTIONAL - do not require it
    let { from, to, technician_id, period = 'day', business_unit_id } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'from and to dates are required'
        }
      });
    }

    const dbType = process.env.DB_TYPE || 'postgresql';
    
    // Check if required tables/columns exist for schema tolerance
    const hasJobCardsBU = await columnExists('job_cards', 'business_unit_id');
    const hasTechnicians = await tableExists('technicians');
    const hasEstimatedHours = await columnExists('job_cards', 'estimated_hours');
    const hasActualHours = await columnExists('job_cards', 'actual_hours');
    
    // RESOLVE business_unit_id: OPTIONAL - no 400 if missing
    // Priority: query param > user profile > null (no filter)
    const resolvedBU = 
      req.query.business_unit_id ?? 
      req.user?.businessUnitId ?? 
      null;
    
    let enforcedBusinessUnitId = resolvedBU;
    if (resolvedBU) {
      business_unit_id = resolvedBU;
    }
    // If resolvedBU is null: proceed without BU filter (no error, no 400)
    
    function normalizeDateOnly(value) {
      if (!value) return null;
      // Accept DD/MM/YYYY or MM/DD/YYYY defensively (infer by which component can be a month)
      if (typeof value === 'string' && value.includes('/') && value.split('/').length === 3) {
        const [a, b, yyyy] = value.split('/').map(s => parseInt(s, 10));
        if (yyyy && a && b) {
          // If second part > 12, it's MM/DD; if first part > 12, it's DD/MM; otherwise default to MM/DD (matches most browser locale date strings)
          const isMMDD = b > 12 || (a <= 12 && b <= 12);
          const mm = isMMDD ? a : b;
          const dd = isMMDD ? b : a;
          if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
            return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
          }
        }
      }
      if (typeof value === 'string' && value.includes('T')) return value.slice(0, 10);
      return String(value).slice(0, 10); // assume YYYY-MM-DD
    }

    const fromDay = normalizeDateOnly(from);
    const toDay = normalizeDateOnly(to);

    // MySQL compares DATETIME best with "YYYY-MM-DD HH:MM:SS" (no timezone suffix).
    // Postgres can safely compare ISO strings.
    const fromParam = dbType === 'mysql'
      ? `${fromDay} 00:00:00`
      : new Date(`${fromDay}T00:00:00.000Z`).toISOString();
    const toParam = dbType === 'mysql'
      ? `${toDay} 23:59:59`
      : new Date(`${toDay}T23:59:59.999Z`).toISOString();

    // For display in report metadata
    const fromDate = new Date(`${fromDay}T00:00:00.000Z`);
    const toDate = new Date(`${toDay}T23:59:59.999Z`);
    
    // Date source: use time_logs.end_ts for completed work (single source of truth)
    const completedDateField = 'tl.end_ts';
    const createdDateField = 'jc.created_at'; // For incomplete jobs only

    // Build date grouping based on period
    const buildDateGrouping = (fieldExpr) => {
      if (period === 'day') {
        return `DATE(${fieldExpr})`;
      }
      if (period === 'week') {
        return dbType === 'mysql'
          ? `YEARWEEK(${fieldExpr})`
          : `DATE_TRUNC('week', ${fieldExpr})`;
      }
      if (period === 'month') {
        return dbType === 'mysql'
          ? `DATE_FORMAT(${fieldExpr}, "%Y-%m")`
          : `DATE_TRUNC('month', ${fieldExpr})`;
      }
      return `DATE(${fieldExpr})`;
    };

    const dateGroupingCompleted = buildDateGrouping(completedDateField);
    const dateGroupingCreated = buildDateGrouping(createdDateField);

    // Treat a job card as completed if either:
    // - job_cards.status = 'completed' (legacy behavior), OR
    // - an assignment for that job card is marked completed (current workflow)
    const completedByAssignmentExpr = dbType === 'mysql'
      ? `EXISTS (SELECT 1 FROM assignments ax WHERE ax.job_card_id = jc.id AND ax.status = 'completed' LIMIT 1)`
      : `EXISTS (SELECT 1 FROM assignments ax WHERE ax.job_card_id = jc.id AND ax.status = 'completed')`;

    // Get completed job cards with time details (date filtered by time_logs.end_ts)
    // Use database-specific aggregation function with schema tolerance
    const technicianAggExpr = hasTechnicians
      ? (dbType === 'mysql'
        ? `GROUP_CONCAT(DISTINCT CONCAT(u.display_name, ' (', COALESCE(t.employee_code, 'N/A'), ')') SEPARATOR ', ')`
        : `STRING_AGG(DISTINCT CONCAT(u.display_name, ' (', COALESCE(t.employee_code, 'N/A'), ')'), ', ')`)
      : (dbType === 'mysql'
        ? `GROUP_CONCAT(DISTINCT u.display_name SEPARATOR ', ')`
        : `STRING_AGG(DISTINCT u.display_name, ', ')`);
    
    // Schema-tolerant column selections
    const estimatedHoursSelect = hasEstimatedHours ? 'jc.estimated_hours' : 'NULL as estimated_hours';
    const actualHoursSelect = hasActualHours ? 'jc.actual_hours' : 'NULL as actual_hours';
    const technicianJoin = hasTechnicians 
      ? 'LEFT JOIN technicians t ON COALESCE(a.technician_id, tl.technician_id) = t.user_id'
      : '';
    const userJoin = hasTechnicians
      ? 'LEFT JOIN users u ON t.user_id = u.id'
      : 'LEFT JOIN users u ON COALESCE(a.technician_id, tl.technician_id) = u.id';
    
    const params = [fromParam, toParam];
    let paramCount = 2;
    
    // Build business unit filter if applicable
    let buFilterCompleted = '';
    if (enforcedBusinessUnitId && hasJobCardsBU) {
      if (dbType === 'mysql') {
        buFilterCompleted = ` AND jc.business_unit_id = ?`;
        params.push(enforcedBusinessUnitId);
      } else {
        paramCount++;
        buFilterCompleted = ` AND jc.business_unit_id = $${paramCount}`;
        params.push(enforcedBusinessUnitId);
      }
    }
    
    let completedQuery = `
      SELECT 
        ${dateGroupingCompleted} as period,
        jc.id as job_card_id,
        jc.job_number,
        jc.customer_name,
        jc.work_type,
        jc.status as job_card_status,
        jc.priority,
        ${estimatedHoursSelect},
        ${actualHoursSelect},
        ${technicianAggExpr} as technicians,
        SUM(CASE WHEN tl.status = 'finished' THEN tl.duration_seconds ELSE 0 END) / 3600.0 as total_hours,
        COUNT(DISTINCT CASE WHEN tl.status = 'finished' THEN tl.id END) as time_log_count
      FROM job_cards jc
      LEFT JOIN assignments a ON jc.id = a.job_card_id AND a.status != 'cancelled'
      LEFT JOIN time_logs tl ON jc.id = tl.job_card_id AND tl.status = 'finished'
      ${technicianJoin}
      ${userJoin}
      WHERE (COALESCE(jc.status, '') = 'completed' OR ${completedByAssignmentExpr})
        AND tl.id IS NOT NULL
        AND DATE(tl.end_ts) >= ${dbType === 'mysql' ? '?' : '$1'}
        AND DATE(tl.end_ts) <= ${dbType === 'mysql' ? '?' : '$2'}${buFilterCompleted}
    `;

    if (technician_id) {
      if (dbType === 'mysql') {
        completedQuery += ` AND (a.technician_id = ? OR tl.technician_id = ?)`;
        params.push(technician_id, technician_id);
      } else {
        paramCount++;
        completedQuery += ` AND (a.technician_id = $${paramCount} OR tl.technician_id = $${paramCount})`;
        params.push(technician_id);
      }
    }

    // Schema-tolerant GROUP BY
    const groupByColumns = `${dateGroupingCompleted}, jc.id, jc.job_number, jc.customer_name, jc.work_type, jc.status, jc.priority${hasEstimatedHours ? ', jc.estimated_hours' : ''}${hasActualHours ? ', jc.actual_hours' : ''}`;
    
    completedQuery += `
      GROUP BY ${groupByColumns}
      ORDER BY period DESC, jc.job_number DESC
    `;

    const completedResult = await db.query(completedQuery, params);

    // Get incomplete job cards
    const incompleteParams = [fromParam, toParam];
    let incompleteParamCount = 2;
    
    // Build business unit filter for incomplete query
    let buFilterIncomplete = '';
    if (enforcedBusinessUnitId && hasJobCardsBU) {
      if (dbType === 'mysql') {
        buFilterIncomplete = ` AND jc.business_unit_id = ?`;
        incompleteParams.push(enforcedBusinessUnitId);
      } else {
        incompleteParamCount++;
        buFilterIncomplete = ` AND jc.business_unit_id = $${incompleteParamCount}`;
        incompleteParams.push(enforcedBusinessUnitId);
      }
    }
    
    // Schema-tolerant incomplete query (same pattern as completed query)
    const incompleteAggExpr = hasTechnicians
      ? (dbType === 'mysql'
        ? `GROUP_CONCAT(DISTINCT CONCAT(u.display_name, ' (', COALESCE(t.employee_code, 'N/A'), ')') SEPARATOR ', ')`
        : `STRING_AGG(DISTINCT CONCAT(u.display_name, ' (', COALESCE(t.employee_code, 'N/A'), ')'), ', ')`)
      : (dbType === 'mysql'
        ? `GROUP_CONCAT(DISTINCT u.display_name SEPARATOR ', ')`
        : `STRING_AGG(DISTINCT u.display_name, ', ')`);
    
    let incompleteQuery;
    if (dbType === 'mysql') {
      incompleteQuery = `
        SELECT 
          ${dateGroupingCreated} as period,
          jc.id as job_card_id,
          jc.job_number,
          jc.customer_name,
          jc.work_type,
          jc.status as job_card_status,
          jc.priority,
          ${estimatedHoursSelect},
          ${actualHoursSelect},
          ${incompleteAggExpr} as technicians,
          COALESCE(SUM(CASE WHEN tl.status IN ('finished','paused') THEN tl.duration_seconds ELSE 0 END), 0) / 3600.0 as total_hours,
          COUNT(DISTINCT CASE WHEN tl.status IN ('finished','paused') THEN tl.id END) as time_log_count
        FROM job_cards jc
        LEFT JOIN assignments a ON jc.id = a.job_card_id AND a.status != 'cancelled'
        LEFT JOIN time_logs tl ON jc.id = tl.job_card_id
        ${technicianJoin}
        ${userJoin}
        WHERE COALESCE(jc.status, 'open') != 'cancelled'
          AND NOT (COALESCE(jc.status, '') = 'completed' OR ${completedByAssignmentExpr})
          AND ${createdDateField} >= ?
          AND ${createdDateField} <= ?${buFilterIncomplete}
      `;
    } else {
      incompleteQuery = `
        SELECT 
          ${dateGroupingCreated} as period,
          jc.id as job_card_id,
          jc.job_number,
          jc.customer_name,
          jc.work_type,
          jc.status as job_card_status,
          jc.priority,
          ${estimatedHoursSelect},
          ${actualHoursSelect},
          ${incompleteAggExpr} as technicians,
          COALESCE(SUM(CASE WHEN tl.status IN ('finished','paused') THEN tl.duration_seconds ELSE 0 END), 0) / 3600.0 as total_hours,
          COUNT(DISTINCT CASE WHEN tl.status IN ('finished','paused') THEN tl.id END) as time_log_count
        FROM job_cards jc
        LEFT JOIN assignments a ON jc.id = a.job_card_id AND a.status != 'cancelled'
        LEFT JOIN time_logs tl ON jc.id = tl.job_card_id
        ${technicianJoin}
        ${userJoin}
        WHERE COALESCE(jc.status, 'open') != 'cancelled'
          AND NOT (COALESCE(jc.status, '') = 'completed' OR ${completedByAssignmentExpr})
          AND ${createdDateField} >= $1
          AND ${createdDateField} <= $2${buFilterIncomplete}
      `;
    }

    if (technician_id) {
      if (dbType === 'mysql') {
        incompleteQuery += ` AND (a.technician_id = ? OR tl.technician_id = ?)`;
        incompleteParams.push(technician_id, technician_id);
      } else {
        incompleteParamCount++;
        incompleteQuery += ` AND (a.technician_id = $${incompleteParamCount} OR tl.technician_id = $${incompleteParamCount})`;
        incompleteParams.push(technician_id);
      }
    }

    // Schema-tolerant GROUP BY for incomplete query
    const incompleteGroupByColumns = `${dateGroupingCreated}, jc.id, jc.job_number, jc.customer_name, jc.work_type, jc.status, jc.priority${hasEstimatedHours ? ', jc.estimated_hours' : ''}${hasActualHours ? ', jc.actual_hours' : ''}`;
    
    incompleteQuery += `
      GROUP BY ${incompleteGroupByColumns}
      ORDER BY period DESC, jc.job_number DESC
    `;

    const incompleteResult = await db.query(incompleteQuery, incompleteParams);

    // Technician breakdown: completed by completion date; incomplete by created date
    const techParams = [fromParam, toParam, fromParam, toParam];
    let techParamCount = 4;
    const p = (n) => (dbType === 'mysql' ? '?' : `$${n}`);
    
    // Build business unit filter for tech breakdown
    let buFilterTech = '';
    if (enforcedBusinessUnitId && hasJobCardsBU) {
      techParams.push(enforcedBusinessUnitId);
      techParamCount++;
      buFilterTech = ` AND jc.business_unit_id = ${p(techParamCount)}`;
    }

    // IMPORTANT: Avoid double-counting estimated hours due to time_logs join.
    // We aggregate time logs per (job_card_id, technician_id) first, then join that aggregate.
    // Schema-tolerant: only run technician breakdown if technicians table exists
    let techBreakdownResult = { rows: [] };
    
    if (hasTechnicians) {
      const employeeCodeSelect = 't.employee_code';
      const estimatedHoursExpr = hasEstimatedHours ? 'jc.estimated_hours' : '0';
      
      let techBreakdownQuery = `
        SELECT 
          t.user_id as technician_id,
          u.display_name as technician_name,
          ${employeeCodeSelect},
          COUNT(DISTINCT CASE WHEN (COALESCE(jc.status, '') = 'completed' OR ${completedByAssignmentExpr}) THEN jc.id END) as completed_count,
          COUNT(DISTINCT CASE WHEN (COALESCE(jc.status, 'open') != 'cancelled' AND NOT (COALESCE(jc.status, '') = 'completed' OR ${completedByAssignmentExpr})) THEN jc.id END) as incomplete_count,
          COALESCE(SUM(CASE WHEN (COALESCE(jc.status, '') = 'completed' OR ${completedByAssignmentExpr}) THEN COALESCE(tl_agg.total_seconds, 0) ELSE 0 END), 0) / 3600.0 as total_hours,
          COALESCE(SUM(CASE WHEN (COALESCE(jc.status, '') = 'completed' OR ${completedByAssignmentExpr}) THEN COALESCE(${estimatedHoursExpr}, 0) ELSE 0 END), 0) as estimated_hours_completed,
          COALESCE(SUM(CASE WHEN (COALESCE(jc.status, 'open') != 'cancelled' AND NOT (COALESCE(jc.status, '') = 'completed' OR ${completedByAssignmentExpr})) THEN COALESCE(${estimatedHoursExpr}, 0) ELSE 0 END), 0) as estimated_hours_incomplete,
          COALESCE(SUM(CASE WHEN COALESCE(jc.status, 'open') != 'cancelled' THEN COALESCE(${estimatedHoursExpr}, 0) ELSE 0 END), 0) as estimated_hours_total
        FROM assignments a
        JOIN job_cards jc ON a.job_card_id = jc.id
        JOIN technicians t ON a.technician_id = t.user_id
        JOIN users u ON t.user_id = u.id
        LEFT JOIN (
          SELECT
            tl.job_card_id,
            tl.technician_id,
            SUM(CASE WHEN tl.status IN ('finished','paused') THEN tl.duration_seconds ELSE 0 END) as total_seconds
          FROM time_logs tl
          GROUP BY tl.job_card_id, tl.technician_id
        ) tl_agg ON tl_agg.job_card_id = jc.id AND tl_agg.technician_id = t.user_id
        WHERE a.status != 'cancelled'${buFilterTech}
          AND (
            ((COALESCE(jc.status, '') = 'completed' OR ${completedByAssignmentExpr}) AND ${completedDateField} >= ${p(1)} AND ${completedDateField} <= ${p(2)})
            OR
            (COALESCE(jc.status, 'open') != 'cancelled' AND NOT (COALESCE(jc.status, '') = 'completed' OR ${completedByAssignmentExpr}) AND ${createdDateField} >= ${p(3)} AND ${createdDateField} <= ${p(4)})
          )
      `;
      
      if (technician_id) {
        techParams.push(technician_id);
        techParamCount++;
        techBreakdownQuery += ` AND t.user_id = ${p(techParamCount)}`;
      }
      
      techBreakdownQuery += `
        GROUP BY t.user_id, u.display_name, t.employee_code
        ORDER BY u.display_name
      `;
      
      techBreakdownResult = await db.query(techBreakdownQuery, techParams);
    } else {
      logger.warn('Technicians table does not exist - skipping technician breakdown');
    }

    // Calculate summary statistics
    const completed = completedResult.rows;
    const incomplete = incompleteResult.rows;
    
    // Ensure total_hours is a number for each technician
    const byTechnician = techBreakdownResult.rows.map(tech => {
      const totalHours = parseFloat(tech.total_hours || 0);
      const estTotal = parseFloat(tech.estimated_hours_total || 0);
      const efficiencyPct = estTotal > 0 ? parseFloat(((totalHours / estTotal) * 100).toFixed(2)) : null;
      return ({
      ...tech,
        total_hours: totalHours,
      completed_count: parseInt(tech.completed_count || 0),
        incomplete_count: parseInt(tech.incomplete_count || 0),
        estimated_hours_completed: parseFloat(tech.estimated_hours_completed || 0),
        estimated_hours_incomplete: parseFloat(tech.estimated_hours_incomplete || 0),
        estimated_hours_total: estTotal,
        efficiency_percent: efficiencyPct
      });
    });
    
    // Calculate summary with safe field handling (cross-BU compatible)
    const totalCompleted = completed.length;
    const totalIncomplete = incomplete.length;
    
    // Safely sum hours - handle null/undefined values
    const totalHours = completed.reduce((sum, row) => {
      const hours = parseFloat(row.total_hours || row.actual_hours || 0);
      return sum + (isNaN(hours) ? 0 : hours);
    }, 0);
    
    // Safely sum estimated hours - only include if field exists
    const totalEstimated = [...completed, ...incomplete].reduce((sum, row) => {
      const hours = parseFloat(row.estimated_hours || 0);
      return sum + (isNaN(hours) ? 0 : hours);
    }, 0);
    
    const totalActual = completed.reduce((sum, row) => {
      const hours = parseFloat(row.total_hours || row.actual_hours || 0);
      return sum + (isNaN(hours) ? 0 : hours);
    }, 0);

    // Calculate efficiency safely - handle division by zero and missing fields
    let efficiency = 0;
    if (totalEstimated > 0 && totalActual > 0) {
      efficiency = parseFloat(((totalActual / totalEstimated) * 100).toFixed(2));
    } else if (totalCompleted > 0 && totalActual > 0) {
      // Fallback: calculate based on average if estimated hours not available
      const avgActual = totalActual / totalCompleted;
      efficiency = avgActual > 0 ? 100 : 0; // Simplified efficiency metric
    }

    // Filter out fields that might not be visible for all BUs
    // This ensures cross-BU comparisons don't break
    const sanitizeJobCard = (jc) => {
      const sanitized = {
        job_card_id: jc.job_card_id,
        job_number: jc.job_number,
        customer_name: jc.customer_name,
        status: jc.job_card_status,
        priority: jc.priority,
        total_hours: parseFloat(jc.total_hours || jc.actual_hours || 0),
        time_log_count: parseInt(jc.time_log_count || 0)
      };
      
      // Only include optional fields if they exist and are not null
      if (jc.work_type) sanitized.work_type = jc.work_type;
      if (jc.estimated_hours) sanitized.estimated_hours = parseFloat(jc.estimated_hours);
      if (jc.actual_hours) sanitized.actual_hours = parseFloat(jc.actual_hours);
      if (jc.technicians) sanitized.technicians = jc.technicians;
      if (jc.period) sanitized.period = jc.period;
      
      return sanitized;
    };

    res.json({
      report: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        period,
        generated_at: new Date().toISOString(),
        note: 'Cross-BU compatible: Fields may vary based on Business Unit configurations'
      },
      summary: {
        total_completed: totalCompleted,
        total_incomplete: totalIncomplete,
        total_job_cards: totalCompleted + totalIncomplete,
        total_hours: parseFloat(totalHours.toFixed(2)),
        total_estimated_hours: totalEstimated > 0 ? parseFloat(totalEstimated.toFixed(2)) : null,
        total_actual_hours: parseFloat(totalActual.toFixed(2)),
        efficiency: efficiency,
        efficiency_note: totalEstimated === 0 ? 'Efficiency calculated based on completed jobs only (estimated hours not available for all BUs)' : null
      },
      by_technician: byTechnician,
      completed_job_cards: completed.map(sanitizeJobCard),
      incomplete_job_cards: incomplete.map(sanitizeJobCard)
    });
  } catch (error) {
    logger.error('Comprehensive report error:', error);
    next(error);
  }
});

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

// Helper function to check if column exists (schema-tolerant reports)
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
    return dbType === 'mysql' ? result.rows.length > 0 : !!result.rows[0]?.exists;
  } catch (error) {
    return false;
  }
}

// GET /api/v1/reports/asset-utilization
router.get('/asset-utilization',
  [
    query('start_date').optional().isISO8601(),
    query('end_date').optional().isISO8601(),
    query('asset_id').optional().isInt(),
    query('location_id').optional().isInt(),
    query('business_unit_id').optional().isInt(),
    query('status').optional().isIn(['active', 'in_maintenance', 'disposed', 'retired'])
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

      let { start_date, end_date, asset_id, location_id, business_unit_id, status } = req.query;
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$';
      
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

      // Check if assets table exists
      const assetsTableExists = await tableExists('assets');
      if (!assetsTableExists) {
        return res.json({ data: [], summary: { total_assets: 0, total_work_orders: 0, total_hours: 0 } });
      }

      let queryText = `
        SELECT 
          a.id, a.name, a.asset_tag, a.serial_number, a.status,
          bu.name as business_unit_name,
          l.name as location_name,
          COUNT(DISTINCT jc.id) as total_work_orders,
          COUNT(DISTINCT CASE WHEN jc.status = 'completed' THEN jc.id END) as completed_work_orders,
          COALESCE(SUM(CASE WHEN tl.status = 'finished' THEN tl.duration_seconds ELSE 0 END), 0) / 3600.0 as total_hours_used,
          COALESCE(SUM(CASE WHEN jc.status = 'completed' THEN jc.estimated_hours ELSE 0 END), 0) as total_estimated_hours
        FROM assets a
        LEFT JOIN business_units bu ON a.business_unit_id = bu.id
        LEFT JOIN locations l ON a.location_id = l.id
        LEFT JOIN job_cards jc ON a.id = jc.asset_id
        LEFT JOIN time_logs tl ON jc.id = tl.job_card_id
        WHERE 1=1
      `;
      const params = [];
      let paramCount = 0;

      if (asset_id) {
        paramCount++;
        queryText += ` AND a.id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(asset_id);
      }

      if (location_id) {
        paramCount++;
        queryText += ` AND a.location_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(location_id);
      }

      if (business_unit_id) {
        paramCount++;
        queryText += ` AND a.business_unit_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(business_unit_id);
      }

      if (status) {
        paramCount++;
        queryText += ` AND a.status = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(status);
      }

      if (start_date) {
        paramCount++;
        queryText += ` AND jc.created_at >= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(start_date);
      }

      if (end_date) {
        paramCount++;
        queryText += ` AND jc.created_at <= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(end_date);
      }

      queryText += `
        GROUP BY a.id, a.name, a.asset_tag, a.serial_number, a.status, bu.name, l.name
        ORDER BY total_hours_used DESC
      `;

      const result = await db.query(queryText, params);

      // Calculate summary
      const summary = {
        total_assets: result.rows.length,
        total_work_orders: result.rows.reduce((sum, row) => sum + parseInt(row.total_work_orders || 0), 0),
        total_hours: result.rows.reduce((sum, row) => sum + parseFloat(row.total_hours_used || 0), 0),
        completed_work_orders: result.rows.reduce((sum, row) => sum + parseInt(row.completed_work_orders || 0), 0)
      };

      res.json({
        data: result.rows,
        summary
      });
    } catch (error) {
      logger.error('Asset utilization report error:', error);
      next(error);
    }
  }
);

// GET /api/v1/reports/parts-consumption
router.get('/parts-consumption',
  [
    query('start_date').optional().isISO8601(),
    query('end_date').optional().isISO8601(),
    query('part_id').optional().isInt(),
    query('asset_id').optional().isInt(),
    query('location_id').optional().isInt(),
    query('business_unit_id').optional().isInt()
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

      let { start_date, end_date, part_id, asset_id, location_id, business_unit_id } = req.query;
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$';
      
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

      // Check if work_order_parts table exists
      const partsTableExists = await tableExists('work_order_parts');
      if (!partsTableExists) {
        return res.json({ data: [], summary: { total_parts_used: 0, total_cost: 0 } });
      }

      // Schema compatibility for work_order_parts columns
      const hasWopInstalledAt = await columnExists('work_order_parts', 'installed_at');
      const hasWopCreatedAt = await columnExists('work_order_parts', 'created_at');
      const hasWopQuantity = await columnExists('work_order_parts', 'quantity');
      const hasWopUnitCost = await columnExists('work_order_parts', 'unit_cost');
      const hasWopTotalCost = await columnExists('work_order_parts', 'total_cost');

      // Use DATE() filtering to avoid "end date at midnight" excluding same-day usage.
      const dateField = hasWopInstalledAt ? 'wop.installed_at' : (hasWopCreatedAt ? 'wop.created_at' : null);
      const wopDateExpr = dateField ? `DATE(${dateField})` : null;

      const startDay = start_date ? String(start_date).slice(0, 10) : null; // YYYY-MM-DD
      const endDay = end_date ? String(end_date).slice(0, 10) : null;

      // Total cost expression: prefer stored/generated total_cost; fallback to quantity*unit_cost
      const totalCostExpr = hasWopTotalCost
        ? 'COALESCE(wop.total_cost, 0)'
        : (hasWopQuantity && hasWopUnitCost ? 'COALESCE(wop.quantity, 0) * COALESCE(wop.unit_cost, 0)' : '0');

      const qtyExpr = hasWopQuantity ? 'COALESCE(wop.quantity, 0)' : '0';
      const unitCostExpr = hasWopUnitCost ? 'wop.unit_cost' : 'NULL';

      let queryText = `
        SELECT 
          p.id, p.name, p.part_number, p.serial_number,
          p.metadata,
          a.name as parent_asset_name, a.asset_tag,
          l.name as location_name,
          SUM(${qtyExpr}) as total_quantity_used,
          AVG(${unitCostExpr}) as avg_unit_cost,
          SUM(${totalCostExpr}) as total_cost,
          COUNT(DISTINCT wop.work_order_id) as work_orders_count
        FROM work_order_parts wop
        JOIN parts p ON wop.part_id = p.id
        LEFT JOIN assets a ON p.parent_asset_id = a.id
        LEFT JOIN locations l ON p.location_id = l.id
        LEFT JOIN job_cards jc ON wop.work_order_id = jc.id
        WHERE 1=1
      `;
      const params = [];
      let paramCount = 0;

      if (part_id) {
        paramCount++;
        queryText += ` AND p.id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(part_id);
      }

      if (asset_id) {
        paramCount++;
        queryText += ` AND p.parent_asset_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(asset_id);
      }

      if (location_id) {
        paramCount++;
        queryText += ` AND p.location_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(location_id);
      }

      if (start_date) {
        if (wopDateExpr) {
        paramCount++;
          queryText += ` AND ${wopDateExpr} >= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
          params.push(startDay);
        }
      }

      if (end_date) {
        if (wopDateExpr) {
        paramCount++;
          queryText += ` AND ${wopDateExpr} <= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
          params.push(endDay);
        }
      }
      
      // Add business_unit_id filter if provided (CRITICAL for multi-tenant security)
      if (business_unit_id) {
        try {
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

      queryText += `
        GROUP BY p.id, p.name, p.part_number, p.serial_number, p.metadata, a.name, a.asset_tag, l.name
        ORDER BY total_quantity_used DESC
      `;

      const result = await db.query(queryText, params);

      // Calculate summary
      const summary = {
        total_parts_used: result.rows.length,
        total_quantity: result.rows.reduce((sum, row) => sum + parseInt(row.total_quantity_used || 0), 0),
        total_cost: result.rows.reduce((sum, row) => sum + parseFloat(row.total_cost || 0), 0),
        work_orders_count: result.rows.reduce((sum, row) => sum + parseInt(row.work_orders_count || 0), 0)
      };

      res.json({
        data: result.rows,
        summary
      });
    } catch (error) {
      logger.error('Parts consumption report error:', error);
      next(error);
    }
  }
);

// GET /api/v1/reports/technician-performance
router.get('/technician-performance',
  [
    query('start_date').optional().isISO8601(),
    query('end_date').optional().isISO8601(),
    query('location_id').optional().isInt(),
    query('technician_id').optional().isUUID(),
    query('business_unit_id').optional().isInt()
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

      let { start_date, end_date, location_id, technician_id, business_unit_id } = req.query;
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$';

      // Schema compatibility checks
      const hasTechnicians = await tableExists('technicians');
      const hasBusinessUnits = await tableExists('business_units');
      const hasLocations = await tableExists('locations');
      const hasUserLocationId = await columnExists('users', 'location_id');
      const hasUserBusinessUnitId = await columnExists('users', 'business_unit_id');
      const hasJobCardsBU = await columnExists('job_cards', 'business_unit_id');
      const hasLocationsBU = hasLocations ? await columnExists('locations', 'business_unit_id') : false;
      
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

      // Date-only filtering to avoid end-date midnight issue
      const startDay = start_date ? String(start_date).slice(0, 10) : null; // YYYY-MM-DD
      const endDay = end_date ? String(end_date).slice(0, 10) : null;

      // IMPORTANT:
      // - Start from all Technician users (so "All Locations" can still show everyone)
      // - Put date/location scoping INSIDE the LEFT JOIN on job_cards/locations so we don't drop technicians
      // - When "All Locations" is selected, return separate rows per location (instead of collapsing to "Multiple Locations")
      const params = [];
      const addParam = (v) => {
        params.push(v);
        return dbType === 'mysql' ? '?' : `$${params.length}`;
      };
      const activeCondition = dbType === 'mysql' ? 'u.is_active = 1' : 'u.is_active = true';

      const buId = business_unit_id ? parseInt(business_unit_id, 10) : null;
      const hasBU = Number.isFinite(buId);

      let jcJoinExtra = '';
      if (hasBU && hasJobCardsBU) {
        jcJoinExtra += ` AND jc.business_unit_id = ${addParam(buId)}`;
      }
      if (location_id) {
        const locId = parseInt(location_id, 10);
        if (Number.isFinite(locId)) {
          jcJoinExtra += ` AND jc.location_id = ${addParam(locId)}`;
        }
      }
      // Date filtering: removed from jcJoinExtra (will be applied to time_logs instead)

      // Location and BU joins removed (not needed without location grouping)

      // Time logs date filter (single source of truth: end_ts for finished work)
      let tlDateFilter = '';
      if (startDay && endDay) {
        tlDateFilter = ` AND tl.status = 'finished' AND DATE(tl.end_ts) >= ${addParam(startDay)} AND DATE(tl.end_ts) <= ${addParam(endDay)}`;
      } else if (startDay) {
        tlDateFilter = ` AND tl.status = 'finished' AND DATE(tl.end_ts) >= ${addParam(startDay)}`;
      } else if (endDay) {
        tlDateFilter = ` AND tl.status = 'finished' AND DATE(tl.end_ts) <= ${addParam(endDay)}`;
      } else {
        tlDateFilter = ` AND tl.status = 'finished'`;
      }

      let queryText = `
        SELECT 
          u.id as technician_id,
          u.display_name as technician_name,
          ${hasTechnicians ? 't.employee_code' : 'NULL'} as employee_code,
          ${hasBusinessUnits ? 'bu.id' : 'NULL'} as business_unit_id,
          ${hasBusinessUnits ? 'bu.name' : 'NULL'} as business_unit_name,
          COUNT(DISTINCT jc.id) as total_job_cards,
          COUNT(DISTINCT CASE WHEN jc.status = 'completed' THEN jc.id END) as completed_job_cards,
          COALESCE(SUM(CASE WHEN tl.status = 'finished' THEN tl.duration_seconds ELSE 0 END), 0) / 3600.0 as total_hours,
          (
            COALESCE(SUM(CASE WHEN jc.status = 'completed' AND tl.status = 'finished' THEN tl.duration_seconds ELSE 0 END), 0) / 3600.0
          ) / NULLIF(COUNT(DISTINCT CASE WHEN jc.status = 'completed' THEN jc.id END), 0) as avg_hours_per_job,
          COALESCE(SUM(CASE WHEN jc.status = 'completed' THEN jc.estimated_hours ELSE 0 END), 0) as total_estimated_hours
        FROM users u
        JOIN roles r ON u.role_id = r.id AND LOWER(r.name) = 'technician'
        ${hasTechnicians ? 'LEFT JOIN technicians t ON u.id = t.user_id' : ''}
        ${hasUserBusinessUnitId && hasBusinessUnits ? 'LEFT JOIN business_units bu ON u.business_unit_id = bu.id' : ''}
        LEFT JOIN assignments a ON a.technician_id = u.id
        LEFT JOIN job_cards jc ON a.job_card_id = jc.id${jcJoinExtra}
        LEFT JOIN time_logs tl ON tl.assignment_id = a.id AND tl.technician_id = u.id${tlDateFilter}
        WHERE ${activeCondition}
      `;

      if (technician_id) {
        queryText += ` AND u.id = ${addParam(technician_id)}`;
      }

      // Multi-tenant security: scope technicians to BU via users.business_unit_id or job_cards.business_unit_id
      if (hasBU) {
        if (hasUserBusinessUnitId) {
          queryText += ` AND (
            u.business_unit_id = ${addParam(buId)}
            ${hasJobCardsBU ? `OR EXISTS (
              SELECT 1
              FROM assignments a2
              JOIN job_cards jc2 ON a2.job_card_id = jc2.id
              WHERE a2.technician_id = u.id AND jc2.business_unit_id = ${addParam(buId)}
              LIMIT 1
            )` : ''}
          )`;
        } else if (hasJobCardsBU) {
          // No users.business_unit_id; scope via job_cards only
          queryText += ` AND EXISTS (
            SELECT 1
            FROM assignments a2
            JOIN job_cards jc2 ON a2.job_card_id = jc2.id
            WHERE a2.technician_id = u.id AND jc2.business_unit_id = ${addParam(buId)}
            LIMIT 1
          )`;
        }
      }

      // Location filter (if specified, filter jobs by location)
      // Note: location is NOT in GROUP BY, so this filters data, not splits rows
      if (location_id && hasJobCardsBU) {
        const locId = parseInt(location_id, 10);
        if (Number.isFinite(locId)) {
          queryText += ` AND jc.location_id = ${addParam(locId)}`;
        }
      }

      queryText += `
        GROUP BY u.id, u.display_name ${hasTechnicians ? ', t.employee_code' : ''} ${hasBusinessUnits ? ', bu.id, bu.name' : ''}
        ORDER BY total_hours DESC
      `;

      const result = await db.query(queryText, params);

      // Calculate summary
      const summary = {
        total_technicians: result.rows.length,
        total_job_cards: result.rows.reduce((sum, row) => sum + parseInt(row.total_job_cards || 0), 0),
        completed_job_cards: result.rows.reduce((sum, row) => sum + parseInt(row.completed_job_cards || 0), 0),
        total_hours: result.rows.reduce((sum, row) => sum + parseFloat(row.total_hours || 0), 0),
        avg_hours_per_technician: result.rows.length > 0 
          ? result.rows.reduce((sum, row) => sum + parseFloat(row.total_hours || 0), 0) / result.rows.length 
          : 0
      };

      res.json({
        data: result.rows,
        summary
      });
    } catch (error) {
      logger.error('Technician performance report error:', error);
      logger.error('Error details:', { message: error.message, stack: error.stack });
      res.status(500).json({
        error: {
          code: 'REPORT_ERROR',
          message: 'Technician performance report failed: ' + error.message,
          details: error.stack
        }
      });
    }
  }
);

// GET /api/v1/reports/work-order-efficiency
router.get('/work-order-efficiency',
  [
    query('start_date').optional().isISO8601(),
    query('end_date').optional().isISO8601(),
    query('asset_type').optional().trim(),
    query('job_type').optional().trim()
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

      const { start_date, end_date, asset_type, job_type } = req.query;
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$';

      // Check if assets table exists
      const assetsTableExists = await tableExists('assets');
      const hasJobType = await tableExists('job_cards') && 
        (await db.query(`SHOW COLUMNS FROM job_cards LIKE 'job_type'`)).rows.length > 0;

      let queryText = `
        SELECT 
          ${assetsTableExists ? 'a.asset_type,' : "NULL as asset_type,"}
          ${hasJobType ? 'jc.job_type,' : "NULL as job_type,"}
          COUNT(DISTINCT jc.id) as total_job_cards,
          COUNT(DISTINCT CASE WHEN jc.status = 'completed' THEN jc.id END) as completed_job_cards,
          COALESCE(SUM(jc.estimated_hours), 0) as total_estimated_hours,
          COALESCE(SUM(CASE WHEN tl.status = 'finished' THEN tl.duration_seconds ELSE 0 END), 0) / 3600.0 as total_actual_hours,
          COALESCE(AVG(CASE WHEN jc.status = 'completed' THEN jc.estimated_hours END), 0) as avg_estimated_hours,
          COALESCE(AVG(CASE WHEN jc.status = 'completed' AND tl.status = 'finished' THEN tl.duration_seconds / 3600.0 END), 0) as avg_actual_hours
        FROM job_cards jc
        ${assetsTableExists ? 'LEFT JOIN assets a ON jc.asset_id = a.id' : ''}
        LEFT JOIN time_logs tl ON jc.id = tl.job_card_id
        WHERE jc.status = 'completed'
      `;
      const params = [];
      let paramCount = 0;

      if (start_date) {
        paramCount++;
        queryText += ` AND jc.created_at >= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(start_date);
      }

      if (end_date) {
        paramCount++;
        queryText += ` AND jc.created_at <= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(end_date);
      }

      if (asset_type && assetsTableExists) {
        paramCount++;
        queryText += ` AND a.asset_type = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(asset_type);
      }

      if (job_type && hasJobType) {
        paramCount++;
        queryText += ` AND jc.job_type = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(job_type);
      }

      queryText += `
        GROUP BY ${assetsTableExists ? 'a.asset_type,' : ''} ${hasJobType ? 'jc.job_type' : ''}
        ORDER BY total_job_cards DESC
      `;

      const result = await db.query(queryText, params);

      // Calculate efficiency metrics
      const data = result.rows.map(row => {
        const efficiency = row.total_estimated_hours > 0 
          ? (row.total_actual_hours / row.total_estimated_hours) * 100 
          : 0;
        return {
          ...row,
          efficiency: parseFloat(efficiency.toFixed(2))
        };
      });

      // Calculate summary
      const summary = {
        total_job_cards: data.reduce((sum, row) => sum + parseInt(row.total_job_cards || 0), 0),
        completed_job_cards: data.reduce((sum, row) => sum + parseInt(row.completed_job_cards || 0), 0),
        total_estimated_hours: data.reduce((sum, row) => sum + parseFloat(row.total_estimated_hours || 0), 0),
        total_actual_hours: data.reduce((sum, row) => sum + parseFloat(row.total_actual_hours || 0), 0),
        overall_efficiency: data.reduce((sum, row) => sum + parseFloat(row.total_estimated_hours || 0), 0) > 0
          ? (data.reduce((sum, row) => sum + parseFloat(row.total_actual_hours || 0), 0) / 
             data.reduce((sum, row) => sum + parseFloat(row.total_estimated_hours || 0), 0)) * 100
          : 0
      };

      res.json({
        data,
        summary
      });
    } catch (error) {
      logger.error('Work order efficiency report error:', error);
      next(error);
    }
  }
);

// GET /api/v1/reports/location-workload
router.get('/location-workload',
  [
    query('start_date').optional().isISO8601(),
    query('end_date').optional().isISO8601(),
    query('location_id').optional().isInt(),
    query('business_unit_id').optional().isInt()
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

      let { start_date, end_date, location_id, business_unit_id } = req.query;
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$';
      
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

      // Check if locations table exists
      const locationsTableExists = await tableExists('locations');
      if (!locationsTableExists) {
        return res.json({ data: [], summary: { total_locations: 0, total_job_cards: 0 } });
      }

      let queryText = `
        SELECT 
          l.id, l.name, l.address,
          bu.name as business_unit_name,
          COUNT(DISTINCT jc.id) as total_job_cards,
          COUNT(DISTINCT CASE WHEN jc.status = 'completed' THEN jc.id END) as completed_job_cards,
          COUNT(DISTINCT CASE WHEN jc.status = 'in_progress' THEN jc.id END) as in_progress_job_cards,
          COUNT(DISTINCT CASE WHEN jc.status = 'open' THEN jc.id END) as open_job_cards,
          COUNT(DISTINCT a.technician_id) as active_technicians,
          COALESCE(SUM(CASE WHEN tl.status = 'finished' THEN tl.duration_seconds ELSE 0 END), 0) / 3600.0 as total_hours
        FROM locations l
        LEFT JOIN business_units bu ON l.business_unit_id = bu.id
        LEFT JOIN job_cards jc ON l.id = jc.location_id
        LEFT JOIN assignments a ON jc.id = a.job_card_id AND a.status != 'cancelled'
        LEFT JOIN time_logs tl ON jc.id = tl.job_card_id
        WHERE 1=1
      `;
      const params = [];
      let paramCount = 0;

      if (location_id) {
        paramCount++;
        queryText += ` AND l.id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(location_id);
      }

      if (business_unit_id) {
        paramCount++;
        queryText += ` AND l.business_unit_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(business_unit_id);
      }

      if (start_date) {
        paramCount++;
        queryText += ` AND jc.created_at >= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(start_date);
      }

      if (end_date) {
        paramCount++;
        queryText += ` AND jc.created_at <= ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(end_date);
      }

      queryText += `
        GROUP BY l.id, l.name, l.address, bu.name
        ORDER BY total_job_cards DESC
      `;

      const result = await db.query(queryText, params);

      // Calculate summary
      const summary = {
        total_locations: result.rows.length,
        total_job_cards: result.rows.reduce((sum, row) => sum + parseInt(row.total_job_cards || 0), 0),
        completed_job_cards: result.rows.reduce((sum, row) => sum + parseInt(row.completed_job_cards || 0), 0),
        in_progress_job_cards: result.rows.reduce((sum, row) => sum + parseInt(row.in_progress_job_cards || 0), 0),
        total_hours: result.rows.reduce((sum, row) => sum + parseFloat(row.total_hours || 0), 0),
        active_technicians: result.rows.reduce((sum, row) => sum + parseInt(row.active_technicians || 0), 0)
      };

      res.json({
        data: result.rows,
        summary
      });
    } catch (error) {
      logger.error('Location workload report error:', error);
      next(error);
    }
  }
);

// GET /api/v1/reports/assets-inventory
// Super Admin report: View assets across BUs, locations, or ALL
router.get('/assets-inventory',
  [
    query('business_unit_ids').optional(),  // Comma-separated BU IDs or "all"
    query('location_ids').optional(),        // Comma-separated location IDs or "all"
    query('asset_type').optional(),
    query('status').optional(),
    query('include_children').optional().isBoolean()
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

      let { business_unit_ids, location_ids, asset_type, status, include_children } = req.query;
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$';
      
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
          business_unit_ids = String(userBusinessUnitId);
          logger.info(`[SECURITY] Enforcing business unit filter for ${userRole}: BU ${userBusinessUnitId}`);
        }
      }

      let queryText = `
        SELECT 
          a.id,
          a.name,
          a.asset_type,
          a.status,
          a.asset_tag,
          a.serial_number,
          a.cost,
          a.purchase_date,
          a.warranty_expiry,
          a.manufacturer,
          a.model,
          a.year,
          bu.id as business_unit_id,
          bu.name as business_unit_name,
          bu.code as business_unit_code,
          l.id as location_id,
          l.name as location_name,
          l.city as location_city,
          COALESCE(
            (SELECT COUNT(*) FROM parts p WHERE p.parent_asset_id = a.id),
            0
          ) as parts_count,
          COALESCE(
            (SELECT SUM(p.cost) FROM parts p WHERE p.parent_asset_id = a.id),
            0
          ) as parts_total_cost,
          COALESCE(
            (SELECT COUNT(*) FROM job_cards jc WHERE jc.asset_id = a.id),
            0
          ) as total_jobs,
          COALESCE(
            (SELECT COUNT(*) FROM job_cards jc WHERE jc.asset_id = a.id AND jc.status = 'completed'),
            0
          ) as completed_jobs
        FROM assets a
        LEFT JOIN business_units bu ON a.business_unit_id = bu.id
        LEFT JOIN locations l ON a.location_id = l.id
        WHERE 1=1
      `;
      const params = [];
      let paramCount = 0;
      
      // Filter by business unit(s)
      if (business_unit_ids && business_unit_ids !== 'all') {
        const buIds = business_unit_ids.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
        if (buIds.length > 0) {
          paramCount++;
          if (dbType === 'mysql') {
            queryText += ` AND a.business_unit_id IN (${buIds.map(() => '?').join(',')})`;
            params.push(...buIds);
          } else {
            queryText += ` AND a.business_unit_id = ANY($${paramCount})`;
            params.push(buIds);
          }
        }
      }
      
      // Filter by location(s)
      if (location_ids && location_ids !== 'all') {
        const locIds = location_ids.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
        if (locIds.length > 0) {
          paramCount++;
          if (dbType === 'mysql') {
            queryText += ` AND a.location_id IN (${locIds.map(() => '?').join(',')})`;
            params.push(...locIds);
          } else {
            queryText += ` AND a.location_id = ANY($${paramCount})`;
            params.push(locIds);
          }
        }
      }
      
      // Filter by asset type
      if (asset_type) {
        paramCount++;
        queryText += ` AND a.asset_type = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(asset_type);
      }
      
      // Filter by status
      if (status) {
        paramCount++;
        queryText += ` AND a.status = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(status);
      }
      
      queryText += ` ORDER BY bu.name, l.name, a.name`;
      
      const result = await db.query(queryText, params);
      
      // Calculate summary by business unit
      const summaryByBU = {};
      const summaryByLocation = {};
      let totalAssets = 0;
      let totalValue = 0;
      let totalPartsValue = 0;
      
      result.rows.forEach(asset => {
        totalAssets++;
        const assetCost = parseFloat(asset.cost) || 0;
        const partsCost = parseFloat(asset.parts_total_cost) || 0;
        totalValue += assetCost;
        totalPartsValue += partsCost;
        
        // Group by BU
        const buKey = asset.business_unit_id || 'unassigned';
        if (!summaryByBU[buKey]) {
          summaryByBU[buKey] = {
            business_unit_id: asset.business_unit_id,
            business_unit_name: asset.business_unit_name,
            asset_count: 0,
            total_value: 0,
            parts_value: 0,
            total_jobs: 0
          };
        }
        summaryByBU[buKey].asset_count++;
        summaryByBU[buKey].total_value += assetCost;
        summaryByBU[buKey].parts_value += partsCost;
        summaryByBU[buKey].total_jobs += parseInt(asset.total_jobs) || 0;
        
        // Group by Location
        const locKey = asset.location_id || 'unassigned';
        if (!summaryByLocation[locKey]) {
          summaryByLocation[locKey] = {
            location_id: asset.location_id,
            location_name: asset.location_name,
            business_unit_name: asset.business_unit_name,
            asset_count: 0,
            total_value: 0,
            parts_value: 0
          };
        }
        summaryByLocation[locKey].asset_count++;
        summaryByLocation[locKey].total_value += assetCost;
        summaryByLocation[locKey].parts_value += partsCost;
      });

      res.json({
        data: result.rows,
        summary: {
          total_assets: totalAssets,
          total_asset_value: totalValue,
          total_parts_value: totalPartsValue,
          total_combined_value: totalValue + totalPartsValue,
          by_business_unit: Object.values(summaryByBU),
          by_location: Object.values(summaryByLocation)
        }
      });
    } catch (error) {
      logger.error('Assets inventory report error:', error);
      next(error);
    }
  }
);

// GET /api/v1/reports/parts-inventory
// Super Admin report: View parts inventory across BUs, locations, or ALL
router.get('/parts-inventory',
  [
    query('business_unit_ids').optional(),
    query('location_ids').optional(),
    query('status').optional(),
    query('low_stock_only').optional().isBoolean()
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

      let { business_unit_ids, location_ids, status, low_stock_only } = req.query;
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$';
      const lowStockOnly = String(low_stock_only).toLowerCase() === 'true';
      
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
          business_unit_ids = String(userBusinessUnitId);
          logger.info(`[SECURITY] Enforcing business unit filter for ${userRole}: BU ${userBusinessUnitId}`);
        }
      }

      let queryText = `
        SELECT 
          p.id,
          p.name,
          p.part_number,
          p.serial_number,
          p.barcode,
          p.cost,
          p.status,
          p.manufacturer,
          p.metadata,
          a.name as parent_asset_name,
          a.asset_tag as parent_asset_tag,
          a.business_unit_id,
          l.id as location_id,
          l.name as location_name,
          bu.id as business_unit_id,
          bu.name as business_unit_name,
          bu.code as business_unit_code,
          COALESCE(
            (SELECT SUM(wop.quantity) FROM work_order_parts wop WHERE wop.part_id = p.id),
            0
          ) as total_used,
          COALESCE(
            (SELECT SUM(wop.total_cost) FROM work_order_parts wop WHERE wop.part_id = p.id),
            0
          ) as total_cost_used
        FROM parts p
        LEFT JOIN assets a ON p.parent_asset_id = a.id
        LEFT JOIN locations l ON p.location_id = l.id
        LEFT JOIN business_units bu ON l.business_unit_id = bu.id
        WHERE 1=1
      `;
      const params = [];
      let paramCount = 0;
      
      // Filter by business unit(s) - through location
      if (business_unit_ids && business_unit_ids !== 'all') {
        const buIds = business_unit_ids.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
        if (buIds.length > 0) {
          paramCount++;
          if (dbType === 'mysql') {
            queryText += ` AND l.business_unit_id IN (${buIds.map(() => '?').join(',')})`;
            params.push(...buIds);
          } else {
            queryText += ` AND l.business_unit_id = ANY($${paramCount})`;
            params.push(buIds);
          }
        }
      }
      
      // Filter by location(s)
      if (location_ids && location_ids !== 'all') {
        const locIds = location_ids.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
        if (locIds.length > 0) {
          paramCount++;
          if (dbType === 'mysql') {
            queryText += ` AND p.location_id IN (${locIds.map(() => '?').join(',')})`;
            params.push(...locIds);
          } else {
            queryText += ` AND p.location_id = ANY($${paramCount})`;
            params.push(locIds);
          }
        }
      }
      
      // Filter by status
      if (status) {
        paramCount++;
        queryText += ` AND p.status = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`;
        params.push(status);
      }
      
      queryText += ` ORDER BY bu.name, l.name, p.name`;
      
      const result = await db.query(queryText, params);

      // Derive quantity_in_stock from parts.metadata (schema-tolerant) and apply low-stock filter if requested.
      const safeJson = (v) => {
        if (v == null) return null;
        if (typeof v === 'object') return v;
        if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
        return null;
      };
      const getNumber = (v) => {
        const n = (v === '' || v == null) ? NaN : Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const DEFAULT_LOW_STOCK_THRESHOLD = 2; // enterprise-safe default when no reorder point is configured

      let rows = (result.rows || []).map((part) => {
        const meta = safeJson(part.metadata) || {};
        const qty = getNumber(meta.quantity_in_stock);
        const rp = getNumber(meta.reorder_point);
        return {
          ...part,
          quantity_in_stock: qty,
          reorder_point: rp
        };
      });

      if (lowStockOnly) {
        rows = rows.filter((p) => {
          const qty = (p.quantity_in_stock == null) ? null : Number(p.quantity_in_stock);
          const threshold = (p.reorder_point != null) ? Number(p.reorder_point) : DEFAULT_LOW_STOCK_THRESHOLD;
          if (!Number.isFinite(threshold)) return false;
          if (qty == null || !Number.isFinite(qty)) return false;
          return qty <= threshold;
        });
      }
      
      // Calculate summary by business unit
      const summaryByBU = {};
      const summaryByLocation = {};
      let totalParts = 0;
      let totalValue = 0;
      let totalUsed = 0;
      
      rows.forEach(part => {
        totalParts++;
        const partCost = parseFloat(part.cost) || 0;
        const usedCost = parseFloat(part.total_cost_used) || 0;
        totalValue += partCost;
        totalUsed += usedCost;
        
        // Group by BU
        const buKey = part.business_unit_id || 'unassigned';
        if (!summaryByBU[buKey]) {
          summaryByBU[buKey] = {
            business_unit_id: part.business_unit_id,
            business_unit_name: part.business_unit_name,
            parts_count: 0,
            total_value: 0,
            total_used_cost: 0
          };
        }
        summaryByBU[buKey].parts_count++;
        summaryByBU[buKey].total_value += partCost;
        summaryByBU[buKey].total_used_cost += usedCost;
        
        // Group by Location
        const locKey = part.location_id || 'unassigned';
        if (!summaryByLocation[locKey]) {
          summaryByLocation[locKey] = {
            location_id: part.location_id,
            location_name: part.location_name,
            business_unit_name: part.business_unit_name,
            parts_count: 0,
            total_value: 0
          };
        }
        summaryByLocation[locKey].parts_count++;
        summaryByLocation[locKey].total_value += partCost;
      });

      res.json({
        data: rows,
        summary: {
          total_parts: totalParts,
          total_inventory_value: totalValue,
          total_used_value: totalUsed,
          by_business_unit: Object.values(summaryByBU),
          by_location: Object.values(summaryByLocation)
        }
      });
    } catch (error) {
      logger.error('Parts inventory report error:', error);
      next(error);
    }
  }
);

// GET /api/v1/reports/cross-bu-comparison
// Super Admin report: Compare metrics across multiple business units
router.get('/cross-bu-comparison',
  [
    query('business_unit_ids').optional(),
    query('start_date').optional().isISO8601(),
    query('end_date').optional().isISO8601(),
    query('metrics').optional()  // Comma-separated: assets,parts,jobs,revenue,efficiency
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

      let { business_unit_ids, start_date, end_date, metrics } = req.query;
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$';
      
      // Only Super Admin can access this report
      const userCheckPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const userResult = await db.query(
        `SELECT r.name as role_name 
         FROM users u 
         JOIN roles r ON u.role_id = r.id 
         WHERE u.id = ${userCheckPlaceholder}`,
        [req.user.id]
      );
      
      if (userResult.rows.length === 0 || 
          (userResult.rows[0].role_name && userResult.rows[0].role_name.toLowerCase() !== 'super admin')) {
        return res.status(403).json({
          error: {
            code: 'AUTHORIZATION_FAILED',
            message: 'This report is only available to Super Admins'
          }
        });
      }

      // Schema-tolerant: build comparison from subqueries so missing columns/tables don't crash the report.
      const hasBusinessUnits = await tableExists('business_units');
      if (!hasBusinessUnits) {
        return res.status(400).json({
          error: {
            code: 'SCHEMA_MISMATCH',
            message: 'Database schema is missing required table/column for this operation',
            details: 'business_units table is missing'
          }
        });
      }

      const hasLocations = await tableExists('locations');
      const hasAssets = await tableExists('assets');
      const hasParts = await tableExists('parts');
      const hasUsers = await tableExists('users');
      const hasRoles = await tableExists('roles');
      const hasJobCards = await tableExists('job_cards');
      const hasTimeLogs = await tableExists('time_logs');

      const hasUsersBU = hasUsers && await columnExists('users', 'business_unit_id');
      const hasLocationsBU = hasLocations && await columnExists('locations', 'business_unit_id');
      const hasAssetsBU = hasAssets && await columnExists('assets', 'business_unit_id');
      const hasAssetsLoc = hasAssets && await columnExists('assets', 'location_id');
      const hasAssetsCost = hasAssets && await columnExists('assets', 'cost');
      const hasAssetsType = hasAssets && await columnExists('assets', 'asset_type');

      const hasPartsLoc = hasParts && await columnExists('parts', 'location_id');
      const hasPartsCost = hasParts && await columnExists('parts', 'cost');
      const hasPartsParentAsset = hasParts && await columnExists('parts', 'parent_asset_id');

      const hasJobCardsBU = hasJobCards && await columnExists('job_cards', 'business_unit_id');
      const hasJobCardsLoc = hasJobCards && await columnExists('job_cards', 'location_id');
      const hasJobCardsStatus = hasJobCards && await columnExists('job_cards', 'status');
      const hasJobCardsCreatedAt = hasJobCards && await columnExists('job_cards', 'created_at');
      const hasJobCardsEstimated = hasJobCards && await columnExists('job_cards', 'estimated_hours');

      const hasTimeLogStatus = hasTimeLogs && await columnExists('time_logs', 'status');
      const hasTimeLogDuration = hasTimeLogs && await columnExists('time_logs', 'duration_seconds');
      const hasTimeLogStart = hasTimeLogs && await columnExists('time_logs', 'start_ts');
      const hasTimeLogEnd = hasTimeLogs && await columnExists('time_logs', 'end_ts');

      // Filters
      const params = [];
      const p = (val) => {
        params.push(val);
        return dbType === 'mysql' ? '?' : `$${params.length}`;
      };
      
      let buWhere = '';
      if (business_unit_ids && business_unit_ids !== 'all') {
        const buIds = String(business_unit_ids)
          .split(',')
          .map(x => parseInt(x.trim(), 10))
          .filter(x => Number.isFinite(x));
        if (buIds.length > 0) {
          if (dbType === 'mysql') {
            buWhere = `WHERE bu.id IN (${buIds.map(() => '?').join(',')})`;
            params.push(...buIds);
          } else {
            buWhere = `WHERE bu.id = ANY(${p(buIds)})`;
          }
        }
      }

      // Date filters (apply to job/time metrics only)
      const start = start_date ? new Date(start_date) : null;
      const end = end_date ? new Date(end_date) : null;
      if (end) end.setHours(23, 59, 59, 999);
      const startVal = start ? (dbType === 'mysql' ? start.toISOString().slice(0, 19).replace('T', ' ') : start.toISOString()) : null;
      const endVal = end ? (dbType === 'mysql' ? end.toISOString().slice(0, 19).replace('T', ' ') : end.toISOString()) : null;

      // Job cards BU condition
      const jobCardsBuJoin = hasJobCards
        ? (hasJobCardsBU
          ? `jc.business_unit_id = bu.id`
          : (hasJobCardsLoc && hasLocations && hasLocationsBU
            ? `jc.location_id = l_jc.id AND l_jc.business_unit_id = bu.id`
            : `1=0`))
        : `1=0`;

      // Assets BU condition
      const assetsBuJoin = hasAssets
        ? (hasAssetsBU
          ? `a.business_unit_id = bu.id`
          : (hasAssetsLoc && hasLocations && hasLocationsBU
            ? `a.location_id = l_a.id AND l_a.business_unit_id = bu.id`
            : `1=0`))
        : `1=0`;

      // Parts BU condition
      // Prefer parts.location_id -> locations.business_unit_id; fallback to parts.parent_asset_id -> assets BU linkage (if possible)
      const partsBuJoin = hasParts
        ? (hasPartsLoc && hasLocations && hasLocationsBU
          ? `p.location_id = l_p.id AND l_p.business_unit_id = bu.id`
          : (hasPartsParentAsset && hasAssets
            ? `p.parent_asset_id = a_p.id AND (${hasAssetsBU
              ? `a_p.business_unit_id = bu.id`
              : (hasAssetsLoc && hasLocations && hasLocationsBU
                ? `a_p.location_id = l_ap.id AND l_ap.business_unit_id = bu.id`
                : `1=0`)})`
            : `1=0`))
        : `1=0`;

      // IMPORTANT (MySQL): because we embed date clauses in multiple subqueries, we must
      // generate fresh placeholders each time so params count matches the number of "?".
      const jcDateClause = () =>
        (startVal && endVal && hasJobCardsCreatedAt)
          ? ` AND jc.created_at >= ${p(startVal)} AND jc.created_at <= ${p(endVal)}`
          : '';
      const tlDateClause = () =>
        (startVal && endVal && hasTimeLogStart)
          ? ` AND tl.start_ts >= ${p(startVal)} AND tl.start_ts <= ${p(endVal)}`
          : '';

      const tlDurationExpr = hasTimeLogDuration
        ? `COALESCE(tl.duration_seconds, 0)`
        : (hasTimeLogStart && hasTimeLogEnd
          ? (dbType === 'mysql'
            ? `COALESCE(TIMESTAMPDIFF(SECOND, tl.start_ts, tl.end_ts), 0)`
            : `COALESCE(EXTRACT(EPOCH FROM (tl.end_ts - tl.start_ts)), 0)`)
          : `0`);

      const queryText = `
        SELECT 
          bu.id as business_unit_id,
          bu.name as business_unit_name,
          bu.code as business_unit_code,
          
          -- Locations
          ${hasLocations && hasLocationsBU ? `(SELECT COUNT(*) FROM locations l WHERE l.business_unit_id = bu.id)` : `0`} as total_locations,

          -- Users
          ${hasUsersBU ? `(SELECT COUNT(*) FROM users u WHERE u.business_unit_id = bu.id)` : `0`} as total_users,
          ${hasUsersBU && hasRoles ? `(SELECT COUNT(*) FROM users u JOIN roles r ON u.role_id = r.id WHERE u.business_unit_id = bu.id AND r.name LIKE '%Technician%')` : `0`} as technician_count,
          ${hasUsersBU && hasRoles ? `(SELECT COUNT(*) FROM users u JOIN roles r ON u.role_id = r.id WHERE u.business_unit_id = bu.id AND r.name LIKE '%Advisor%')` : `0`} as advisor_count,

          -- Assets
          ${hasAssets ? `(SELECT COUNT(DISTINCT a.id)
                          FROM assets a
                          ${hasAssetsBU ? '' : (hasAssetsLoc && hasLocations && hasLocationsBU ? 'JOIN locations l_a ON a.location_id = l_a.id' : '')}
                          WHERE ${assetsBuJoin})` : `0`} as total_assets,
          ${hasAssets && hasAssetsCost ? `(SELECT COALESCE(SUM(COALESCE(a.cost, 0)), 0)
                          FROM assets a
                          ${hasAssetsBU ? '' : (hasAssetsLoc && hasLocations && hasLocationsBU ? 'JOIN locations l_a ON a.location_id = l_a.id' : '')}
                          WHERE ${assetsBuJoin})` : `0`} as total_asset_value,
          ${hasAssets && hasAssetsType ? `(SELECT COUNT(DISTINCT a.id)
                          FROM assets a
                          ${hasAssetsBU ? '' : (hasAssetsLoc && hasLocations && hasLocationsBU ? 'JOIN locations l_a ON a.location_id = l_a.id' : '')}
                          WHERE ${assetsBuJoin} AND a.asset_type = 'Service Tool')` : `0`} as service_tools_count,
          ${hasAssets && hasAssetsType ? `(SELECT COUNT(DISTINCT a.id)
                          FROM assets a
                          ${hasAssetsBU ? '' : (hasAssetsLoc && hasLocations && hasLocationsBU ? 'JOIN locations l_a ON a.location_id = l_a.id' : '')}
                          WHERE ${assetsBuJoin} AND a.asset_type = 'Vehicle')` : `0`} as vehicles_count,

          -- Parts
          ${hasParts ? `(SELECT COUNT(DISTINCT p.id)
                         FROM parts p
                         ${hasPartsLoc && hasLocations && hasLocationsBU ? 'JOIN locations l_p ON p.location_id = l_p.id' : ''}
                         ${(!hasPartsLoc && hasPartsParentAsset && hasAssets) ? `JOIN assets a_p ON p.parent_asset_id = a_p.id ${hasAssetsBU ? '' : (hasAssetsLoc && hasLocations && hasLocationsBU ? 'JOIN locations l_ap ON a_p.location_id = l_ap.id' : '')}` : ''}
                         WHERE ${partsBuJoin})` : `0`} as total_parts,
          ${hasParts && hasPartsCost ? `(SELECT COALESCE(SUM(COALESCE(p.cost, 0)), 0)
                         FROM parts p
                         ${hasPartsLoc && hasLocations && hasLocationsBU ? 'JOIN locations l_p ON p.location_id = l_p.id' : ''}
                         ${(!hasPartsLoc && hasPartsParentAsset && hasAssets) ? `JOIN assets a_p ON p.parent_asset_id = a_p.id ${hasAssetsBU ? '' : (hasAssetsLoc && hasLocations && hasLocationsBU ? 'JOIN locations l_ap ON a_p.location_id = l_ap.id' : '')}` : ''}
                         WHERE ${partsBuJoin})` : `0`} as total_parts_value,

          -- Jobs
          ${hasJobCards ? `(SELECT COUNT(DISTINCT jc.id)
                            FROM job_cards jc
                            ${hasJobCardsBU ? '' : (hasJobCardsLoc && hasLocations && hasLocationsBU ? 'JOIN locations l_jc ON jc.location_id = l_jc.id' : '')}
                            WHERE ${hasJobCardsBU ? 'jc.business_unit_id = bu.id' : (hasJobCardsLoc && hasLocations && hasLocationsBU ? 'l_jc.business_unit_id = bu.id' : '1=0')}
                            ${jcDateClause()})` : `0`} as total_jobs,
          ${hasJobCards && hasJobCardsStatus ? `(SELECT COUNT(DISTINCT jc.id)
                            FROM job_cards jc
                            ${hasJobCardsBU ? '' : (hasJobCardsLoc && hasLocations && hasLocationsBU ? 'JOIN locations l_jc ON jc.location_id = l_jc.id' : '')}
                            WHERE ${hasJobCardsBU ? 'jc.business_unit_id = bu.id' : (hasJobCardsLoc && hasLocations && hasLocationsBU ? 'l_jc.business_unit_id = bu.id' : '1=0')}
                              AND jc.status = 'completed'
                            ${jcDateClause()})` : `0`} as completed_jobs,
          ${hasJobCards && hasJobCardsStatus ? `(SELECT COUNT(DISTINCT jc.id)
                            FROM job_cards jc
                            ${hasJobCardsBU ? '' : (hasJobCardsLoc && hasLocations && hasLocationsBU ? 'JOIN locations l_jc ON jc.location_id = l_jc.id' : '')}
                            WHERE ${hasJobCardsBU ? 'jc.business_unit_id = bu.id' : (hasJobCardsLoc && hasLocations && hasLocationsBU ? 'l_jc.business_unit_id = bu.id' : '1=0')}
                              AND jc.status = 'in_progress'
                            ${jcDateClause()})` : `0`} as in_progress_jobs,
          ${hasJobCards && hasJobCardsStatus ? `(SELECT COUNT(DISTINCT jc.id)
                            FROM job_cards jc
                            ${hasJobCardsBU ? '' : (hasJobCardsLoc && hasLocations && hasLocationsBU ? 'JOIN locations l_jc ON jc.location_id = l_jc.id' : '')}
                            WHERE ${hasJobCardsBU ? 'jc.business_unit_id = bu.id' : (hasJobCardsLoc && hasLocations && hasLocationsBU ? 'l_jc.business_unit_id = bu.id' : '1=0')}
                              AND jc.status = 'open'
                            ${jcDateClause()})` : `0`} as open_jobs,

          -- Time (hours)
          ${hasTimeLogs && hasJobCards ? `(SELECT COALESCE(SUM(${tlDurationExpr}), 0) / 3600.0
                            FROM time_logs tl
                            JOIN job_cards jc ON tl.job_card_id = jc.id
                            ${hasJobCardsBU ? '' : (hasJobCardsLoc && hasLocations && hasLocationsBU ? 'JOIN locations l_jc ON jc.location_id = l_jc.id' : '')}
                            WHERE ${hasTimeLogStatus ? "tl.status = 'finished'" : '1=1'}
                              AND (${hasJobCardsBU ? 'jc.business_unit_id = bu.id' : (hasJobCardsLoc && hasLocations && hasLocationsBU ? 'l_jc.business_unit_id = bu.id' : '1=0')})
                              ${tlDateClause()})` : `0`} as total_hours,

          ${hasJobCards && hasJobCardsEstimated && hasJobCardsStatus ? `(SELECT COALESCE(SUM(CASE WHEN jc.status = 'completed' THEN COALESCE(jc.estimated_hours, 0) ELSE 0 END), 0)
                            FROM job_cards jc
                            ${hasJobCardsBU ? '' : (hasJobCardsLoc && hasLocations && hasLocationsBU ? 'JOIN locations l_jc ON jc.location_id = l_jc.id' : '')}
                            WHERE ${hasJobCardsBU ? 'jc.business_unit_id = bu.id' : (hasJobCardsLoc && hasLocations && hasLocationsBU ? 'l_jc.business_unit_id = bu.id' : '1=0')}
                            ${jcDateClause()})` : `0`} as total_estimated_hours
          
        FROM business_units bu
        ${buWhere}
        ORDER BY bu.name
      `;
      
      const result = await db.query(queryText, params);
      
      // Calculate overall summary
      const overall = {
        total_business_units: result.rows.length,
        total_assets: result.rows.reduce((sum, row) => sum + parseInt(row.total_assets || 0), 0),
        total_asset_value: result.rows.reduce((sum, row) => sum + parseFloat(row.total_asset_value || 0), 0),
        total_parts: result.rows.reduce((sum, row) => sum + parseInt(row.total_parts || 0), 0),
        total_parts_value: result.rows.reduce((sum, row) => sum + parseFloat(row.total_parts_value || 0), 0),
        total_jobs: result.rows.reduce((sum, row) => sum + parseInt(row.total_jobs || 0), 0),
        completed_jobs: result.rows.reduce((sum, row) => sum + parseInt(row.completed_jobs || 0), 0),
        total_hours: result.rows.reduce((sum, row) => sum + parseFloat(row.total_hours || 0), 0)
      };

      res.json({
        data: result.rows,
        overall_summary: overall
      });
    } catch (error) {
      logger.error('Cross-BU comparison report error:', error);
      next(error);
    }
  }
);

// GET /api/v1/reports/technician-efficiency
// Technician Efficiency & Productivity Report (for BU Admins)
router.get('/technician-efficiency',
  [
    query('business_unit_id').optional().isInt(),
    query('technician_id').optional().isUUID(),
    // UI sends YYYY-MM-DD from <input type="date"> (ISO8601 date). Some locales display DD/MM/YYYY but value is still ISO.
    // Keep validation permissive to avoid false negatives across deployments.
    query('start_date').optional(),
    query('end_date').optional()
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

      let { business_unit_id, technician_id, start_date, end_date } = req.query;
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$';

      function parseDateInput(value, endOfDay = false) {
        if (!value) return null;
        // Accept YYYY-MM-DD or ISO strings; also accept DD/MM/YYYY defensively.
        let d;
        if (typeof value === 'string' && value.includes('/') && value.split('/').length === 3) {
          const [dd, mm, yyyy] = value.split('/').map(s => parseInt(s, 10));
          if (yyyy && mm && dd) d = new Date(Date.UTC(yyyy, mm - 1, dd));
        } else {
          d = new Date(value);
        }
        if (Number.isNaN(d?.getTime?.())) return null;
        if (endOfDay) {
          d.setUTCHours(23, 59, 59, 999);
        } else {
          d.setUTCHours(0, 0, 0, 0);
        }
        // MySQL is strict about datetime literals; prefer "YYYY-MM-DD HH:MM:SS"
        if (dbType === 'mysql') {
          return d.toISOString().slice(0, 19).replace('T', ' ');
        }
        return d.toISOString();
      }

      function normalizeDateOnly(value) {
        if (!value) return null;
        if (typeof value === 'string' && value.includes('/') && value.split('/').length === 3) {
          const [dd, mm, yyyy] = value.split('/').map(s => parseInt(s, 10));
          if (yyyy && mm && dd) return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
        }
        if (typeof value === 'string' && value.includes('T')) return value.slice(0, 10);
        // Assume already YYYY-MM-DD
        return String(value).slice(0, 10);
      }

      const startTs = parseDateInput(start_date, false);
      const endTs = parseDateInput(end_date, true);
      const startDay = normalizeDateOnly(start_date);
      const endDay = normalizeDateOnly(end_date);

      function parseTimeToSeconds(t) {
        if (!t) return null;
        const s = String(t);
        const parts = s.split(':').map(x => parseInt(x, 10));
        if (parts.length < 2 || parts.some(n => Number.isNaN(n))) return null;
        const [hh, mm, ss] = [parts[0], parts[1], parts[2] || 0];
        return (hh * 3600) + (mm * 60) + ss;
      }

      function weekdayCountsInRange(startYYYYMMDD, endYYYYMMDD) {
        const counts = [0, 0, 0, 0, 0, 0, 0]; // 0=Sun..6=Sat
        if (!startYYYYMMDD || !endYYYYMMDD) return counts;
        const start = new Date(`${startYYYYMMDD}T00:00:00Z`);
        const end = new Date(`${endYYYYMMDD}T00:00:00Z`);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return counts;
        for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
          counts[d.getUTCDay()]++;
        }
        return counts;
      }

      const scheduleWeekdayCounts = weekdayCountsInRange(startDay || '1970-01-01', endDay || normalizeDateOnly(new Date().toISOString()));

      async function computePlannedShiftHours(technicianId, startYYYYMMDD, endYYYYMMDD) {
        const hasSchedules = await tableExists('tech_schedules');
        if (!hasSchedules) return { planned_hours: 0, timezone: null };

        const hasExceptions = await tableExists('schedule_exceptions');
        const ph = dbType === 'mysql' ? '?' : '$';

        const schedules = await db.query(
          dbType === 'mysql'
            ? `SELECT weekday, start_time, end_time, timezone FROM tech_schedules WHERE technician_id = ? AND is_active = true`
            : `SELECT weekday, start_time, end_time, timezone FROM tech_schedules WHERE technician_id = $1 AND is_active = true`,
          [technicianId]
        );

        const byWeekday = new Map(); // weekday -> hours
        let tz = null;
        for (const row of (schedules.rows || [])) {
          const wd = Number(row.weekday);
          const startSec = parseTimeToSeconds(row.start_time);
          const endSec = parseTimeToSeconds(row.end_time);
          if (tz == null && row.timezone) tz = row.timezone;
          if (!Number.isFinite(wd) || wd < 0 || wd > 6) continue;
          if (startSec == null || endSec == null) continue;
          const diff = Math.max(0, endSec - startSec);
          const hours = diff / 3600;
          byWeekday.set(wd, hours);
        }

        let total = 0;
        const counts = weekdayCountsInRange(startYYYYMMDD, endYYYYMMDD);
        for (let wd = 0; wd <= 6; wd++) {
          const h = byWeekday.get(wd) || 0;
          total += h * (counts[wd] || 0);
        }

        if (hasExceptions) {
          const exceptions = await db.query(
            dbType === 'mysql'
              ? `SELECT exception_date, start_time, end_time, is_working_day FROM schedule_exceptions WHERE technician_id = ? AND exception_date >= ? AND exception_date <= ?`
              : `SELECT exception_date, start_time, end_time, is_working_day FROM schedule_exceptions WHERE technician_id = $1 AND exception_date >= $2 AND exception_date <= $3`,
            dbType === 'mysql' ? [technicianId, startYYYYMMDD, endYYYYMMDD] : [technicianId, startYYYYMMDD, endYYYYMMDD]
          );

          for (const ex of (exceptions.rows || [])) {
            const dateStr = normalizeDateOnly(ex.exception_date);
            if (!dateStr) continue;
            const d = new Date(`${dateStr}T00:00:00Z`);
            if (Number.isNaN(d.getTime())) continue;
            const wd = d.getUTCDay();
            const base = byWeekday.get(wd) || 0;
            const isWorking = !!ex.is_working_day;
            // Remove base for this day (it was counted already)
            total -= base;
            if (isWorking) {
              const sSec = parseTimeToSeconds(ex.start_time);
              const eSec = parseTimeToSeconds(ex.end_time);
              const exHours = (sSec != null && eSec != null) ? Math.max(0, (eSec - sSec) / 3600) : base;
              total += exHours;
            }
            // if not working day => base removed and nothing added
          }
        }

        return { planned_hours: Math.max(0, Number(total.toFixed(4))), timezone: tz };
      }
      
      // Check if technician_shifts table exists
      const hasShiftsTable = await tableExists('technician_shifts');
      logger.info(`Technician shifts table exists: ${hasShiftsTable}`);
      const hasJobCardsVehicleInfo = await columnExists('job_cards', 'vehicle_info');
      
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
          logger.info(`[SECURITY] Enforcing business unit filter for ${userRole}: BU ${userBusinessUnitId}`);
        }
      }

      // If a specific technician is selected, compute metrics via simple queries (more reliable across schema drift)
      if (technician_id) {
        const nowTs = parseDateInput(new Date().toISOString(), true);
        const rangeStart = startTs || (dbType === 'mysql' ? '1970-01-01 00:00:00' : new Date(0).toISOString());
        const rangeEnd = endTs || nowTs;
        const rangeStartDay = startDay || '1970-01-01';
        const rangeEndDay = endDay || normalizeDateOnly(new Date().toISOString());

        const p = (n) => (dbType === 'mysql' ? '?' : `$${n}`);

        // Schema checks we need
        const hasUsersBU = dbType === 'mysql'
          ? (await db.query(`SHOW COLUMNS FROM users LIKE 'business_unit_id'`)).rows.length > 0
          : (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'business_unit_id'`)).rows.length > 0;

        const hasJobCardsBU = dbType === 'mysql'
          ? (await db.query(`SHOW COLUMNS FROM job_cards LIKE 'business_unit_id'`)).rows.length > 0
          : (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'job_cards' AND column_name = 'business_unit_id'`)).rows.length > 0;

        const hasJobCardsCreatedBy = dbType === 'mysql'
          ? (await db.query(`SHOW COLUMNS FROM job_cards LIKE 'created_by'`)).rows.length > 0
          : (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'job_cards' AND column_name = 'created_by'`)).rows.length > 0;

        const hasJobCardsCompletedAt = dbType === 'mysql'
          ? (await db.query(`SHOW COLUMNS FROM job_cards LIKE 'completed_at'`)).rows.length > 0
          : (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'job_cards' AND column_name = 'completed_at'`)).rows.length > 0;

        const hasJobCardsUpdatedAt = dbType === 'mysql'
          ? (await db.query(`SHOW COLUMNS FROM job_cards LIKE 'updated_at'`)).rows.length > 0
          : (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'job_cards' AND column_name = 'updated_at'`)).rows.length > 0;

        const hasAssignmentCompletedAt = dbType === 'mysql'
          ? (await db.query(`SHOW COLUMNS FROM assignments LIKE 'completed_at'`)).rows.length > 0
          : (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'assignments' AND column_name = 'completed_at'`)).rows.length > 0;

        const hasShiftBreakSeconds = hasShiftsTable
          ? (dbType === 'mysql'
            ? (await db.query(`SHOW COLUMNS FROM technician_shifts LIKE 'break_seconds'`)).rows.length > 0
            : (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'technician_shifts' AND column_name = 'break_seconds'`)).rows.length > 0)
          : false;

        // Tech identity row
        const techInfo = await db.query(
          dbType === 'mysql'
            ? `SELECT t.user_id as technician_id, u.display_name as technician_name, t.employee_code,
                      ${hasUsersBU ? 'u.business_unit_id' : 'NULL'} as business_unit_id,
                      ${hasUsersBU ? 'bu.name' : 'NULL'} as business_unit_name
               FROM technicians t
               JOIN users u ON t.user_id = u.id
               ${hasUsersBU ? 'LEFT JOIN business_units bu ON u.business_unit_id = bu.id' : ''}
               WHERE t.user_id = ? LIMIT 1`
            : `SELECT t.user_id as technician_id, u.display_name as technician_name, t.employee_code,
                      ${hasUsersBU ? 'u.business_unit_id' : 'NULL'} as business_unit_id,
                      ${hasUsersBU ? 'bu.name' : 'NULL'} as business_unit_name
               FROM technicians t
               JOIN users u ON t.user_id = u.id
               ${hasUsersBU ? 'LEFT JOIN business_units bu ON u.business_unit_id = bu.id' : ''}
               WHERE t.user_id = $1 LIMIT 1`,
          [technician_id]
        );

        if (!techInfo.rows || techInfo.rows.length === 0) {
          return res.status(404).json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Technician not found' } });
        }

        // BU scoping for job aggregation (optional)
        let joinCreator = '';
        let whereBU = '';
        const buId = business_unit_id ? parseInt(business_unit_id) : null;
        if (buId && hasJobCardsBU) {
          whereBU = dbType === 'mysql'
            ? ` AND (jc.business_unit_id = ? OR jc.business_unit_id IS NULL)`
            : ` AND (jc.business_unit_id = $${3} OR jc.business_unit_id IS NULL)`; // placeholder adjusted below
        } else if (buId && hasUsersBU && hasJobCardsCreatedBy) {
          joinCreator = ' LEFT JOIN users uc ON jc.created_by = uc.id ';
          whereBU = dbType === 'mysql'
            ? ` AND (uc.business_unit_id = ? OR uc.business_unit_id IS NULL OR jc.created_by IS NULL)`
            : ` AND (uc.business_unit_id = $${3} OR uc.business_unit_id IS NULL OR jc.created_by IS NULL)`;
        }

        // Jobs + billed hours (use time_logs.end_ts for date filtering)
        let jobsParams = [];
        let jobsSql;
        if (dbType === 'mysql') {
          jobsSql = `
            SELECT
              COUNT(DISTINCT jc.id) as total_jobs,
              COUNT(DISTINCT CASE WHEN a.status = 'completed' THEN jc.id END) as completed_jobs,
              COALESCE(SUM(CASE WHEN a.status = 'completed' THEN jc.estimated_hours ELSE 0 END), 0) as total_billed_hours
            FROM assignments a
            JOIN job_cards jc ON a.job_card_id = jc.id
            LEFT JOIN time_logs tl ON tl.assignment_id = a.id AND tl.status = 'finished'
            ${joinCreator}
            WHERE a.technician_id = ?
              AND a.status != 'cancelled'
              ${whereBU}
              AND DATE(tl.end_ts) >= ?
              AND DATE(tl.end_ts) <= ?
          `;
          jobsParams = [technician_id];
          if (buId && (hasJobCardsBU || (hasUsersBU && hasJobCardsCreatedBy))) jobsParams.push(buId);
          jobsParams.push(rangeStartDay, rangeEndDay);
        } else {
          const paramsP = [technician_id];
          let idx = 1;
          let whereBUText = '';
          if (buId && hasJobCardsBU) {
            paramsP.push(buId); idx++;
            whereBUText = ` AND (jc.business_unit_id = $${idx} OR jc.business_unit_id IS NULL)`;
          } else if (buId && hasUsersBU && hasJobCardsCreatedBy) {
            paramsP.push(buId); idx++;
            joinCreator = ' LEFT JOIN users uc ON jc.created_by = uc.id ';
            whereBUText = ` AND (uc.business_unit_id = $${idx} OR uc.business_unit_id IS NULL OR jc.created_by IS NULL)`;
          }
          paramsP.push(rangeStartDay); idx++;
          paramsP.push(rangeEndDay); idx++;
          jobsSql = `
            SELECT
              COUNT(DISTINCT jc.id) as total_jobs,
              COUNT(DISTINCT CASE WHEN a.status = 'completed' THEN jc.id END) as completed_jobs,
              COALESCE(SUM(CASE WHEN a.status = 'completed' THEN jc.estimated_hours ELSE 0 END), 0) as total_billed_hours
            FROM assignments a
            JOIN job_cards jc ON a.job_card_id = jc.id
            LEFT JOIN time_logs tl ON tl.assignment_id = a.id AND tl.status = 'finished'
            ${joinCreator}
            WHERE a.technician_id = $1
              AND a.status != 'cancelled'
              ${whereBUText}
              AND DATE(tl.end_ts) >= $${idx - 1}
              AND DATE(tl.end_ts) <= $${idx}
          `;
          jobsParams = paramsP;
        }
        const jobsResult = await db.query(jobsSql, jobsParams);

        // Worked hours from time logs (finished only, filtered by end_ts)
        const workedSql = dbType === 'mysql'
          ? `
            SELECT COALESCE(SUM(
              CASE
                WHEN status = 'finished' THEN
                  CASE
                    WHEN duration_seconds > 0 THEN duration_seconds
                    WHEN end_ts IS NOT NULL THEN TIMESTAMPDIFF(SECOND, start_ts, end_ts)
                    ELSE 0
                  END
                ELSE 0
              END
            ), 0) / 3600.0 as total_worked_hours
            FROM time_logs
            WHERE technician_id = ?
              AND status = 'finished'
              AND DATE(end_ts) >= ?
              AND DATE(end_ts) <= ?
          `
          : `
            SELECT COALESCE(SUM(
              CASE
                WHEN status = 'finished' THEN
                  CASE
                    WHEN duration_seconds > 0 THEN duration_seconds
                    WHEN end_ts IS NOT NULL THEN EXTRACT(EPOCH FROM (end_ts - start_ts))
                    ELSE 0
                  END
                ELSE 0
              END
            ), 0) / 3600.0 as total_worked_hours
            FROM time_logs
            WHERE technician_id = $1
              AND status = 'finished'
              AND DATE(end_ts) >= $2
              AND DATE(end_ts) <= $3
          `;
        const workedResult = await db.query(workedSql, [technician_id, rangeStartDay, rangeEndDay]);

        // Quality KPIs (completed jobs only): comeback / rework / repeat (approx. repeat within 30 days same plate)
        const comebackExpr = dbType === 'mysql'
          ? `(JSON_EXTRACT(jc.metadata, '$.work_order_details.previous_job_number') IS NOT NULL OR JSON_EXTRACT(jc.metadata, '$.work_order_details.previous_job_card_id') IS NOT NULL)`
          : `((jc.metadata->'work_order_details'->>'previous_job_number') IS NOT NULL OR (jc.metadata->'work_order_details'->>'previous_job_card_id') IS NOT NULL)`;
        const jobCategoryExpr = dbType === 'mysql'
          ? `LOWER(JSON_UNQUOTE(JSON_EXTRACT(jc.metadata, '$.work_order_details.job_category')))`
          : `LOWER(COALESCE(jc.metadata->'work_order_details'->>'job_category',''))`;
        const plateExpr = hasJobCardsVehicleInfo
          ? (dbType === 'mysql'
            ? `NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(jc.vehicle_info, '$.license_plate'))), '')`
            : `NULLIF(BTRIM(jc.vehicle_info->>'license_plate'), '')`)
          : `NULL`;
        const repeatExpr = hasJobCardsVehicleInfo
          ? (dbType === 'mysql'
            ? `EXISTS (
                 SELECT 1
                 FROM job_cards jp
                 WHERE jp.id <> jc.id
                   AND jp.status = 'completed'
                   AND DATE(jp.created_at) < DATE(jc.created_at)
                   AND DATE(jp.created_at) >= DATE_SUB(DATE(jc.created_at), INTERVAL 30 DAY)
                   AND NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(jp.vehicle_info, '$.license_plate'))), '') = ${plateExpr}
                 LIMIT 1
               )`
            : `EXISTS (
                 SELECT 1
                 FROM job_cards jp
                 WHERE jp.id <> jc.id
                   AND jp.status = 'completed'
                   AND DATE(jp.created_at) < DATE(jc.created_at)
                   AND DATE(jp.created_at) >= (DATE(jc.created_at) - INTERVAL '30 days')
                   AND NULLIF(BTRIM(jp.vehicle_info->>'license_plate'), '') = ${plateExpr}
               )`)
          : `FALSE`;

        const qualitySql = dbType === 'mysql'
          ? `
            SELECT
              COALESCE(SUM(CASE WHEN a.status = 'completed' AND ${comebackExpr} THEN 1 ELSE 0 END), 0) as comeback_jobs,
              COALESCE(SUM(CASE WHEN a.status = 'completed' AND ${comebackExpr} AND ${jobCategoryExpr} = 'complaint' THEN 1 ELSE 0 END), 0) as rework_jobs,
              COALESCE(SUM(CASE WHEN a.status = 'completed' AND ${repeatExpr} THEN 1 ELSE 0 END), 0) as repeat_jobs
            FROM assignments a
            JOIN job_cards jc ON a.job_card_id = jc.id
            JOIN time_logs tl_filter ON tl_filter.assignment_id = a.id AND tl_filter.status = 'finished'
            WHERE a.technician_id = ?
              AND a.status != 'cancelled'
              ${whereBU}
              AND DATE(tl_filter.end_ts) >= ?
              AND DATE(tl_filter.end_ts) <= ?
          `
          : `
            SELECT
              COALESCE(SUM(CASE WHEN a.status = 'completed' AND ${comebackExpr} THEN 1 ELSE 0 END), 0) as comeback_jobs,
              COALESCE(SUM(CASE WHEN a.status = 'completed' AND ${comebackExpr} AND ${jobCategoryExpr} = 'complaint' THEN 1 ELSE 0 END), 0) as rework_jobs,
              COALESCE(SUM(CASE WHEN a.status = 'completed' AND ${repeatExpr} THEN 1 ELSE 0 END), 0) as repeat_jobs
            FROM assignments a
            JOIN job_cards jc ON a.job_card_id = jc.id
            JOIN time_logs tl_q ON tl_q.assignment_id = a.id AND tl_q.status = 'finished'
            ${joinCreator}
            WHERE a.technician_id = $1
              AND a.status != 'cancelled'
              ${whereBUText}
              AND DATE(tl_q.end_ts) >= $2
              AND DATE(tl_q.end_ts) <= $3
          `;
        const qualityParams = dbType === 'mysql'
          ? (() => {
              const arr = [technician_id];
              if (buId && (hasJobCardsBU || (hasUsersBU && hasJobCardsCreatedBy))) arr.push(buId);
              arr.push(rangeStartDay, rangeEndDay);
              return arr;
            })()
          : [technician_id, rangeStartDay, rangeEndDay];
        const qualityResult = await db.query(qualitySql, qualityParams);
        const comebackJobs = parseInt(qualityResult.rows?.[0]?.comeback_jobs || 0, 10) || 0;
        const reworkJobs = parseInt(qualityResult.rows?.[0]?.rework_jobs || 0, 10) || 0;
        const repeatJobs = parseInt(qualityResult.rows?.[0]?.repeat_jobs || 0, 10) || 0;

        // Shift hours (optional)
        let shiftHoursActual = 0;
        if (hasShiftsTable) {
          const shiftSql = dbType === 'mysql'
            ? `
              SELECT COALESCE(SUM(
                GREATEST(0,
                  TIMESTAMPDIFF(
                    SECOND,
                    GREATEST(clock_in_time, ?),
                    LEAST(COALESCE(clock_out_time, NOW()), ?)
                  )
                ) - ${hasShiftBreakSeconds ? 'COALESCE(break_seconds, 0)' : '0'}
              ), 0) / 3600.0 as total_shift_hours
              FROM technician_shifts
              WHERE technician_id = ?
                AND clock_in_time <= ?
                AND COALESCE(clock_out_time, NOW()) >= ?
            `
            : `
              SELECT COALESCE(SUM(
                GREATEST(0,
                  EXTRACT(EPOCH FROM (
                    LEAST(COALESCE(clock_out_time, NOW()), $2) - GREATEST(clock_in_time, $1)
                  ))
                ) - ${hasShiftBreakSeconds ? 'COALESCE(break_seconds, 0)' : '0'}
              ), 0) / 3600.0 as total_shift_hours
              FROM technician_shifts
              WHERE technician_id = $3
                AND clock_in_time <= $2
                AND COALESCE(clock_out_time, NOW()) >= $1
            `;
          const shiftParams = dbType === 'mysql'
            ? [rangeStart, rangeEnd, technician_id, rangeEnd, rangeStart]
            : [rangeStart, rangeEnd, technician_id];
          const shiftResult = await db.query(shiftSql, shiftParams);
          shiftHoursActual = parseFloat(shiftResult.rows?.[0]?.total_shift_hours || 0) || 0;
        }

        const planned = await computePlannedShiftHours(technician_id, rangeStartDay, rangeEndDay);
        const shiftHoursPlanned = planned.planned_hours || 0;
        const usePlanned = !(shiftHoursActual > 0);
        const shiftHours = usePlanned ? shiftHoursPlanned : shiftHoursActual;
        const shiftHoursSource = usePlanned ? (shiftHoursPlanned > 0 ? 'planned' : 'none') : 'actual';

        const totalJobs = parseInt(jobsResult.rows?.[0]?.total_jobs || 0, 10) || 0;
        const completedJobs = parseInt(jobsResult.rows?.[0]?.completed_jobs || 0, 10) || 0;
        const billedHours = parseFloat(jobsResult.rows?.[0]?.total_billed_hours || 0) || 0;
        const workedHours = parseFloat(workedResult.rows?.[0]?.total_worked_hours || 0) || 0;

        const efficiency = workedHours > 0 ? Number(((billedHours / workedHours) * 100).toFixed(2)) : 0;
        const productivity = shiftHours > 0 ? Number(((workedHours / shiftHours) * 100).toFixed(2)) : 0;
        const revenueEfficiency = shiftHours > 0 ? Number(((billedHours / shiftHours) * 100).toFixed(2)) : 0;
        const missingEstimate = !(billedHours > 0) && completedJobs > 0;
        const avgPerJob = completedJobs > 0 ? Number((workedHours / completedJobs).toFixed(2)) : 0;

        const row = {
          ...techInfo.rows[0],
          total_jobs: totalJobs,
          completed_jobs: completedJobs,
          active_jobs: 0,
          total_billed_hours: billedHours,
          total_worked_hours: workedHours,
          total_shift_hours: shiftHours,
          total_shift_hours_actual: shiftHoursActual,
          total_shift_hours_planned: shiftHoursPlanned,
          total_shift_hours_source: shiftHoursSource,
          // Backwards compatible fields (deprecated)
          efficiency_percent: efficiency,
          productivity_percent: productivity,
          // Standardized KPIs
          job_efficiency_percent: efficiency,
          utilization_percent: productivity,
          revenue_efficiency_percent: revenueEfficiency,
          missing_estimate: missingEstimate,
          // Quality KPIs
          comeback_jobs: comebackJobs,
          rework_jobs: reworkJobs,
          repeat_jobs: repeatJobs,
          avg_hours_per_job: avgPerJob
        };

        return res.json({
          data: [row],
          summary: {
            total_technicians: 1,
            total_completed_jobs: completedJobs,
            total_billed_hours: billedHours,
            total_worked_hours: workedHours,
            // Backwards compatible fields (deprecated)
            avg_efficiency: efficiency,
            avg_productivity: productivity,
            // Standardized KPI naming
            avg_job_efficiency: efficiency,
            avg_utilization: productivity,
            avg_revenue_efficiency: revenueEfficiency,
            missing_estimate_technicians: missingEstimate ? 1 : 0,
            comeback_jobs: comebackJobs,
            rework_jobs: reworkJobs,
            repeat_jobs: repeatJobs,
            best_efficiency: efficiency,
            worst_efficiency: efficiency
          }
        });
      }

      // Make MySQL/PostgreSQL safe and predictable: compute aggregates via LEFT JOIN subqueries.
      const nowTs = parseDateInput(new Date().toISOString(), true);
      const rangeStart = startTs || (dbType === 'mysql' ? '1970-01-01 00:00:00' : new Date(0).toISOString());
      const rangeEnd = endTs || nowTs;
      const rangeStartDay = startDay || '1970-01-01';
      const rangeEndDay = endDay || normalizeDateOnly(new Date().toISOString());

      const params = [];
      const p = (val) => {
        params.push(val);
        return dbType === 'mysql' ? '?' : `$${params.length}`;
      };

      // Schema checks for optional columns
      let hasJobCardsBU = false;
      try {
        if (dbType === 'mysql') {
          hasJobCardsBU = (await db.query(`SHOW COLUMNS FROM job_cards LIKE 'business_unit_id'`)).rows.length > 0;
        } else {
          hasJobCardsBU = (await db.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'job_cards' AND column_name = 'business_unit_id'`
          )).rows.length > 0;
        }
      } catch (e) { hasJobCardsBU = false; }

      let hasUsersBU = false;
      try {
        if (dbType === 'mysql') {
          hasUsersBU = (await db.query(`SHOW COLUMNS FROM users LIKE 'business_unit_id'`)).rows.length > 0;
        } else {
          hasUsersBU = (await db.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'business_unit_id'`
          )).rows.length > 0;
        }
      } catch (e) { hasUsersBU = false; }

      let hasJobCardsCreatedBy = false;
      try {
        if (dbType === 'mysql') {
          hasJobCardsCreatedBy = (await db.query(`SHOW COLUMNS FROM job_cards LIKE 'created_by'`)).rows.length > 0;
        } else {
          hasJobCardsCreatedBy = (await db.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'job_cards' AND column_name = 'created_by'`
          )).rows.length > 0;
        }
      } catch (e) { hasJobCardsCreatedBy = false; }

      let hasCompletedAt = false;
      try {
        if (dbType === 'mysql') {
          hasCompletedAt = (await db.query(`SHOW COLUMNS FROM job_cards LIKE 'completed_at'`)).rows.length > 0;
        } else {
          hasCompletedAt = (await db.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'job_cards' AND column_name = 'completed_at'`
          )).rows.length > 0;
        }
      } catch (e) { hasCompletedAt = false; }
      // Some deployments have completed_at column but it is not populated consistently.
      // Use COALESCE so date filtering still works.
      let hasUpdatedAt = true;
      try {
        if (dbType === 'mysql') {
          hasUpdatedAt = (await db.query(`SHOW COLUMNS FROM job_cards LIKE 'updated_at'`)).rows.length > 0;
        } else {
          hasUpdatedAt = (await db.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'job_cards' AND column_name = 'updated_at'`
          )).rows.length > 0;
        }
      } catch (e) { hasUpdatedAt = true; }

      // Date filtering for aggregates: removed (using time_logs.end_ts in WHERE clause instead)

      let hasShiftBreakSeconds = false;
      if (hasShiftsTable) {
        try {
          if (dbType === 'mysql') {
            hasShiftBreakSeconds = (await db.query(`SHOW COLUMNS FROM technician_shifts LIKE 'break_seconds'`)).rows.length > 0;
          } else {
            hasShiftBreakSeconds = (await db.query(
              `SELECT column_name FROM information_schema.columns WHERE table_name = 'technician_shifts' AND column_name = 'break_seconds'`
            )).rows.length > 0;
          }
        } catch (e) { hasShiftBreakSeconds = false; }
      }

      // Base technician WHERE
      // IMPORTANT: When a specific technician is selected, always return that row (even if BU linkage is imperfect),
      // and rely on BU scoping inside aggregates. This prevents "No technician data found" empty-list failure mode.
      const isActiveExpr = dbType === 'mysql' ? `(u.is_active <> 0)` : `(u.is_active = true)`;
      let techWhere = `WHERE ${isActiveExpr}`;
      if (technician_id) {
        techWhere += ` AND t.user_id = ${p(technician_id)}`;
      } else if (business_unit_id) {
        const bu = parseInt(business_unit_id);
        // Prefer scoping via job_cards.business_unit_id; fallback to creator's users.business_unit_id; fallback to users.business_unit_id only.
        const canScopeViaCreator = hasUsersBU && hasJobCardsCreatedBy;
        if (hasUsersBU) {
          techWhere += ` AND (
            u.business_unit_id = ${p(bu)}
            OR EXISTS (
              SELECT 1
              FROM assignments ax
              JOIN job_cards jx ON ax.job_card_id = jx.id
              ${hasJobCardsBU ? '' : (canScopeViaCreator ? 'LEFT JOIN users ucx ON jx.created_by = ucx.id' : '')}
              WHERE ax.technician_id = t.user_id
                AND ax.status != 'cancelled'
                ${hasJobCardsBU
                  ? `AND (jx.business_unit_id = ${p(bu)} OR jx.business_unit_id IS NULL)`
                  : (canScopeViaCreator
                    ? `AND (${hasUsersBU ? `ucx.business_unit_id = ${p(bu)} OR ucx.business_unit_id IS NULL OR jx.created_by IS NULL` : `jx.created_by IS NULL`})`
                    : '')
                }
            )
          )`;
        } else if (hasJobCardsBU) {
          techWhere += ` AND EXISTS (
            SELECT 1 FROM assignments ax JOIN job_cards jx ON ax.job_card_id = jx.id
            WHERE ax.technician_id = t.user_id AND ax.status != 'cancelled' AND (jx.business_unit_id = ${p(bu)} OR jx.business_unit_id IS NULL)
          )`;
        }
      }

      // Aggregates (BU-scoped where possible)
      let jobsJoinCreator = '';
      let jobsWhereBU = '';
      if (business_unit_id) {
        const bu = parseInt(business_unit_id);
        if (hasJobCardsBU) {
          // Some DBs have job_cards.business_unit_id but legacy rows may be NULL.
          // Treat NULL as "unclassified" and include it to avoid hiding real work.
          jobsWhereBU = ` AND (jc.business_unit_id = ${p(bu)} OR jc.business_unit_id IS NULL)`;
        } else if (hasUsersBU && hasJobCardsCreatedBy) {
          // Some legacy job cards may have NULL created_by; use LEFT JOIN and include those rows.
          jobsJoinCreator = ` LEFT JOIN users uc ON jc.created_by = uc.id `;
          jobsWhereBU = ` AND (uc.business_unit_id = ${p(bu)} OR uc.business_unit_id IS NULL OR jc.created_by IS NULL)`;
        }
      }
      const baseQuery = `
        SELECT
          t.user_id as technician_id,
          u.display_name as technician_name,
          t.employee_code,
          ${hasUsersBU ? 'u.business_unit_id' : 'NULL'} as business_unit_id,
          ${hasUsersBU ? 'bu.name' : 'NULL'} as business_unit_name,
          COALESCE(j.total_jobs, 0) as total_jobs,
          COALESCE(j.completed_jobs, 0) as completed_jobs,
          COALESCE(aj.active_jobs, 0) as active_jobs,
          COALESCE(j.total_billed_hours, 0) as total_billed_hours,
          COALESCE(j.comeback_jobs, 0) as comeback_jobs,
          COALESCE(j.rework_jobs, 0) as rework_jobs,
          COALESCE(j.repeat_jobs, 0) as repeat_jobs,
          COALESCE(tl.total_worked_hours, 0) as total_worked_hours,
          COALESCE(tl.worked_hours_completed_only, 0) as worked_hours_completed_only,
          COALESCE(sh.total_shift_hours, 0) as total_shift_hours
        FROM technicians t
        JOIN users u ON t.user_id = u.id
        ${hasUsersBU ? 'LEFT JOIN business_units bu ON u.business_unit_id = bu.id' : ''}
        LEFT JOIN (
          SELECT
            a.technician_id,
            COUNT(DISTINCT jc.id) as total_jobs,
            COUNT(DISTINCT CASE WHEN a.status = 'completed' THEN jc.id END) as completed_jobs,
            COALESCE(SUM(CASE WHEN a.status = 'completed' THEN jc.estimated_hours ELSE 0 END), 0) as total_billed_hours,
            COALESCE(SUM(CASE WHEN a.status = 'completed' AND ${
              dbType === 'mysql'
                ? `(JSON_EXTRACT(jc.metadata, '$.work_order_details.previous_job_number') IS NOT NULL OR JSON_EXTRACT(jc.metadata, '$.work_order_details.previous_job_card_id') IS NOT NULL)`
                : `((jc.metadata->'work_order_details'->>'previous_job_number') IS NOT NULL OR (jc.metadata->'work_order_details'->>'previous_job_card_id') IS NOT NULL)`
            } THEN 1 ELSE 0 END), 0) as comeback_jobs,
            COALESCE(SUM(CASE WHEN a.status = 'completed' AND ${
              dbType === 'mysql'
                ? `(JSON_EXTRACT(jc.metadata, '$.work_order_details.previous_job_number') IS NOT NULL OR JSON_EXTRACT(jc.metadata, '$.work_order_details.previous_job_card_id') IS NOT NULL)`
                : `((jc.metadata->'work_order_details'->>'previous_job_number') IS NOT NULL OR (jc.metadata->'work_order_details'->>'previous_job_card_id') IS NOT NULL)`
            } AND ${
              dbType === 'mysql'
                ? `LOWER(JSON_UNQUOTE(JSON_EXTRACT(jc.metadata, '$.work_order_details.job_category')))`
                : `LOWER(COALESCE(jc.metadata->'work_order_details'->>'job_category',''))`
            } = 'complaint' THEN 1 ELSE 0 END), 0) as rework_jobs,
            COALESCE(SUM(CASE WHEN a.status = 'completed' AND ${
              hasJobCardsVehicleInfo
                ? (dbType === 'mysql'
                  ? `EXISTS (
                      SELECT 1
                      FROM job_cards jp
                      WHERE jp.id <> jc.id
                        AND jp.status = 'completed'
                        AND DATE(jp.created_at) < DATE(jc.created_at)
                        AND DATE(jp.created_at) >= DATE_SUB(DATE(jc.created_at), INTERVAL 30 DAY)
                        AND NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(jp.vehicle_info, '$.license_plate'))), '') =
                            NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(jc.vehicle_info, '$.license_plate'))), '')
                      LIMIT 1
                    )`
                  : `EXISTS (
                      SELECT 1
                      FROM job_cards jp
                      WHERE jp.id <> jc.id
                        AND jp.status = 'completed'
                        AND DATE(jp.created_at) < DATE(jc.created_at)
                        AND DATE(jp.created_at) >= (DATE(jc.created_at) - INTERVAL '30 days')
                        AND NULLIF(BTRIM(jp.vehicle_info->>'license_plate'), '') = NULLIF(BTRIM(jc.vehicle_info->>'license_plate'), '')
                    )`)
                : (dbType === 'mysql' ? '0' : 'FALSE')
            } THEN 1 ELSE 0 END), 0) as repeat_jobs
          FROM assignments a
          JOIN job_cards jc ON a.job_card_id = jc.id
          LEFT JOIN time_logs tl_job ON tl_job.assignment_id = a.id AND tl_job.status = 'finished'
          ${jobsJoinCreator}
          WHERE a.status != 'cancelled'
            ${jobsWhereBU}
            AND tl_job.id IS NOT NULL
            AND DATE(tl_job.end_ts) >= ${p(rangeStartDay)}
            AND DATE(tl_job.end_ts) <= ${p(rangeEndDay)}
          GROUP BY a.technician_id
        ) j ON j.technician_id = t.user_id
        LEFT JOIN (
          SELECT technician_id, SUM(CASE WHEN status IN ('assigned','in_progress') THEN 1 ELSE 0 END) as active_jobs
          FROM assignments
          GROUP BY technician_id
        ) aj ON aj.technician_id = t.user_id
        LEFT JOIN (
          SELECT
            technician_id,
            COALESCE(SUM(
              CASE
                WHEN status = 'finished' THEN
                  CASE
                    WHEN duration_seconds > 0 THEN duration_seconds
                    WHEN end_ts IS NOT NULL THEN ${dbType === 'mysql' ? 'TIMESTAMPDIFF(SECOND, start_ts, end_ts)' : "EXTRACT(EPOCH FROM (end_ts - start_ts))"}
                    ELSE 0
                  END
                ELSE 0
              END
            ), 0) / 3600.0 as total_worked_hours,
            COALESCE(SUM(
              CASE
                WHEN status = 'finished'
                  AND EXISTS (
                    SELECT 1 FROM assignments a_check
                    WHERE a_check.id = tl_agg.assignment_id AND a_check.status = 'completed'
                  )
                THEN
                  CASE
                    WHEN tl_agg.duration_seconds > 0 THEN tl_agg.duration_seconds
                    WHEN tl_agg.end_ts IS NOT NULL THEN ${dbType === 'mysql' ? 'TIMESTAMPDIFF(SECOND, tl_agg.start_ts, tl_agg.end_ts)' : "EXTRACT(EPOCH FROM (tl_agg.end_ts - tl_agg.start_ts))"}
                    ELSE 0
                  END
                ELSE 0
              END
            ), 0) / 3600.0 as worked_hours_completed_only
          FROM time_logs tl_agg
          WHERE tl_agg.status = 'finished'
            AND DATE(tl_agg.end_ts) >= ${p(rangeStartDay)} 
            AND DATE(tl_agg.end_ts) <= ${p(rangeEndDay)}
          GROUP BY tl_agg.technician_id
        ) tl ON tl.technician_id = t.user_id
        ${hasShiftsTable ? `LEFT JOIN (
          SELECT
            technician_id,
            COALESCE(SUM(
              GREATEST(
                0,
                ${dbType === 'mysql'
                  ? `TIMESTAMPDIFF(
                      SECOND,
                      GREATEST(clock_in_time, ${p(rangeStart)}),
                      LEAST(COALESCE(clock_out_time, NOW()), ${p(rangeEnd)})
                    )`
                  : `EXTRACT(EPOCH FROM (
                      LEAST(COALESCE(clock_out_time, NOW()), ${p(rangeEnd)}) - GREATEST(clock_in_time, ${p(rangeStart)})
                    ))`
                }
              ) - ${hasShiftBreakSeconds ? 'COALESCE(break_seconds, 0)' : '0'}
            ), 0) / 3600.0 as total_shift_hours
          FROM technician_shifts
          WHERE clock_in_time <= ${p(rangeEnd)} AND COALESCE(clock_out_time, NOW()) >= ${p(rangeStart)}
          GROUP BY technician_id
        ) sh ON sh.technician_id = t.user_id` : `LEFT JOIN (SELECT NULL as technician_id, 0 as total_shift_hours) sh ON sh.technician_id = t.user_id`}
        ${techWhere}
      `;

      const queryText = `
        SELECT base.*,
          CASE WHEN base.total_worked_hours > 0
            THEN ROUND((base.total_billed_hours / base.total_worked_hours) * 100, 2)
            ELSE 0
          END as efficiency_percent,
          CASE WHEN base.total_shift_hours > 0
            THEN ROUND((base.total_worked_hours / base.total_shift_hours) * 100, 2)
            ELSE 0
          END as productivity_percent,
          CASE WHEN base.completed_jobs > 0
            THEN ROUND((base.worked_hours_completed_only / base.completed_jobs), 2)
            ELSE 0
          END as avg_hours_per_job
        FROM (${baseQuery}) base
        ORDER BY efficiency_percent DESC, productivity_percent DESC
      `;
      
      const result = await db.query(queryText, params);

      // Post-process: if a technician has 0 shift hours (no clock-ins), fall back to planned schedule hours.
      const schedulesExist = await tableExists('tech_schedules');
      if (schedulesExist && result.rows && result.rows.length > 0) {
        const processed = await Promise.all(result.rows.map(async (r) => {
          const actual = parseFloat(r.total_shift_hours || 0) || 0;
          const worked = parseFloat(r.total_worked_hours || 0) || 0;
          const billed = parseFloat(r.total_billed_hours || 0) || 0;
          const completed = parseInt(r.completed_jobs || 0, 10) || 0;
          const planned = await computePlannedShiftHours(r.technician_id, rangeStartDay, rangeEndDay);
          const plannedHours = planned.planned_hours || 0;
          const usePlanned = !(actual > 0);
          const effectiveShift = usePlanned ? plannedHours : actual;
          const source = usePlanned ? (plannedHours > 0 ? 'planned' : 'none') : 'actual';
          const productivity = effectiveShift > 0 ? Number(((worked / effectiveShift) * 100).toFixed(2)) : 0;
          const efficiency = worked > 0 ? Number(((billed / worked) * 100).toFixed(2)) : 0;
          const workedCompleted = parseFloat(r.worked_hours_completed_only || 0) || 0;
          const avgPerJob = completed > 0 ? Number((workedCompleted / completed).toFixed(2)) : 0;
          const revenueEfficiency = effectiveShift > 0 ? Number(((billed / effectiveShift) * 100).toFixed(2)) : 0;
          const missingEstimate = !(billed > 0) && completed > 0;
          return {
            ...r,
            total_shift_hours: effectiveShift,
            total_shift_hours_actual: actual,
            total_shift_hours_planned: plannedHours,
            total_shift_hours_source: source,
            // Backwards compatible fields (deprecated)
            productivity_percent: productivity,
            efficiency_percent: efficiency,
            // Standardized KPIs
            utilization_percent: productivity,
            job_efficiency_percent: efficiency,
            revenue_efficiency_percent: revenueEfficiency,
            missing_estimate: missingEstimate,
            comeback_jobs: parseInt(r.comeback_jobs || 0, 10) || 0,
            rework_jobs: parseInt(r.rework_jobs || 0, 10) || 0,
            repeat_jobs: parseInt(r.repeat_jobs || 0, 10) || 0,
            avg_hours_per_job: avgPerJob,
          };
        }));
        result.rows = processed;
      }

      // If a specific technician was requested, never return an empty dataset.
      // This prevents the UI from showing "No technician data" when the technician exists but
      // relationships (BU linkage / job dates) are imperfect. Return a zero-metrics row instead.
      if (technician_id && (!result.rows || result.rows.length === 0)) {
        try {
          const techInfo = await db.query(
            dbType === 'mysql'
              ? `SELECT t.user_id as technician_id, u.display_name as technician_name, t.employee_code,
                        ${hasUsersBU ? 'u.business_unit_id' : 'NULL'} as business_unit_id,
                        ${hasUsersBU ? 'bu.name' : 'NULL'} as business_unit_name
                 FROM technicians t
                 JOIN users u ON t.user_id = u.id
                 ${hasUsersBU ? 'LEFT JOIN business_units bu ON u.business_unit_id = bu.id' : ''}
                 WHERE t.user_id = ? LIMIT 1`
              : `SELECT t.user_id as technician_id, u.display_name as technician_name, t.employee_code,
                        ${hasUsersBU ? 'u.business_unit_id' : 'NULL'} as business_unit_id,
                        ${hasUsersBU ? 'bu.name' : 'NULL'} as business_unit_name
                 FROM technicians t
                 JOIN users u ON t.user_id = u.id
                 ${hasUsersBU ? 'LEFT JOIN business_units bu ON u.business_unit_id = bu.id' : ''}
                 WHERE t.user_id = $1 LIMIT 1`,
            [technician_id]
          );

          if (techInfo.rows && techInfo.rows.length > 0) {
            result.rows = [{
              ...techInfo.rows[0],
              total_jobs: 0,
              completed_jobs: 0,
              active_jobs: 0,
              total_billed_hours: 0,
              total_worked_hours: 0,
              total_shift_hours: 0,
              efficiency_percent: 0,
              productivity_percent: 0,
              avg_hours_per_job: 0
            }];
          }
        } catch (e) {
          // ignore fallback failures; we'll return empty as before
        }
      }
      
      // Calculate summary statistics
      const summary = {
        total_technicians: result.rows.length,
        total_completed_jobs: result.rows.reduce((sum, row) => sum + parseInt(row.completed_jobs || 0), 0),
        total_billed_hours: result.rows.reduce((sum, row) => sum + parseFloat(row.total_billed_hours || 0), 0),
        total_worked_hours: result.rows.reduce((sum, row) => sum + parseFloat(row.total_worked_hours || 0), 0),
        // Backwards compatible summary fields (deprecated)
        avg_efficiency: result.rows.length > 0 
          ? result.rows.reduce((sum, row) => sum + parseFloat(row.efficiency_percent || 0), 0) / result.rows.length
          : 0,
        avg_productivity: result.rows.length > 0 
          ? result.rows.reduce((sum, row) => sum + parseFloat(row.productivity_percent || 0), 0) / result.rows.length
          : 0,
        // Standardized KPI naming
        avg_job_efficiency: result.rows.length > 0
          ? result.rows.reduce((sum, row) => sum + parseFloat((row.job_efficiency_percent ?? row.efficiency_percent) || 0), 0) / result.rows.length
          : 0,
        avg_utilization: result.rows.length > 0
          ? result.rows.reduce((sum, row) => sum + parseFloat((row.utilization_percent ?? row.productivity_percent) || 0), 0) / result.rows.length
          : 0,
        avg_revenue_efficiency: result.rows.length > 0
          ? result.rows.reduce((sum, row) => sum + parseFloat(row.revenue_efficiency_percent || 0), 0) / result.rows.length
          : 0,
        missing_estimate_technicians: result.rows.reduce((sum, row) => sum + ((row.missing_estimate || row.missing_estimate === 1) ? 1 : 0), 0),
        comeback_jobs: result.rows.reduce((sum, row) => sum + parseInt(row.comeback_jobs || 0, 10), 0),
        rework_jobs: result.rows.reduce((sum, row) => sum + parseInt(row.rework_jobs || 0, 10), 0),
        repeat_jobs: result.rows.reduce((sum, row) => sum + parseInt(row.repeat_jobs || 0, 10), 0),
        best_efficiency: result.rows.length > 0 
          ? Math.max(...result.rows.map(row => parseFloat(row.efficiency_percent || 0)))
          : 0,
        worst_efficiency: result.rows.length > 0 
          ? Math.min(...result.rows.map(row => parseFloat(row.efficiency_percent || 0)))
          : 0
      };

      res.json({
        data: result.rows,
        summary
      });
    } catch (error) {
      logger.error('Technician efficiency report error:', error);
      logger.error('Error details:', { message: error.message, stack: error.stack });
      res.status(500).json({
        error: {
          code: 'REPORT_ERROR',
          message: 'Technician efficiency report failed: ' + error.message,
          details: error.stack
        }
      });
    }
  }
);

module.exports = router;

