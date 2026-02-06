const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_ACCESS_EXPIRY = parseInt(process.env.JWT_ACCESS_EXPIRY) || 900; // 15 minutes
const JWT_REFRESH_EXPIRY = parseInt(process.env.JWT_REFRESH_EXPIRY) || 604800; // 7 days

// Generate tokens
const generateTokens = (userId) => {
  const accessToken = jwt.sign(
    { userId, type: 'access' },
    JWT_SECRET,
    { expiresIn: JWT_ACCESS_EXPIRY }
  );

  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRY }
  );

  return { accessToken, refreshToken };
};

// POST /api/v1/auth/login
router.post('/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
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

      const { email, password } = req.body;

      // Find user
      const userResult = await db.query(
        `SELECT u.id, u.email, u.display_name, u.password_hash, u.role_id, u.is_active,
                u.business_unit_id, u.location_id,
                r.name as role_name
         FROM users u
         JOIN roles r ON u.role_id = r.id
         WHERE u.email = $1`,
        [email]
      );

      if (userResult.rows.length === 0) {
        return res.status(401).json({
          error: {
            code: 'AUTHENTICATION_FAILED',
            message: 'Invalid credentials'
          }
        });
      }

      const user = userResult.rows[0];

      if (!user.is_active) {
        return res.status(403).json({
          error: {
            code: 'AUTHORIZATION_FAILED',
            message: 'Account is inactive'
          }
        });
      }

      // Verify password (if local auth)
      if (user.password_hash) {
        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
          return res.status(401).json({
            error: {
              code: 'AUTHENTICATION_FAILED',
              message: 'Invalid credentials'
            }
          });
        }
      } else {
        // SSO-only user
        return res.status(401).json({
          error: {
            code: 'AUTHENTICATION_FAILED',
            message: 'SSO authentication required'
          }
        });
      }

      // Update last login
      await db.query(
        'UPDATE users SET last_login_at = now() WHERE id = $1',
        [user.id]
      );

      // Generate tokens
      const { accessToken, refreshToken } = generateTokens(user.id);

      // Create audit log
      await db.query(
        `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details, ip_address)
         VALUES ($1, 'user.login', 'user', $2, $3, $4)`,
        [user.id, user.id, JSON.stringify({ email: user.email }), req.ip]
      );

      res.json({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: JWT_ACCESS_EXPIRY,
        token_type: 'Bearer',
        user: {
          id: user.id,
          email: user.email,
          display_name: user.display_name,
          business_unit_id: user.business_unit_id || null,
          location_id: user.location_id || null,
          role: {
            id: user.role_id,
            name: user.role_name
          }
        }
      });
    } catch (error) {
      logger.error('Login error:', error);
      next(error);
    }
  }
);

// POST /api/v1/auth/refresh
router.post('/refresh',
  [
    body('refresh_token').notEmpty()
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

      const { refresh_token } = req.body;

      try {
        const decoded = jwt.verify(refresh_token, JWT_SECRET);
        
        if (decoded.type !== 'refresh') {
          return res.status(401).json({
            error: {
              code: 'AUTHENTICATION_FAILED',
              message: 'Invalid token type'
            }
          });
        }

        // Verify user still exists and is active
        const userResult = await db.query(
          'SELECT id, is_active FROM users WHERE id = $1',
          [decoded.userId]
        );

        if (userResult.rows.length === 0 || !userResult.rows[0].is_active) {
          return res.status(401).json({
            error: {
              code: 'AUTHENTICATION_FAILED',
              message: 'User not found or inactive'
            }
          });
        }

        // Generate new access token
        const accessToken = jwt.sign(
          { userId: decoded.userId, type: 'access' },
          JWT_SECRET,
          { expiresIn: JWT_ACCESS_EXPIRY }
        );

        res.json({
          access_token: accessToken,
          expires_in: JWT_ACCESS_EXPIRY,
          token_type: 'Bearer'
        });
      } catch (error) {
        if (error.name === 'TokenExpiredError') {
          return res.status(401).json({
            error: {
              code: 'TOKEN_EXPIRED',
              message: 'Refresh token has expired'
            }
          });
        }
        throw error;
      }
    } catch (error) {
      logger.error('Refresh error:', error);
      next(error);
    }
  }
);

