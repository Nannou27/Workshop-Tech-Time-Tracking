const jwt = require('jsonwebtoken');
const db = require('../database/connection');
const logger = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

// Verify JWT token
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: {
          code: 'AUTHENTICATION_FAILED',
          message: 'No token provided'
        }
      });
    }

    const token = authHeader.substring(7);
    
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Verify user still exists and is active
      const dbType = process.env.DB_TYPE || 'postgresql';
      const placeholder = dbType === 'mysql' ? '?' : '$1';
      const userResult = await db.query(
        `SELECT u.id, u.email, u.display_name, u.role_id, u.is_active, u.business_unit_id, r.name as role_name
         FROM users u
         LEFT JOIN roles r ON u.role_id = r.id
         WHERE u.id = ${placeholder}`,
        [decoded.userId]
      );

      if (userResult.rows.length === 0) {
        return res.status(401).json({
          error: {
            code: 'AUTHENTICATION_FAILED',
            message: 'User not found'
          }
        });
      }

      const user = userResult.rows[0];

      if (!user.is_active) {
        return res.status(403).json({
          error: {
            code: 'AUTHORIZATION_FAILED',
            message: 'User account is inactive'
          }
        });
      }

      // Attach user to request
      req.user = {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        roleId: user.role_id,
        roleName: user.role_name,
        businessUnitId: user.business_unit_id
      };

      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          error: {
            code: 'TOKEN_EXPIRED',
            message: 'Token has expired'
          }
        });
      }
      throw error;
    }
  } catch (error) {
    logger.error('Authentication error:', error);
    return res.status(401).json({
      error: {
        code: 'AUTHENTICATION_FAILED',
        message: 'Invalid token'
      }
    });
  }
};

// Check if user has required permission
const authorize = (requiredPermission) => {
  return async (req, res, next) => {
    try {
      // Get user's role and permissions
      const roleResult = await db.query(
        'SELECT permissions FROM roles WHERE id = $1',
        [req.user.roleId]
      );

      if (roleResult.rows.length === 0) {
        return res.status(403).json({
          error: {
            code: 'AUTHORIZATION_FAILED',
            message: 'Role not found'
          }
        });
      }

      const permissions = roleResult.rows[0].permissions;
      
      // Check permission (simplified - adjust based on your permission structure)
      // Permission format: { resource: ['action1', 'action2'] }
      const [resource, action] = requiredPermission.split('.');
      
      if (!permissions[resource] || !permissions[resource].includes(action)) {
        return res.status(403).json({
          error: {
            code: 'AUTHORIZATION_FAILED',
            message: 'Insufficient permissions'
          }
        });
      }

      next();
    } catch (error) {
      logger.error('Authorization error:', error);
      return res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Authorization check failed'
        }
      });
    }
  };
};

// Check if user is admin (Super Admin or Business Unit Admin)
const requireAdmin = async (req, res, next) => {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    const roleResult = await db.query(
      `SELECT name FROM roles WHERE id = ${placeholder}`,
      [req.user.roleId]
    );

    if (roleResult.rows.length === 0) {
      return res.status(403).json({
        error: {
          code: 'AUTHORIZATION_FAILED',
          message: 'Role not found'
        }
      });
    }

    const roleName = roleResult.rows[0].name;
    // "Admin" is a full system admin role (distinct from Super Admin in some deployments)
    const adminRoles = ['Super Admin', 'Business Unit Admin', 'Admin'];

    if (!adminRoles.includes(roleName)) {
      return res.status(403).json({
        error: {
          code: 'AUTHORIZATION_FAILED',
          message: 'Admin access required'
        }
      });
    }

    next();
  } catch (error) {
    logger.error('Admin check error:', error);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Authorization check failed'
      }
    });
  }
};

// Check if user is Super Admin
const requireSuperAdmin = async (req, res, next) => {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    const roleResult = await db.query(
      `SELECT name FROM roles WHERE id = ${placeholder}`,
      [req.user.roleId]
    );

    if (roleResult.rows.length === 0 || roleResult.rows[0].name !== 'Super Admin') {
      return res.status(403).json({
        error: {
          code: 'AUTHORIZATION_FAILED',
          message: 'Super Admin access required'
        }
      });
    }

    next();
  } catch (error) {
    logger.error('Super Admin check error:', error);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Authorization check failed'
      }
    });
  }
};

// Check if user is admin or service advisor (can manage users/technicians in their BU)
const requireAdminOrServiceAdvisor = async (req, res, next) => {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    const roleResult = await db.query(
      `SELECT name FROM roles WHERE id = ${placeholder}`,
      [req.user.roleId]
    );

    if (roleResult.rows.length === 0) {
      return res.status(403).json({
        error: {
          code: 'AUTHORIZATION_FAILED',
          message: 'Role not found'
        }
      });
    }

    const roleName = roleResult.rows[0].name;
    const allowedRoles = ['Super Admin', 'Business Unit Admin', 'ServiceAdvisor', 'Service Advisor'];

    if (!allowedRoles.includes(roleName)) {
      return res.status(403).json({
        error: {
          code: 'AUTHORIZATION_FAILED',
          message: 'Admin or Service Advisor access required'
        }
      });
    }

    next();
  } catch (error) {
    logger.error('Admin/ServiceAdvisor check error:', error);
    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Authorization check failed'
      }
    });
  }
};

// Check if user can manage a specific Business Unit
const canManageBusinessUnit = async (userId, businessUnitId) => {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const placeholder = dbType === 'mysql' ? '?' : '$1';
    const userResult = await db.query(
      `SELECT u.id, u.role_id, u.business_unit_id, r.name as role_name
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.id = ${placeholder}`,
      [userId]
    );

    if (userResult.rows.length === 0) return false;
    const user = userResult.rows[0];

    // Super Admin can manage all BUs
    if (user.role_name === 'Super Admin') {
      return true;
    }

    // Business Unit Admin can only manage their own BU
    if (user.role_name === 'Business Unit Admin' && user.business_unit_id === businessUnitId) {
      return true;
    }

    return false;
  } catch (error) {
    logger.error('Error checking BU permissions:', error);
    return false;
  }
};

module.exports = {
  authenticate,
  authorize,
  requireAdmin,
  requireSuperAdmin,
  requireAdminOrServiceAdvisor,
  canManageBusinessUnit
};

