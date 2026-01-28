const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(authenticate);

// Ensure new/extended work order fields are present in the reference table so BU Admin can configure them.
async function ensureWorkOrderReferenceFields() {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';

    // If reference table doesn't exist, nothing to do (feature not installed yet)
    const tableCheck = dbType === 'mysql'
      ? await db.query(`SHOW TABLES LIKE 'work_order_sections_reference'`)
      : await db.query(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'work_order_sections_reference') as exists`);
    const refExists = dbType === 'mysql' ? (tableCheck.rows.length > 0) : !!tableCheck.rows?.[0]?.exists;
    if (!refExists) return;

    const fields = [
      {
        section_name: 'work_order_details',
        section_display_name: 'Work Order Details',
        section_order: 3,
        field_name: 'bike_condition_review',
        field_display_name: 'Bike Condition Review',
        field_type: 'textarea',
        field_order: 6,
        default_visibility: true,
        default_required: false,
        validation_rules: null,
        options: null,
        help_text: 'Record current bike condition (shown in plate history).'
      },
      {
        section_name: 'work_order_details',
        section_display_name: 'Work Order Details',
        section_order: 3,
        field_name: 'job_category',
        field_display_name: 'Job Category',
        field_type: 'select',
        field_order: 7,
        default_visibility: true,
        default_required: false,
        validation_rules: null,
        options: [{ value: 'service', label: 'Service' }, { value: 'complaint', label: 'Complaint' }],
        help_text: 'Classify as Service or Complaint.'
      },
      {
        section_name: 'work_order_details',
        section_display_name: 'Work Order Details',
        section_order: 3,
        field_name: 'previous_job_number',
        field_display_name: 'Previous Job Card Number',
        field_type: 'text',
        field_order: 8,
        default_visibility: true,
        default_required: false,
        validation_rules: null,
        options: null,
        help_text: 'Link to a previous job card number for reference.'
      }
    ];

    for (const f of fields) {
      if (dbType === 'mysql') {
        await db.query(
          `INSERT INTO work_order_sections_reference
           (section_name, section_display_name, section_order, field_name, field_display_name, field_type, field_order, default_visibility, default_required, validation_rules, options, help_text)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             section_display_name = VALUES(section_display_name),
             section_order = VALUES(section_order),
             field_display_name = VALUES(field_display_name),
             field_type = VALUES(field_type),
             field_order = VALUES(field_order),
             default_visibility = VALUES(default_visibility),
             default_required = VALUES(default_required),
             validation_rules = VALUES(validation_rules),
             options = VALUES(options),
             help_text = VALUES(help_text),
             updated_at = CURRENT_TIMESTAMP`,
          [
            f.section_name,
            f.section_display_name,
            f.section_order,
            f.field_name,
            f.field_display_name,
            f.field_type,
            f.field_order,
            !!f.default_visibility,
            !!f.default_required,
            f.validation_rules ? JSON.stringify(f.validation_rules) : null,
            f.options ? JSON.stringify(f.options) : null,
            f.help_text || null
          ]
        );
      } else {
        await db.query(
          `INSERT INTO work_order_sections_reference
           (section_name, section_display_name, section_order, field_name, field_display_name, field_type, field_order, default_visibility, default_required, validation_rules, options, help_text)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (section_name, field_name) DO UPDATE SET
             section_display_name = EXCLUDED.section_display_name,
             section_order = EXCLUDED.section_order,
             field_display_name = EXCLUDED.field_display_name,
             field_type = EXCLUDED.field_type,
             field_order = EXCLUDED.field_order,
             default_visibility = EXCLUDED.default_visibility,
             default_required = EXCLUDED.default_required,
             validation_rules = EXCLUDED.validation_rules,
             options = EXCLUDED.options,
             help_text = EXCLUDED.help_text,
             updated_at = now()`,
          [
            f.section_name,
            f.section_display_name,
            f.section_order,
            f.field_name,
            f.field_display_name,
            f.field_type,
            f.field_order,
            !!f.default_visibility,
            !!f.default_required,
            f.validation_rules || null,
            f.options || null,
            f.help_text || null
          ]
        );
      }
    }
  } catch (error) {
    // Don't block page load if seeding fails; just log.
    logger.warn('ensureWorkOrderReferenceFields failed:', error);
  }
}

// Helper: Check if user is Super Admin or BU Admin for the specified BU
async function canManageBU(userId, businessUnitId) {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const userResult = await db.query(
      `SELECT u.id, u.role_id, r.name as role_name, u.business_unit_id
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.id = ${dbType === 'mysql' ? '?' : '$1'}`,
      [userId]
    );

    if (userResult.rows.length === 0) return false;
    const user = userResult.rows[0];

    // Super Admin can manage all BUs
    if (user.role_name === 'Super Admin') {
      return true;
    }

    // BU Admin can only manage their own BU
    if (user.role_name === 'Business Unit Admin' && user.business_unit_id === businessUnitId) {
      return true;
    }

    return false;
  } catch (error) {
    logger.error('Error checking BU permissions:', error);
    return false;
  }
}

// GET /api/v1/field-visibility/sections
// Get all available sections and fields (reference data)
router.get('/sections', async (req, res, next) => {
  try {
    await ensureWorkOrderReferenceFields();
    const dbType = process.env.DB_TYPE || 'postgresql';
    const result = await db.query(
      `SELECT * FROM work_order_sections_reference
       ORDER BY section_order, field_order`
    );

    // Group by section
    const sections = {};
    result.rows.forEach(row => {
      if (!sections[row.section_name]) {
        sections[row.section_name] = {
          section_name: row.section_name,
          section_display_name: row.section_display_name,
          section_order: row.section_order,
          fields: []
        };
      }
      sections[row.section_name].fields.push({
        field_name: row.field_name,
        field_display_name: row.field_display_name,
        field_type: row.field_type,
        field_order: row.field_order,
        default_visibility: row.default_visibility,
        default_required: row.default_required,
        validation_rules: typeof row.validation_rules === 'string' ? JSON.parse(row.validation_rules) : row.validation_rules,
        options: typeof row.options === 'string' ? JSON.parse(row.options) : row.options,
        help_text: row.help_text
      });
    });

    res.json({
      data: Object.values(sections)
    });
  } catch (error) {
    logger.error('Get sections error:', error);
    next(error);
  }
});

// These fields should be non-mandatory by default, but BU Admins can explicitly mark them required.
// We only override the *default* (when there is no BU-specific visibility setting row).
const DEFAULT_NON_REQUIRED = new Set([
  'customer_info.customer_name',              // "Company Name"
  'work_order_details.work_type',             // "Work Type"
  'work_order_details.problem_description',   // "Complaint / Rider Issue"
  'location_assignment.location_id'           // "Location"
]);

// GET /api/v1/field-visibility/:business_unit_id
// Get field visibility settings for a specific Business Unit
router.get('/:business_unit_id', async (req, res, next) => {
  try {
    await ensureWorkOrderReferenceFields();
    const { business_unit_id } = req.params;
    const userId = req.user.id;

    // Check permissions
    const hasPermission = await canManageBU(userId, parseInt(business_unit_id));
    if (!hasPermission && !requireAdmin) {
      return res.status(403).json({
        error: {
          code: 'AUTHORIZATION_FAILED',
          message: 'You do not have permission to view settings for this Business Unit'
        }
      });
    }

    const dbType = process.env.DB_TYPE || 'postgresql';
    
    // Get visibility settings
    const visibilityResult = await db.query(
      `SELECT * FROM field_visibility_settings
       WHERE business_unit_id = ${dbType === 'mysql' ? '?' : '$1'}
       ORDER BY section_name, field_name`,
      [business_unit_id]
    );

    // Get reference sections
    const sectionsResult = await db.query(
      `SELECT * FROM work_order_sections_reference
       ORDER BY section_order, field_order`
    );

    // Merge reference data with visibility settings
    const sections = {};
    sectionsResult.rows.forEach(ref => {
      if (!sections[ref.section_name]) {
        sections[ref.section_name] = {
          section_name: ref.section_name,
          section_display_name: ref.section_display_name,
          section_order: ref.section_order,
          fields: []
        };
      }

      // Find visibility setting for this field
      const visibility = visibilityResult.rows.find(
        v => v.section_name === ref.section_name && v.field_name === ref.field_name
      );

      const fieldKey = `${ref.section_name}.${ref.field_name}`;
      const merged = {
        field_name: ref.field_name,
        field_display_name: visibility?.custom_label || ref.field_display_name,
        field_type: ref.field_type,
        field_order: ref.field_order,
        is_visible: visibility ? visibility.is_visible : ref.default_visibility,
        is_required: visibility ? visibility.is_required : ref.default_required,
        custom_label: visibility?.custom_label,
        custom_help_text: visibility?.custom_help_text || ref.help_text,
        validation_rules: typeof ref.validation_rules === 'string' ? JSON.parse(ref.validation_rules) : ref.validation_rules,
        options: typeof ref.options === 'string' ? JSON.parse(ref.options) : ref.options
      };

      // Default required=false for selected fields, unless BU explicitly overrides via field_visibility_settings.
      if (!visibility && DEFAULT_NON_REQUIRED.has(fieldKey)) {
        merged.is_required = false;
      }

      sections[ref.section_name].fields.push(merged);
    });

    res.json({
      data: {
        business_unit_id: parseInt(business_unit_id),
        sections: Object.values(sections)
      }
    });
  } catch (error) {
    logger.error('Get field visibility error:', error);
    next(error);
  }
});

// GET /api/v1/field-visibility/my-bu
// Get field visibility settings for the current user's Business Unit
router.get('/my-bu', async (req, res, next) => {
  try {
    await ensureWorkOrderReferenceFields();
    const userId = req.user.id;
    const dbType = process.env.DB_TYPE || 'postgresql';

    // Get user's business unit
    const userResult = await db.query(
      `SELECT business_unit_id FROM users WHERE id = ${dbType === 'mysql' ? '?' : '$1'}`,
      [userId]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].business_unit_id) {
      return res.status(404).json({
        error: {
          code: 'NO_BUSINESS_UNIT',
          message: 'User is not assigned to a Business Unit'
        }
      });
    }

    const businessUnitId = userResult.rows[0].business_unit_id;
    
    // Redirect to the specific BU endpoint
    req.params.business_unit_id = businessUnitId;
    return router.handle({ ...req, params: { business_unit_id: businessUnitId } }, res, next);
  } catch (error) {
    logger.error('Get my BU field visibility error:', error);
    next(error);
  }
});

// POST /api/v1/field-visibility/:business_unit_id
// Update field visibility settings for a Business Unit
router.post('/:business_unit_id',
  requireAdmin,
  [
    body('settings').isArray().withMessage('Settings must be an array'),
    body('settings.*.section_name').notEmpty(),
    body('settings.*.field_name').notEmpty(),
    body('settings.*.is_visible').isBoolean(),
    body('settings.*.is_required').isBoolean()
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

      const { business_unit_id } = req.params;
      const { settings } = req.body;
      const userId = req.user.id;

      // Check permissions
      const hasPermission = await canManageBU(userId, parseInt(business_unit_id));
      if (!hasPermission) {
        return res.status(403).json({
          error: {
            code: 'AUTHORIZATION_FAILED',
            message: 'You do not have permission to modify settings for this Business Unit'
          }
        });
      }

      const dbType = process.env.DB_TYPE || 'postgresql';
      const updated = [];

      for (const setting of settings) {
        const { section_name, field_name, is_visible, is_required, custom_label, custom_help_text } = setting;

        if (dbType === 'mysql') {
          await db.query(
            `INSERT INTO field_visibility_settings 
             (business_unit_id, section_name, field_name, is_visible, is_required, custom_label, custom_help_text, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               is_visible = VALUES(is_visible),
               is_required = VALUES(is_required),
               custom_label = VALUES(custom_label),
               custom_help_text = VALUES(custom_help_text),
               updated_by = VALUES(updated_by),
               updated_at = NOW()`,
            [business_unit_id, section_name, field_name, is_visible, is_required, custom_label || null, custom_help_text || null, userId, userId]
          );
        } else {
          await db.query(
            `INSERT INTO field_visibility_settings 
             (business_unit_id, section_name, field_name, is_visible, is_required, custom_label, custom_help_text, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (business_unit_id, section_name, field_name) DO UPDATE SET
               is_visible = EXCLUDED.is_visible,
               is_required = EXCLUDED.is_required,
               custom_label = EXCLUDED.custom_label,
               custom_help_text = EXCLUDED.custom_help_text,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()`,
            [business_unit_id, section_name, field_name, is_visible, is_required, custom_label || null, custom_help_text || null, userId, userId]
          );
        }

        updated.push({ section_name, field_name });
      }

      // Log audit
      await db.query(
        `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
         VALUES ($1, 'field_visibility.updated', 'business_unit', $2, $3)`,
        [userId, business_unit_id, JSON.stringify({ updated_fields: updated.length })]
      );

      res.json({
        message: 'Field visibility settings updated successfully',
        data: {
          business_unit_id: parseInt(business_unit_id),
          updated_count: updated.length
        }
      });
    } catch (error) {
      logger.error('Update field visibility error:', error);
      next(error);
    }
  }
);

// POST /api/v1/field-visibility/:business_unit_id/reset
// Reset field visibility settings to defaults for a Business Unit
router.post('/:business_unit_id/reset', requireAdmin, async (req, res, next) => {
  try {
    const { business_unit_id } = req.params;
    const userId = req.user.id;

    // Check permissions
    const hasPermission = await canManageBU(userId, parseInt(business_unit_id));
    if (!hasPermission) {
      return res.status(403).json({
        error: {
          code: 'AUTHORIZATION_FAILED',
          message: 'You do not have permission to reset settings for this Business Unit'
        }
      });
    }

    const dbType = process.env.DB_TYPE || 'postgresql';

    // Delete all custom settings (will fall back to defaults)
    await db.query(
      `DELETE FROM field_visibility_settings 
       WHERE business_unit_id = ${dbType === 'mysql' ? '?' : '$1'}`,
      [business_unit_id]
    );

    // Log audit
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES ($1, 'field_visibility.reset', 'business_unit', $2, $3)`,
      [userId, business_unit_id, JSON.stringify({ action: 'reset_to_defaults' })]
    );

    res.json({
      message: 'Field visibility settings reset to defaults',
      data: {
        business_unit_id: parseInt(business_unit_id)
      }
    });
  } catch (error) {
    logger.error('Reset field visibility error:', error);
    next(error);
  }
});

module.exports = router;