// POST /api/v1/auth/logout
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    // In a production system, you might want to blacklist the refresh token
    // For now, we'll just return success
    res.json({
      message: 'Logged out successfully'
    });
  } catch (error) {
    logger.error('Logout error:', error);
    next(error);
  }
});

// NOTE: Demo account listing is intentionally disabled in production to avoid "demo" workflows/data exposure.
router.get('/demo-accounts', async (req, res, next) => {
  try {
    if ((process.env.NODE_ENV || 'development') === 'production') {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Resource not found' }
      });
    }
    const dbType = process.env.DB_TYPE || 'postgresql';
    
    // Check if business_units table exists
    let query;
    try {
      const tableCheck = await db.query(
        dbType === 'mysql'
          ? `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'business_units'`
          : `SELECT table_name FROM information_schema.tables WHERE table_name = 'business_units'`
      );
      
      if (tableCheck.rows.length > 0) {
        query = `
          SELECT u.email, u.display_name, r.name as role_name, bu.name as business_unit_name
          FROM users u
          JOIN roles r ON u.role_id = r.id
          LEFT JOIN business_units bu ON u.business_unit_id = bu.id
          WHERE u.is_active = true
          ORDER BY 
            CASE r.name
              WHEN 'Super Admin' THEN 1
              WHEN 'Business Unit Admin' THEN 2
              WHEN 'ServiceAdvisor' THEN 3
              WHEN 'Service Advisor' THEN 3
              WHEN 'Technician' THEN 4
              ELSE 5
            END,
            u.email
        `;
      } else {
        query = `
          SELECT u.email, u.display_name, r.name as role_name, NULL as business_unit_name
          FROM users u
          JOIN roles r ON u.role_id = r.id
          WHERE u.is_active = true
          ORDER BY 
            CASE r.name
              WHEN 'Super Admin' THEN 1
              WHEN 'Business Unit Admin' THEN 2
              WHEN 'ServiceAdvisor' THEN 3
              WHEN 'Service Advisor' THEN 3
              WHEN 'Technician' THEN 4
              ELSE 5
            END,
            u.email
        `;
      }
    } catch (e) {
      query = `
        SELECT u.email, u.display_name, r.name as role_name, NULL as business_unit_name
        FROM users u
        JOIN roles r ON u.role_id = r.id
        WHERE u.is_active = true
        ORDER BY r.name, u.email
      `;
    }
    
    const result = await db.query(query);
    
    // Group by role for better UI display
    const grouped = {};
    result.rows.forEach(user => {
      const role = user.role_name;
      if (!grouped[role]) {
        grouped[role] = [];
      }
      grouped[role].push({
        email: user.email,
        display_name: user.display_name,
        business_unit: user.business_unit_name
      });
    });
    
    res.json({
      accounts: result.rows,
      grouped: grouped
    });
  } catch (error) {
    logger.error('Demo accounts error:', error);
    next(error);
  }
});

// GET /api/v1/auth/me
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const userResult = await db.query(
      `SELECT u.id, u.email, u.display_name, u.role_id, u.is_active, u.created_at,
              r.name as role_name, r.permissions
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.id = $1`,
      [req.user.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'User not found'
        }
      });
    }

    const user = userResult.rows[0];

    res.json({
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      role: {
        id: user.role_id,
        name: user.role_name,
        permissions: user.permissions
      },
      is_active: user.is_active,
      created_at: user.created_at
    });
  } catch (error) {
    logger.error('Get me error:', error);
    next(error);
  }
});

