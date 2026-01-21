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

module.exports = router;



