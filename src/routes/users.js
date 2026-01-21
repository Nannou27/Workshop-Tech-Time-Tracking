const express = require('express');
const { body, validationResult, query } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireAdmin } = require('../middleware/auth');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { ensureTechnicianProfile } = require('../services/technicianProfileService');

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

// GET /api/v1/users
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    let { role_id, is_active, search, page = 1, limit = 20, business_unit_id } = req.query;
    const offset = (page - 1) * limit;

    const dbType = process.env.DB_TYPE || 'postgresql';
    
    // SECURITY: BU Admins can ONLY see users in their own Business Unit
    const actorResult = await db.query(
      dbType === 'mysql'
        ? `SELECT u.business_unit_id, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ?`
        : `SELECT u.business_unit_id, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1`,
      [req.user.id]
    );
    
    if (actorResult.rows.length > 0) {
      const actorRole = actorResult.rows[0].role_name;
      const actorBusinessUnitId = actorResult.rows[0].business_unit_id;
      
      if (actorRole && actorRole.toLowerCase().includes('business unit admin') && actorBusinessUnitId) {
        business_unit_id = actorBusinessUnitId;
        logger.info(`[SECURITY] BU Admin ${req.user.id} - enforcing business_unit_id: ${actorBusinessUnitId}`);
      }
    }
    
    // Simple query for MySQL
    let queryText = `
      SELECT u.id, u.email, u.display_name, u.role_id, u.is_active, 
             u.last_login_at, u.created_at, r.name as role_name,
             u.business_unit_id, u.location_id, u.cost_center, u.employee_number,
             bu.name as business_unit_name, bu.code as business_unit_code,
             l.name as location_name
      FROM users u
      JOIN roles r ON u.role_id = r.id
      LEFT JOIN business_units bu ON u.business_unit_id = bu.id
      LEFT JOIN locations l ON u.location_id = l.id
      WHERE 1=1
    `;
    
    const params = [];

    if (role_id) {
      queryText += ` AND u.role_id = ?`;
      params.push(role_id);
    }

    if (is_active !== undefined) {
      queryText += ` AND u.is_active = ?`;
      params.push(is_active === 'true' || is_active === true ? 1 : 0);
    }
    
    if (business_unit_id) {
      queryText += ` AND u.business_unit_id = ?`;
      params.push(parseInt(business_unit_id));
    }
    
    if (req.query.location_id) {
      queryText += ` AND u.location_id = ?`;
      params.push(parseInt(req.query.location_id));
    }
    
    if (search) {
      queryText += ` AND (u.email LIKE ? OR u.display_name LIKE ? OR u.employee_number LIKE ?)`;
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern);
    }

    queryText += ` ORDER BY u.created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(queryText, params);
    const countResult = await db.query('SELECT COUNT(*) as count FROM users', []);

    res.json({
      data: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].count),
        total_pages: Math.ceil(countResult.rows[0].count / limit)
      }
    });
  } catch (error) {
    logger.error('Get users error:', error);
    next(error);
  }
});

// GET /api/v1/users/:id
router.get('/:id', async (req, res, next) => {
  try {
    // Users can view their own profile, admins can view any.
    // Service Advisors may view Technician users in their own Business Unit (team management).
    const userId = req.params.id;
    const adminRoles = ['Super Admin', 'Business Unit Admin'];
    const isAdmin = adminRoles.includes(req.user.roleName);
    const isServiceAdvisor = req.user.roleName === 'ServiceAdvisor' || req.user.roleName === 'Service Advisor';
    
    logger.info(`GET /users/:id - userId: ${userId}, req.user.id: ${req.user.id}, isAdmin: ${isAdmin}`);
    
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    // Check if new columns and tables exist
    const hasBusinessUnitId = await columnExists('users', 'business_unit_id');
    const hasLocationId = await columnExists('users', 'location_id');
    const hasCostCenter = await columnExists('users', 'cost_center');
    const hasEmployeeNumber = await columnExists('users', 'employee_number');
    const businessUnitsTableExists = await tableExists('business_units');
    const locationsTableExists = await tableExists('locations');
    
    // Build SELECT fields conditionally
    let selectFields = `u.id, u.email, u.display_name, u.role_id, u.is_active, 
              u.metadata, u.created_at, u.updated_at,
              r.name as role_name`;
    
    if (hasBusinessUnitId) {
      selectFields += `, u.business_unit_id`;
    }
    if (hasLocationId) {
      selectFields += `, u.location_id`;
    }
    if (hasCostCenter) {
      selectFields += `, u.cost_center`;
    }
    if (hasEmployeeNumber) {
      selectFields += `, u.employee_number`;
    }
    if (businessUnitsTableExists && hasBusinessUnitId) {
      selectFields += `, bu.name as business_unit_name, bu.code as business_unit_code`;
    }
    if (locationsTableExists && hasLocationId) {
      selectFields += `, l.name as location_name`;
    }
    
    // Build JOIN clauses conditionally
    let joinClauses = `FROM users u
       JOIN roles r ON u.role_id = r.id`;
    
    if (businessUnitsTableExists && hasBusinessUnitId) {
      joinClauses += `
       LEFT JOIN business_units bu ON u.business_unit_id = bu.id`;
    }
    if (locationsTableExists && hasLocationId) {
      joinClauses += `
       LEFT JOIN locations l ON u.location_id = l.id`;
    }
    
    logger.info(`Querying user with id: ${userId} (type: ${typeof userId}), placeholder: ${placeholder}`);
    
    // Simple query - let the database handle the type conversion
    const result = await db.query(
      `SELECT ${selectFields}
       ${joinClauses}
       WHERE u.id = ${placeholder}`,
      [String(userId)] // Convert to string to ensure consistent format
    );

    logger.info(`Query result: ${result.rows.length} rows found`);

    if (result.rows.length === 0) {
      logger.warn(`User not found with id: ${userId}`);
      return res.status(404).json({
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'User not found'
        }
      });
    }

    const target = result.rows[0];

    // Authorization after fetch so we can enforce BU + target role constraints for Service Advisors
    if (userId !== req.user.id && !isAdmin) {
      // Service Advisors can only view Technician users in their BU
      if (
        isServiceAdvisor &&
        target.role_name === 'Technician' &&
        target.business_unit_id &&
        req.user.businessUnitId &&
        String(target.business_unit_id) === String(req.user.businessUnitId)
      ) {
        return res.json(target);
      }

      return res.status(403).json({
        error: {
          code: 'AUTHORIZATION_FAILED',
          message: 'Insufficient permissions'
        }
      });
    }

    res.json(target);
  } catch (error) {
    logger.error('Get user error:', error);
    next(error);
  }
});

// POST /api/v1/users
router.post('/',
  async (req, res, next) => {
    // Check permissions: Admins can create any user, Service Advisors can only create Technicians
    const { requireAdmin, requireAdminOrServiceAdvisor } = require('../middleware/auth');
    
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    const roleResult = await db.query(
      `SELECT name FROM roles WHERE id = ${placeholder}`,
      [req.user.roleId]
    );
    
    const userRole = roleResult.rows.length > 0 ? roleResult.rows[0].name : null;
    const requestedRoleId = parseInt(req.body.role_id);
    
    // Get the requested role name
    const requestedRoleResult = await db.query(
      `SELECT name FROM roles WHERE id = ${placeholder}`,
      [requestedRoleId]
    );
    const requestedRoleName = requestedRoleResult.rows.length > 0 ? requestedRoleResult.rows[0].name : null;
    
    // Service Advisors can ONLY create Technician users
    if ((userRole === 'ServiceAdvisor' || userRole === 'Service Advisor') && requestedRoleName !== 'Technician') {
      return res.status(403).json({
        error: {
          code: 'AUTHORIZATION_FAILED',
          message: 'Service Advisors can only create Technician users'
        }
      });
    }
    
    // If not admin and not service advisor, deny
    const allowedRoles = ['Super Admin', 'Business Unit Admin', 'ServiceAdvisor', 'Service Advisor'];
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        error: {
          code: 'AUTHORIZATION_FAILED',
          message: 'Insufficient permissions to create users'
        }
      });
    }
    
    next();
  },
  [
    body('email').isEmail().normalizeEmail(),
    body('display_name').notEmpty().trim(),
    body('password').isLength({ min: 12 }),
    body('role_id').isInt()
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
        email,
        display_name,
        password,
        role_id,
        is_active = true,
        business_unit_id: requested_business_unit_id,
        location_id,
        supervisor_id,
        cost_center,
        employee_number,
        metadata = {}
      } = req.body;

      // NOTE: business_unit_id may be enforced to the actor's BU for BU Admin / Service Advisor.
      // It must be mutable to support secure server-side scoping.
      let business_unit_id = requested_business_unit_id;

      // Check if email exists
      const dbType = process.env.DB_TYPE || 'postgresql';
      const emailPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const existingUser = await db.query(`SELECT id FROM users WHERE email = ${emailPlaceholder}`, [email]);
      if (existingUser.rows.length > 0) {
        return res.status(409).json({
          error: {
            code: 'RESOURCE_CONFLICT',
            message: 'User with this email already exists'
          }
        });
      }

      // Check if new columns exist
      const hasBusinessUnitId = await columnExists('users', 'business_unit_id');
      const hasLocationId = await columnExists('users', 'location_id');
      const hasCostCenter = await columnExists('users', 'cost_center');
      const hasEmployeeNumber = await columnExists('users', 'employee_number');
      const businessUnitsTableExists = await tableExists('business_units');
      const locationsTableExists = await tableExists('locations');
      
      // BUSINESS UNIT SCOPING: BU Admins and Service Advisors can only create users in their OWN BU
      const actorCheckPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const actorResult = await db.query(
        `SELECT u.business_unit_id, r.name as role_name 
         FROM users u 
         JOIN roles r ON u.role_id = r.id 
         WHERE u.id = ${actorCheckPlaceholder}`,
        [req.user.id]
      );
      
      if (actorResult.rows.length > 0) {
        const actorRole = actorResult.rows[0].role_name;
        const actorBusinessUnitId = actorResult.rows[0].business_unit_id;
        
        // If Business Unit Admin or Service Advisor, FORCE users to be in their BU
        if (actorRole && (actorRole.toLowerCase().includes('business unit admin') || actorRole === 'ServiceAdvisor' || actorRole === 'Service Advisor')) {
          if (!actorBusinessUnitId) {
            return res.status(403).json({
              error: {
                code: 'AUTHORIZATION_FAILED',
                message: 'You must be assigned to a business unit to create users'
              }
            });
          }
          
          // Force the new user's business_unit_id to be the same as creator's
          if (business_unit_id && business_unit_id !== actorBusinessUnitId) {
            logger.warn(`[SECURITY] ${actorRole} attempted to create user in another BU. Actor BU: ${actorBusinessUnitId}, Requested BU: ${business_unit_id}`);
          }
          business_unit_id = actorBusinessUnitId;
          logger.info(`[SECURITY] ${actorRole} creating user in their BU: ${actorBusinessUnitId}`);
        }
      }
      
      // Validate business_unit_id if provided and column exists
      if (business_unit_id && hasBusinessUnitId && businessUnitsTableExists) {
        const buPlaceholder = dbType === 'mysql' ? '?' : '$1';
        const buCheck = await db.query(
          `SELECT id FROM business_units WHERE id = ${buPlaceholder}`,
          [business_unit_id]
        );
        if (buCheck.rows.length === 0) {
          return res.status(400).json({
            error: {
              code: 'INVALID_BUSINESS_UNIT',
              message: 'Business unit not found'
            }
          });
        }
      }
      
      // Validate location_id if provided and column exists
      if (location_id && hasLocationId && locationsTableExists) {
        const locPlaceholder = dbType === 'mysql' ? '?' : '$1';
        const locCheck = await db.query(
          `SELECT id FROM locations WHERE id = ${locPlaceholder}`,
          [location_id]
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
      
      // Check for duplicate employee_number if provided and column exists
      if (employee_number && hasEmployeeNumber) {
        const empPlaceholder = dbType === 'mysql' ? '?' : '$1';
        const empCheck = await db.query(
          `SELECT id FROM users WHERE employee_number = ${empPlaceholder}`,
          [employee_number]
        );
        if (empCheck.rows.length > 0) {
          return res.status(400).json({
            error: {
              code: 'DUPLICATE_EMPLOYEE_NUMBER',
              message: 'Employee number already exists'
            }
          });
        }
      }
      
      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      let user;
      
      // Build INSERT columns and values conditionally
      const insertCols = ['email', 'display_name', 'password_hash', 'role_id', 'is_active', 'metadata', 'created_by'];
      const insertVals = [email, display_name, passwordHash, role_id, is_active, JSON.stringify(metadata), req.user.id];
      
      if (hasBusinessUnitId) {
        insertCols.push('business_unit_id');
        insertVals.push(business_unit_id || null);
      }
      if (hasLocationId) {
        insertCols.push('location_id');
        insertVals.push(location_id || null);
      }
      if (hasCostCenter) {
        insertCols.push('cost_center');
        insertVals.push(cost_center || null);
      }
      if (hasEmployeeNumber) {
        insertCols.push('employee_number');
        insertVals.push(employee_number || null);
      }
      
      // Add supervisor_id if provided (for team assignment)
      const hasSupervisorId = await columnExists('users', 'supervisor_id');
      if (hasSupervisorId && supervisor_id) {
        insertCols.push('supervisor_id');
        insertVals.push(supervisor_id);
        logger.info(`[USER CREATE] Assigning supervisor_id: ${supervisor_id}`);
      }
      
      if (dbType === 'mysql') {
        // MySQL uses UUID() function or we generate one
        const uuidResult = await db.query('SELECT UUID() as id');
        const userId = uuidResult.rows[0].id;
        insertCols.unshift('id');
        insertVals.unshift(userId);
        
        const placeholders = insertVals.map(() => '?').join(', ');
        await db.query(
          `INSERT INTO users (${insertCols.join(', ')})
           VALUES (${placeholders})`,
          insertVals
        );
        
        // Fetch the inserted record with related info
        let selectFields = `u.id, u.email, u.display_name, u.role_id, u.is_active, u.created_at`;
        let joinClauses = `FROM users u`;
        
        if (hasBusinessUnitId) selectFields += `, u.business_unit_id`;
        if (hasLocationId) selectFields += `, u.location_id`;
        if (hasCostCenter) selectFields += `, u.cost_center`;
        if (hasEmployeeNumber) selectFields += `, u.employee_number`;
        
        if (businessUnitsTableExists && hasBusinessUnitId) {
          selectFields += `, bu.name as business_unit_name, bu.code as business_unit_code`;
          joinClauses += ` LEFT JOIN business_units bu ON u.business_unit_id = bu.id`;
        }
        if (locationsTableExists && hasLocationId) {
          selectFields += `, l.name as location_name`;
          joinClauses += ` LEFT JOIN locations l ON u.location_id = l.id`;
        }
        
        const result = await db.query(
          `SELECT ${selectFields}
           ${joinClauses}
           WHERE u.email = ?`,
          [email]
        );
        user = result.rows[0];
      } else {
        const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(', ');
        let returningFields = 'id, email, display_name, role_id, is_active, created_at';
        if (hasBusinessUnitId) returningFields += ', business_unit_id';
        if (hasLocationId) returningFields += ', location_id';
        if (hasCostCenter) returningFields += ', cost_center';
        if (hasEmployeeNumber) returningFields += ', employee_number';
        
        const result = await db.query(
          `INSERT INTO users (${insertCols.join(', ')})
           VALUES (${placeholders})
           RETURNING ${returningFields}`,
          insertVals
        );
        user = result.rows[0];
        
        // Get related info if tables exist
        if ((user.business_unit_id || user.location_id) && (businessUnitsTableExists || locationsTableExists)) {
          if (user.business_unit_id && businessUnitsTableExists) {
            const buInfo = await db.query(
              `SELECT name, code FROM business_units WHERE id = $1`,
              [user.business_unit_id]
            );
            if (buInfo.rows.length > 0) {
              user.business_unit_name = buInfo.rows[0].name;
              user.business_unit_code = buInfo.rows[0].code;
            }
          }
          if (user.location_id && locationsTableExists) {
            const locInfo = await db.query(
              `SELECT name FROM locations WHERE id = $1`,
              [user.location_id]
            );
            if (locInfo.rows.length > 0) {
              user.location_name = locInfo.rows[0].name;
            }
          }
        }
      }

      // AUTO-CREATE / UPDATE TECHNICIAN PROFILE if role is Technician (shared service)
      const roleCheckPlaceholder = dbType === 'mysql' ? '?' : '$1';
      const roleNameResult = await db.query(
        `SELECT name FROM roles WHERE id = ${roleCheckPlaceholder}`,
        [role_id]
      );
      
      if (roleNameResult.rows.length > 0 && roleNameResult.rows[0].name === 'Technician') {
        // Allow callers (BU Admin UI / Advisor UI) to pass technician profile fields in the same request.
        const technician_profile =
          req.body.technician_profile ||
          req.body.technicianProfile ||
          {
            // Back-compat: some UIs send these as top-level fields or update after creation.
            employee_code: req.body.employee_code || req.body.employeeCode || employee_number || null,
            trade: req.body.trade,
            hourly_rate: req.body.hourly_rate,
            max_concurrent_jobs: req.body.max_concurrent_jobs,
            skill_tags: req.body.skill_tags,
            schedule: req.body.schedule
          };

        const ensured = await ensureTechnicianProfile({
          actorUserId: req.user.id,
          targetUserId: user.id,
          employeeNumberFallback: employee_number,
          profileInput: technician_profile,
          allowUpdate: true
        });

        if (!ensured.ok) {
          // Don't fail user creation for optional technician feature mismatch, but do return a hint.
          user.technician_profile_error = ensured.error;
        } else {
          user.employee_code = ensured.employee_code;
          user.technician_profile_created = true;
        }
      }

      // Create audit log
      if (dbType === 'mysql') {
        await db.query(
          `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
           VALUES (?, 'user.created', 'user', ?, ?)`,
          [req.user.id, user.id, JSON.stringify({ email: user.email })]
        );
      } else {
        await db.query(
          `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
           VALUES ($1, 'user.created', 'user', $2, $3)`,
          [req.user.id, user.id, JSON.stringify({ email: user.email })]
        );
      }

      res.status(201).json(user);
    } catch (error) {
      logger.error('Create user error:', error);
      next(error);
    }
  }
);

// PATCH /api/v1/users/:id
router.patch('/:id',
  [
    body('display_name').optional().notEmpty().trim(),
    body('is_active').optional().isBoolean()
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

      const userId = req.params.id;
      
      // Users can update their own profile (limited fields), admins can update any
      const adminRoles = ['Super Admin', 'Business Unit Admin'];
      const isAdmin = adminRoles.includes(req.user.roleName);
      const isServiceAdvisor = req.user.roleName === 'ServiceAdvisor' || req.user.roleName === 'Service Advisor';
      const actorBusinessUnitId = req.user.businessUnitId;

      // Service Advisors may update technician users in their BU (display_name, is_active, employee_number)
      let canManageTechnicianUser = false;
      if (isServiceAdvisor && userId !== req.user.id && actorBusinessUnitId) {
        try {
          const dbTypeForCheck = process.env.DB_TYPE || 'postgresql';
          const ph = dbTypeForCheck === 'mysql' ? '?' : '$1';
          const targetInfo = await db.query(
            `SELECT u.business_unit_id, r.name as role_name
             FROM users u
             JOIN roles r ON u.role_id = r.id
             WHERE u.id = ${ph}`,
            [String(userId)]
          );
          if (
            targetInfo.rows.length > 0 &&
            targetInfo.rows[0].role_name === 'Technician' &&
            targetInfo.rows[0].business_unit_id &&
            String(targetInfo.rows[0].business_unit_id) === String(actorBusinessUnitId)
          ) {
            canManageTechnicianUser = true;
          }
        } catch (e) {
          // fall through to normal auth checks
        }
      }
      
      if (userId !== req.user.id && !isAdmin && !canManageTechnicianUser) {
        return res.status(403).json({
          error: {
            code: 'AUTHORIZATION_FAILED',
            message: 'Insufficient permissions'
          }
        });
      }

      const { 
        display_name, 
        is_active, 
        business_unit_id,
        location_id,
        supervisor_id,
        cost_center,
        employee_number,
        metadata 
      } = req.body;
      
      logger.info(`[USER PATCH] Updating user ${userId}. Request data:`, {
        business_unit_id,
        location_id,
        isAdmin,
        actorId: req.user.id
      });
      
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$';
      
      // Check if new columns exist
      const hasBusinessUnitId = await columnExists('users', 'business_unit_id');
      const hasLocationId = await columnExists('users', 'location_id');
      const hasCostCenter = await columnExists('users', 'cost_center');
      const hasEmployeeNumber = await columnExists('users', 'employee_number');
      const businessUnitsTableExists = await tableExists('business_units');
      const locationsTableExists = await tableExists('locations');
      
      logger.info(`[USER PATCH] Column checks:`, {
        hasBusinessUnitId,
        hasLocationId,
        businessUnitsTableExists,
        locationsTableExists
      });
      
      const updates = [];
      const params = [];
      let paramCount = 0;

      if (display_name !== undefined) {
        paramCount++;
        updates.push(`display_name = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
        params.push(display_name);
      }

      if (is_active !== undefined && (isAdmin || canManageTechnicianUser)) { // Admin or SA managing tech can change is_active
        paramCount++;
        updates.push(`is_active = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
        params.push(is_active);
      }
      
      // Only admin can change business_unit_id, location_id, cost_center, employee_number
      // Check if user is admin by role name (not just roleId which might be wrong)
      if (business_unit_id !== undefined && isAdmin && hasBusinessUnitId && businessUnitsTableExists) {
        // Validate business unit exists
        const buPlaceholder = dbType === 'mysql' ? '?' : '$1';
        const buCheck = await db.query(
          `SELECT id FROM business_units WHERE id = ${buPlaceholder}`,
          [business_unit_id]
        );
        if (buCheck.rows.length === 0) {
          return res.status(400).json({
            error: {
              code: 'INVALID_BUSINESS_UNIT',
              message: 'Business unit not found'
            }
          });
        }
        
        paramCount++;
        updates.push(`business_unit_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
        params.push(business_unit_id);
        logger.info(`[UPDATE] Admin updating user business_unit_id to: ${business_unit_id}`);
      }
      
      if (location_id !== undefined && (isAdmin || canManageTechnicianUser) && hasLocationId && locationsTableExists) {
        // Validate location exists (and enforce BU scoping for Service Advisors managing technicians)
        const hasLocationBU = await columnExists('locations', 'business_unit_id');
        const locPlaceholder = dbType === 'mysql' ? '?' : '$1';
        const locCheck = await db.query(
          hasLocationBU
            ? `SELECT id, business_unit_id FROM locations WHERE id = ${locPlaceholder}`
            : `SELECT id FROM locations WHERE id = ${locPlaceholder}`,
          [location_id]
        );
        if (locCheck.rows.length === 0) {
          return res.status(400).json({
            error: {
              code: 'INVALID_LOCATION',
              message: 'Location not found'
            }
          });
        }

        // If a Service Advisor is updating a technician, the target location must belong to the advisor's BU (when schema supports it)
        if (canManageTechnicianUser && actorBusinessUnitId && hasLocationBU) {
          const locBu = locCheck.rows[0].business_unit_id;
          if (locBu && String(locBu) !== String(actorBusinessUnitId)) {
            return res.status(403).json({
              error: {
                code: 'AUTHORIZATION_FAILED',
                message: 'Cannot set technician location outside your business unit'
              }
            });
          }
        }
        
        paramCount++;
        updates.push(`location_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
        params.push(location_id);
        logger.info(`[UPDATE] Updating user location_id to: ${location_id}`);
      }
      
      if (cost_center !== undefined && isAdmin && hasCostCenter) {
        paramCount++;
        updates.push(`cost_center = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
        params.push(cost_center);
        logger.info(`[UPDATE] Admin updating user cost_center to: ${cost_center}`);
      }
      
      if (employee_number !== undefined && (isAdmin || canManageTechnicianUser) && hasEmployeeNumber) {
        // Check for duplicate employee_number (excluding current user)
        const empPlaceholder = dbType === 'mysql' ? '?' : '$1';
        const empCheck = await db.query(
          `SELECT id FROM users WHERE employee_number = ${empPlaceholder} AND id != ${dbType === 'mysql' ? '?' : '$2'}`,
          dbType === 'mysql' ? [employee_number, userId] : [employee_number, userId]
        );
        if (empCheck.rows.length > 0) {
          return res.status(400).json({
            error: {
              code: 'DUPLICATE_EMPLOYEE_NUMBER',
              message: 'Employee number already exists'
            }
          });
        }
        
        paramCount++;
        updates.push(`employee_number = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
        params.push(employee_number);
      }
      
      // Add supervisor_id update (for team assignment)
      if (supervisor_id !== undefined && isAdmin) {
        const hasSupervisorId = await columnExists('users', 'supervisor_id');
        if (hasSupervisorId) {
          paramCount++;
          updates.push(`supervisor_id = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
          params.push(supervisor_id);
          logger.info(`[UPDATE] Admin updating user supervisor_id to: ${supervisor_id}`);
        }
      }

      if (metadata !== undefined) {
        paramCount++;
        const metadataValue = dbType === 'mysql' ? JSON.stringify(metadata) : metadata;
        updates.push(`metadata = ${placeholder}${dbType === 'mysql' ? '' : paramCount}`);
        params.push(metadataValue);
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
        // Convert placeholders for MySQL
        const mysqlUpdates = updates.map((update, index) => {
          return update.replace(/\$\d+/g, '?');
        });
        
        paramCount++;
        mysqlUpdates.push(`updated_at = NOW()`);
        paramCount++;
        params.push(userId);
        
        await db.query(
          `UPDATE users SET ${mysqlUpdates.join(', ')} WHERE id = ?`,
          params
        );
        
        // Build SELECT fields conditionally
        let selectFields = `u.id, u.display_name, u.is_active, u.updated_at`;
        let joinClauses = `FROM users u`;
        
        if (hasBusinessUnitId) selectFields += `, u.business_unit_id`;
        if (hasLocationId) selectFields += `, u.location_id`;
        if (hasCostCenter) selectFields += `, u.cost_center`;
        if (hasEmployeeNumber) selectFields += `, u.employee_number`;
        
        if (businessUnitsTableExists && hasBusinessUnitId) {
          selectFields += `, bu.name as business_unit_name, bu.code as business_unit_code`;
          joinClauses += ` LEFT JOIN business_units bu ON u.business_unit_id = bu.id`;
        }
        if (locationsTableExists && hasLocationId) {
          selectFields += `, l.name as location_name`;
          joinClauses += ` LEFT JOIN locations l ON u.location_id = l.id`;
        }
        
        const result = await db.query(
          `SELECT ${selectFields}
           ${joinClauses}
           WHERE u.id = ?`,
          [userId]
        );
        
        if (result.rows.length === 0) {
          return res.status(404).json({
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'User not found'
            }
          });
        }

        // Create audit log
        await db.query(
          `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
           VALUES (?, 'user.updated', 'user', ?, ?)`,
          [req.user.id, userId, JSON.stringify(req.body)]
        );

        logger.info(`[USER UPDATE] User ${userId} updated successfully. BU: ${result.rows[0].business_unit_id}, Location: ${result.rows[0].location_id}`);
        res.json(result.rows[0]);
      } else {
        paramCount++;
        updates.push(`updated_at = now()`);
        paramCount++;
        params.push(userId);

        let returningFields = 'id, display_name, is_active, updated_at';
        if (hasBusinessUnitId) returningFields += ', business_unit_id';
        if (hasLocationId) returningFields += ', location_id';
        if (hasCostCenter) returningFields += ', cost_center';
        if (hasEmployeeNumber) returningFields += ', employee_number';
        
        const result = await db.query(
          `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramCount} 
           RETURNING ${returningFields}`,
          params
        );

        if (result.rows.length === 0) {
          return res.status(404).json({
            error: {
              code: 'RESOURCE_NOT_FOUND',
              message: 'User not found'
            }
          });
        }
        
        // Get related info if tables exist
        const user = result.rows[0];
        if ((user.business_unit_id || user.location_id) && (businessUnitsTableExists || locationsTableExists)) {
          if (user.business_unit_id && businessUnitsTableExists) {
            const buInfo = await db.query(
              `SELECT name, code FROM business_units WHERE id = $1`,
              [user.business_unit_id]
            );
            if (buInfo.rows.length > 0) {
              user.business_unit_name = buInfo.rows[0].name;
              user.business_unit_code = buInfo.rows[0].code;
            }
          }
          if (user.location_id && locationsTableExists) {
            const locInfo = await db.query(
              `SELECT name FROM locations WHERE id = $1`,
              [user.location_id]
            );
            if (locInfo.rows.length > 0) {
              user.location_name = locInfo.rows[0].name;
            }
          }
        }

        // Create audit log
        await db.query(
          `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
           VALUES ($1, 'user.updated', 'user', $2, $3)`,
          [req.user.id, userId, JSON.stringify(req.body)]
        );
        
        logger.info(`[USER UPDATE] User ${userId} updated successfully. BU: ${user.business_unit_id}, Location: ${user.location_id}`);
        res.json(user);
      }
    } catch (error) {
      logger.error('Update user error:', error);
      next(error);
    }
  }
);

// DELETE /api/v1/users/:id
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const userId = req.params.id;

    // Soft delete
    const result = await db.query(
      'UPDATE users SET is_active = false WHERE id = $1 RETURNING id',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'User not found'
        }
      });
    }

    // Create audit log
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES ($1, 'user.deleted', 'user', $2, $3)`,
      [req.user.id, userId, JSON.stringify({ soft_delete: true })]
    );

    res.json({
      message: 'User deleted successfully'
    });
  } catch (error) {
    logger.error('Delete user error:', error);
    next(error);
  }
});

module.exports = router;

