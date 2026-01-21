const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  logger.error('Error:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    body: req.body
  });

  // Database errors
  if (err.code === '23505') { // Unique violation
    return res.status(409).json({
      error: {
        code: 'RESOURCE_CONFLICT',
        message: 'Resource already exists',
        details: err.detail
      }
    });
  }

  if (err.code === '23503') { // Foreign key violation
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid reference',
        details: err.detail
      }
    });
  }

  // MySQL database errors (mysql2)
  // Convert common SQL errors into clear client-facing 4xx responses (so UI does not show a generic 500).
  if (typeof err.code === 'string' && err.code.startsWith('ER_')) {
    // Missing table / column (schema drift)
    if (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(400).json({
        error: {
          code: 'SCHEMA_MISMATCH',
          message: 'Database schema is missing required table/column for this operation',
          details: err.sqlMessage || err.message
        }
      });
    }

    // Duplicate key / unique constraint
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        error: {
          code: 'RESOURCE_CONFLICT',
          message: 'Resource already exists',
          details: err.sqlMessage || err.message
        }
      });
    }

    // Missing required field (e.g. NOT NULL)
    if (err.code === 'ER_BAD_NULL_ERROR' || err.code === 'ER_NO_DEFAULT_FOR_FIELD') {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Missing required field',
          details: err.sqlMessage || err.message
        }
      });
    }

    // Foreign key problems
    if (err.code === 'ER_NO_REFERENCED_ROW_2' || err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid reference',
          details: err.sqlMessage || err.message
        }
      });
    }

    // Bad data / truncation
    if (err.code === 'ER_DATA_TOO_LONG' || err.code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD') {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid field value',
          details: err.sqlMessage || err.message
        }
      });
    }

    // SQL parse / syntax errors (often caused by schema drift or DB-specific syntax differences)
    if (err.code === 'ER_PARSE_ERROR' || err.code === 'ER_SYNTAX_ERROR') {
      return res.status(400).json({
        error: {
          code: 'QUERY_ERROR',
          message: 'Database query is not compatible with this database/version',
          details: err.sqlMessage || err.message
        }
      });
    }
  }

  // Validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: err.errors
      }
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      error: {
        code: 'AUTHENTICATION_FAILED',
        message: 'Invalid token'
      }
    });
  }

  // Default error
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal server error';
  const isServerError = statusCode >= 500;
  const safeMessage = process.env.NODE_ENV === 'production' && isServerError ? 'An error occurred' : message;

  res.status(statusCode).json({
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: safeMessage,
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
    },
    request_id: req.id || 'unknown'
  });
};

module.exports = errorHandler;