// POST /api/v1/auth/forgot-password (NON-PROD)
router.post('/forgot-password',
  [body('email').isEmail().normalizeEmail()],
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

      const { email } = req.body;
      const dbType = process.env.DB_TYPE || 'postgresql';

      // Find user
      const userResult = await db.query(
        dbType === 'mysql'
          ? 'SELECT id, email, metadata FROM users WHERE email = ?'
          : 'SELECT id, email, metadata FROM users WHERE email = $1',
        [email]
      );

      // Always return 200 to prevent user enumeration
      if (userResult.rows.length > 0) {
        const user = userResult.rows[0];
        const crypto = require('crypto');
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetExpiry = Date.now() + 30 * 60 * 1000; // 30 minutes

        // Update metadata with reset token
        const metadata = typeof user.metadata === 'string' 
          ? JSON.parse(user.metadata) 
          : (user.metadata || {});
        
        metadata.password_reset_token = resetToken;
        metadata.password_reset_expiry = resetExpiry;

        await db.query(
          dbType === 'mysql'
            ? 'UPDATE users SET metadata = ? WHERE id = ?'
            : 'UPDATE users SET metadata = $1 WHERE id = $2',
          dbType === 'mysql'
            ? [JSON.stringify(metadata), user.id]
            : [metadata, user.id]
        );

        // Log reset link to console (no real email in non-prod)
        const resetLink = `http://localhost:3000/reset-password.html?token=${resetToken}`;
        console.log('\n========================================');
        console.log('PASSWORD RESET REQUEST (NON-PROD)');
        console.log('========================================');
        console.log(`User: ${user.email}`);
        console.log(`Reset Link: ${resetLink}`);
        console.log(`Expires: ${new Date(resetExpiry).toISOString()}`);
        console.log('========================================\n');
      }

      res.json({
        message: 'If an account exists with that email, a password reset link has been sent.'
      });
    } catch (error) {
      logger.error('Forgot password error:', error);
      next(error);
    }
  }
);

// POST /api/v1/auth/reset-password (NON-PROD)
router.post('/reset-password',
  [
    body('token').notEmpty(),
    body('new_password').isLength({ min: 12 })
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

      const { token, new_password } = req.body;
      const dbType = process.env.DB_TYPE || 'postgresql';

      // Find user by token
      const users = await db.query(
        'SELECT id, email, metadata FROM users'
      );

      let targetUser = null;
      for (const user of users.rows) {
        const metadata = typeof user.metadata === 'string' 
          ? JSON.parse(user.metadata) 
          : (user.metadata || {});
        
        if (metadata.password_reset_token === token) {
          targetUser = { ...user, parsedMetadata: metadata };
          break;
        }
      }

      if (!targetUser) {
        return res.status(400).json({
          error: {
            code: 'INVALID_TOKEN',
            message: 'Invalid or expired reset token'
          }
        });
      }

      // Check token expiry
      if (!targetUser.parsedMetadata.password_reset_expiry || 
          Date.now() > targetUser.parsedMetadata.password_reset_expiry) {
        return res.status(400).json({
          error: {
            code: 'TOKEN_EXPIRED',
            message: 'Reset token has expired'
          }
        });
      }

      // Hash new password
      const passwordHash = await bcrypt.hash(new_password, 10);

      // Validate hash format
      if (!passwordHash || !passwordHash.startsWith('$2')) {
        throw new Error('Password hashing failed');
      }

      // Clear reset token and update password
      delete targetUser.parsedMetadata.password_reset_token;
      delete targetUser.parsedMetadata.password_reset_expiry;

      const updateResult = await db.query(
        dbType === 'mysql'
          ? 'UPDATE users SET password_hash = ?, metadata = ? WHERE id = ?'
          : 'UPDATE users SET password_hash = $1, metadata = $2 WHERE id = $3',
        dbType === 'mysql'
          ? [passwordHash, JSON.stringify(targetUser.parsedMetadata), targetUser.id]
          : [passwordHash, targetUser.parsedMetadata, targetUser.id]
      );

      // Verify update succeeded
      const affectedRows = dbType === 'mysql' ? updateResult.rows.affectedRows : updateResult.rowCount;
      if (affectedRows === 0) {
        throw new Error('Failed to update password - no rows affected');
      }

      // Verify password_hash was actually set
      const verifyResult = await db.query(
        dbType === 'mysql'
          ? 'SELECT password_hash FROM users WHERE id = ?'
          : 'SELECT password_hash FROM users WHERE id = $1',
        [targetUser.id]
      );

      if (!verifyResult.rows[0]?.password_hash || !verifyResult.rows[0].password_hash.startsWith('$2')) {
        throw new Error('Password verification failed after update');
      }

      logger.info(`[AUTH] password_hash updated for user_id=${targetUser.id}`);

      // Create audit log
      if (dbType === 'mysql') {
        await db.query(
          `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
           VALUES (?, 'password.reset', 'user', ?, ?)`,
          [targetUser.id, targetUser.id, JSON.stringify({ email: targetUser.email })]
        );
      } else {
        await db.query(
          `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
           VALUES ($1, 'password.reset', 'user', $2, $3)`,
          [targetUser.id, targetUser.id, JSON.stringify({ email: targetUser.email })]
        );
      }

      res.json({
        message: 'Password has been reset successfully'
      });
    } catch (error) {
      logger.error('Reset password error:', error);
      next(error);
    }
  }
);

