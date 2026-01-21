const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireAdmin, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);
// GET routes require admin access, POST/PATCH/DELETE require Super Admin (set per route)
// router.use(requireAdmin);  // Removed - will add per route

// GET /api/v1/roles
// Allow all authenticated users to view roles (needed for dropdowns)
router.get('/', async (req, res, next) => {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const queryText = 'SELECT id, name, description, permissions, is_system_role, created_at, updated_at FROM roles ORDER BY is_system_role DESC, name ASC';
    
    const result = await db.query(queryText);
    
    res.json({
      data: result.rows
    });
  } catch (error) {
    logger.error('Get roles error:', error);
    next(error);
  }
});

// GET /api/v1/roles/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    
    const queryText = `SELECT id, name, description, permissions, is_system_role, created_at, updated_at FROM roles WHERE id = ${placeholder}`;
    const result = await db.query(queryText, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'Role not found'
        }
      });
    }
    
    res.json({
      data: result.rows[0]
    });
  } catch (error) {
    logger.error('Get role error:', error);
    next(error);
  }
});

// POST /api/v1/roles
router.post('/',
  requireSuperAdmin,
  [
    body('name').trim().notEmpty().isLength({ min: 2, max: 50 }),
    body('description').optional().trim(),
    body('permissions').isObject()
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

      const { name, description, permissions } = req.body;
      const dbType = process.env.DB_TYPE || 'postgresql';

      // Check if role name already exists
      const placeholder = dbType === 'mysql' ? '?' : '$1';
      const checkResult = await db.query(
        `SELECT id FROM roles WHERE name = ${placeholder}`,
        [name]
      );

      if (checkResult.rows.length > 0) {
        return res.status(409).json({
          error: {
            code: 'RESOURCE_CONFLICT',
            message: 'Role with this name already exists'
          }
        });
      }

      // Insert new role
      if (dbType === 'mysql') {
        const insertQuery = `
          INSERT INTO roles (name, description, permissions, is_system_role)
          VALUES (?, ?, ?, false)
        `;
        const permissionsJson = JSON.stringify(permissions);
        await db.query(insertQuery, [name, description || null, permissionsJson]);
        
        // Get the inserted role
        const selectResult = await db.query(
          'SELECT id, name, description, permissions, is_system_role, created_at, updated_at FROM roles WHERE name = ?',
          [name]
        );
        
        res.status(201).json({
          data: selectResult.rows[0]
        });
      } else {
        const insertQuery = `
          INSERT INTO roles (name, description, permissions, is_system_role)
          VALUES ($1, $2, $3, false)
          RETURNING id, name, description, permissions, is_system_role, created_at, updated_at
        `;
        const result = await db.query(insertQuery, [name, description || null, JSON.stringify(permissions)]);
        
        res.status(201).json({
          data: result.rows[0]
        });
      }
    } catch (error) {
      logger.error('Create role error:', error);
      next(error);
    }
  }
);

// PATCH /api/v1/roles/:id
router.patch('/:id',
  requireSuperAdmin,
  [
    body('name').optional().trim().isLength({ min: 2, max: 50 }),
    body('description').optional().trim(),
    body('permissions').optional().isObject()
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

      const { id } = req.params;
      const { name, description, permissions } = req.body;
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$1';

      // Check if role exists
      const checkResult = await db.query(
        `SELECT id, is_system_role FROM roles WHERE id = ${placeholder}`,
        [id]
      );

      if (checkResult.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: 'Role not found'
          }
        });
      }

      const role = checkResult.rows[0];

      // Allow editing system roles (name, description, permissions) but prevent deletion
      // System roles can be edited to update permissions, but deletion is still blocked

      // Check if name already exists (if name is being changed)
      if (name) {
        const nameCheckResult = await db.query(
          `SELECT id FROM roles WHERE name = ${dbType === 'mysql' ? '?' : '$2'} AND id != ${placeholder}`,
          dbType === 'mysql' ? [name, id] : [id, name]
        );

        if (nameCheckResult.rows.length > 0) {
          return res.status(409).json({
            error: {
              code: 'RESOURCE_CONFLICT',
              message: 'Role with this name already exists'
            }
          });
        }
      }

      // Build update query
      const updates = [];
      const params = [];
      let paramCount = 0;

      if (name) {
        paramCount++;
        updates.push(`name = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(name);
      }

      if (description !== undefined) {
        paramCount++;
        updates.push(`description = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(description || null);
      }

      if (permissions) {
        paramCount++;
        updates.push(`permissions = ${dbType === 'mysql' ? '?' : `$${paramCount}`}`);
        params.push(dbType === 'mysql' ? JSON.stringify(permissions) : JSON.stringify(permissions));
      }

      if (updates.length === 0) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'No fields to update'
          }
        });
      }

      paramCount++;
      params.push(id);

      if (dbType === 'mysql') {
        const updateQuery = `
          UPDATE roles 
          SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `;
        await db.query(updateQuery, params);
        
        // Get the updated role
        const selectResult = await db.query(
          'SELECT id, name, description, permissions, is_system_role, created_at, updated_at FROM roles WHERE id = ?',
          [id]
        );
        
        res.json({
          data: selectResult.rows[0]
        });
      } else {
        const updateQuery = `
          UPDATE roles 
          SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
          WHERE id = $${paramCount}
          RETURNING id, name, description, permissions, is_system_role, created_at, updated_at
        `;
        const result = await db.query(updateQuery, params);
        
        res.json({
          data: result.rows[0]
        });
      }
    } catch (error) {
      logger.error('Update role error:', error);
      next(error);
    }
  }
);

// DELETE /api/v1/roles/:id
router.delete('/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';

    // Check if role exists and is system role
    const checkResult = await db.query(
      `SELECT id, is_system_role FROM roles WHERE id = ${placeholder}`,
      [id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'Role not found'
        }
      });
    }

    if (checkResult.rows[0].is_system_role) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Cannot delete system roles'
        }
      });
    }

    // Check if any users are using this role
    const usersResult = await db.query(
      `SELECT COUNT(*) as count FROM users WHERE role_id = ${placeholder}`,
      [id]
    );

    const userCount = dbType === 'mysql' 
      ? parseInt(usersResult.rows[0].count)
      : parseInt(usersResult.rows[0].count);

    if (userCount > 0) {
      return res.status(409).json({
        error: {
          code: 'RESOURCE_CONFLICT',
          message: `Cannot delete role: ${userCount} user(s) are assigned to this role`
        }
      });
    }

    // Delete the role
    await db.query(
      `DELETE FROM roles WHERE id = ${placeholder}`,
      [id]
    );

    res.json({
      message: 'Role deleted successfully'
    });
  } catch (error) {
    logger.error('Delete role error:', error);
    next(error);
  }
});

module.exports = router;