// POST /api/v1/auth/change-password
router.post('/change-password',
  authenticate,
  [
    body('current_password').notEmpty(),
    body('new_password').isLength({ min: 12 })
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

      const { current_password, new_password } = req.body;
      const dbType = process.env.DB_TYPE || 'postgresql';

      // Get user's current password hash
      const userResult = await db.query(
        dbType === 'mysql'
          ? 'SELECT id, email, password_hash FROM users WHERE id = ?'
          : 'SELECT id, email, password_hash FROM users WHERE id = $1',
        [req.user.id]
      );

      if (userResult.rows.length === 0) {
        return res.status(404).json({
          error: {
            code: 'RESOURCE_NOT_FOUND',
            message: 'User not found'
          }
        });
      }

      const user = userResult.rows[0];

      // Verify current password
      if (!user.password_hash) {
        return res.status(400).json({
          error: {
            code: 'SSO_USER',
            message: 'SSO users cannot change password'
          }
        });
      }

      const isValid = await bcrypt.compare(current_password, user.password_hash);
      if (!isValid) {
        return res.status(401).json({
          error: {
            code: 'INVALID_PASSWORD',
            message: 'Current password is incorrect'
          }
        });
      }

      // Hash new password
      const passwordHash = await bcrypt.hash(new_password, 10);

      // Validate hash format
      if (!passwordHash || !passwordHash.startsWith('$2')) {
        throw new Error('Password hashing failed');
      }

      // Update password
      const updateResult = await db.query(
        dbType === 'mysql'
          ? 'UPDATE users SET password_hash = ? WHERE id = ?'
          : 'UPDATE users SET password_hash = $1 WHERE id = $2',
        dbType === 'mysql'
          ? [passwordHash, user.id]
          : [passwordHash, user.id]
      );

      // Verify update succeeded
      if (updateResult.rowCount === 0) {
        throw new Error('Failed to update password - no rows affected');
      }

      // Verify password_hash was actually set
      const verifyResult = await db.query(
        dbType === 'mysql'
          ? 'SELECT password_hash FROM users WHERE id = ?'
          : 'SELECT password_hash FROM users WHERE id = $1',
        [user.id]
      );

      if (!verifyResult.rows[0]?.password_hash || !verifyResult.rows[0].password_hash.startsWith('$2')) {
        throw new Error('Password verification failed after update');
      }

      logger.info(`[AUTH] password_hash updated for user_id=${user.id}`);

      // Create audit log
      if (dbType === 'mysql') {
        await db.query(
          `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
           VALUES (?, 'password.changed', 'user', ?, ?)`,
          [user.id, user.id, JSON.stringify({ email: user.email })]
        );
      } else {
        await db.query(
          `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
           VALUES ($1, 'password.changed', 'user', $2, $3)`,
          [user.id, user.id, JSON.stringify({ email: user.email })]
        );
      }

      res.json({
        message: 'Password changed successfully'
      });
    } catch (error) {
      logger.error('Change password error:', error);
      next(error);
    }
  }
);

module.exports = router;



