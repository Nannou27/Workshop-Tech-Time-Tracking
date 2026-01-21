/**
 * Field Visibility Utility
 * Handles field visibility rules based on Business Unit
 */

const db = require('../database/connection');
const logger = require('../utils/logger');

/**
 * Get field visibility settings for a Business Unit
 */
async function getFieldVisibilitySettings(businessUnitId) {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const tableExists = await checkTableExists('field_visibility_settings');
    
    if (!tableExists) {
      // If table doesn't exist, return default visibility (all fields visible)
      return null;
    }

    const result = await db.query(
      `SELECT section_name, field_name, is_visible, is_required, custom_label, custom_help_text
       FROM field_visibility_settings
       WHERE business_unit_id = ${dbType === 'mysql' ? '?' : '$1'}`,
      [businessUnitId]
    );

    // Convert to a map for easy lookup
    const settings = {};
    result.rows.forEach(row => {
      const key = `${row.section_name}.${row.field_name}`;
      settings[key] = {
        is_visible: row.is_visible,
        is_required: row.is_required,
        custom_label: row.custom_label,
        custom_help_text: row.custom_help_text
      };
    });

    return settings;
  } catch (error) {
    logger.error('Error getting field visibility settings:', error);
    return null;
  }
}

/**
 * Get default field visibility from reference table
 */
async function getDefaultFieldVisibility() {
  try {
    const tableExists = await checkTableExists('work_order_sections_reference');
    
    if (!tableExists) {
      return null;
    }

    const result = await db.query(
      `SELECT section_name, field_name, default_visibility, default_required
       FROM work_order_sections_reference`
    );

    const defaults = {};
    result.rows.forEach(row => {
      const key = `${row.section_name}.${row.field_name}`;
      defaults[key] = {
        is_visible: row.default_visibility,
        is_required: row.default_required
      };
    });

    return defaults;
  } catch (error) {
    logger.error('Error getting default field visibility:', error);
    return null;
  }
}

/**
 * Check if a field is visible for a Business Unit
 */
async function isFieldVisible(businessUnitId, sectionName, fieldName) {
  const settings = await getFieldVisibilitySettings(businessUnitId);
  
  if (!settings) {
    // If no settings, check defaults
    const defaults = await getDefaultFieldVisibility();
    if (defaults) {
      const key = `${sectionName}.${fieldName}`;
      return defaults[key]?.is_visible !== false; // Default to visible if not found
    }
    return true; // Default to visible if no settings at all
  }

  const key = `${sectionName}.${fieldName}`;
  if (settings[key]) {
    return settings[key].is_visible;
  }

  // If not in settings, check defaults
  const defaults = await getDefaultFieldVisibility();
  if (defaults && defaults[key]) {
    return defaults[key].is_visible;
  }

  return true; // Default to visible
}

/**
 * Check if a field is required for a Business Unit
 */
async function isFieldRequired(businessUnitId, sectionName, fieldName) {
  const settings = await getFieldVisibilitySettings(businessUnitId);
  
  if (!settings) {
    const defaults = await getDefaultFieldVisibility();
    if (defaults) {
      const key = `${sectionName}.${fieldName}`;
      return defaults[key]?.is_required === true;
    }
    return false;
  }

  const key = `${sectionName}.${fieldName}`;
  if (settings[key]) {
    return settings[key].is_required;
  }

  const defaults = await getDefaultFieldVisibility();
  if (defaults && defaults[key]) {
    return defaults[key].is_required;
  }

  return false;
}

/**
 * Validate required fields for a Business Unit
 */
async function validateRequiredFields(businessUnitId, data) {
  const errors = [];
  const settings = await getFieldVisibilitySettings(businessUnitId);
  const defaults = await getDefaultFieldVisibility();

  // Map of section.field to data field
  const fieldMapping = {
    'customer_info.customer_name': data.customer_name,
    'customer_info.customer_email': data.customer_email,
    'customer_info.customer_phone': data.customer_phone,
    'customer_info.customer_address': data.customer_address,
    'vehicle_info.vehicle_type': data.vehicle_info?.vehicle_type,
    'vehicle_info.make': data.vehicle_info?.make,
    'vehicle_info.model': data.vehicle_info?.model,
    'vehicle_info.year': data.vehicle_info?.year,
    'vehicle_info.vin': data.vehicle_info?.vin,
    'vehicle_info.license_plate': data.vehicle_info?.license_plate,
    'vehicle_info.odometer': data.vehicle_info?.odometer,
    'vehicle_info.color': data.vehicle_info?.color,
    'work_order_details.work_type': data.work_type,
    'work_order_details.problem_description': data.problem_description,
    'work_order_details.bike_condition_review': data.bike_condition_review,
    'work_order_details.job_category': data.job_category,
    'work_order_details.previous_job_number': data.previous_job_number,
    'work_order_details.estimated_hours': data.estimated_hours,
    'work_order_details.priority': data.priority,
    'work_order_details.notes': data.notes,
    'location_assignment.location_id': data.location_id,
    'location_assignment.assigned_technician': data.assigned_technician
  };

  // Check each field
  for (const [fieldKey, fieldValue] of Object.entries(fieldMapping)) {
    const [sectionName, fieldName] = fieldKey.split('.');
    
    const isRequired = await isFieldRequired(businessUnitId, sectionName, fieldName);
    const isVisible = await isFieldVisible(businessUnitId, sectionName, fieldName);

    if (isVisible && isRequired && (!fieldValue || (typeof fieldValue === 'string' && fieldValue.trim() === ''))) {
      errors.push({
        field: fieldKey,
        message: `${fieldName} is required`
      });
    }
  }

  return errors;
}

/**
 * Filter data to only include visible fields
 */
async function filterVisibleFields(businessUnitId, data) {
  const filtered = {};
  const settings = await getFieldVisibilitySettings(businessUnitId);
  const defaults = await getDefaultFieldVisibility();

  // Always include system fields
  filtered.id = data.id;
  filtered.job_number = data.job_number;
  filtered.status = data.status;
  filtered.created_at = data.created_at;
  filtered.updated_at = data.updated_at;

  // Check each field
  const fieldMapping = {
    'customer_info.customer_name': () => data.customer_name,
    'customer_info.customer_email': () => data.customer_email,
    'customer_info.customer_phone': () => data.customer_phone,
    'customer_info.customer_address': () => data.customer_address,
    'vehicle_info.vehicle_type': () => data.vehicle_info?.vehicle_type,
    'vehicle_info.make': () => data.vehicle_info?.make,
    'vehicle_info.model': () => data.vehicle_info?.model,
    'vehicle_info.year': () => data.vehicle_info?.year,
    'vehicle_info.vin': () => data.vehicle_info?.vin,
    'vehicle_info.license_plate': () => data.vehicle_info?.license_plate,
    'vehicle_info.odometer': () => data.vehicle_info?.odometer,
    'vehicle_info.color': () => data.vehicle_info?.color,
    'work_order_details.work_type': () => data.work_type,
    'work_order_details.problem_description': () => data.problem_description,
    'work_order_details.bike_condition_review': () => data.bike_condition_review,
    'work_order_details.job_category': () => data.job_category,
    'work_order_details.previous_job_number': () => data.previous_job_number,
    'work_order_details.estimated_hours': () => data.estimated_hours,
    'work_order_details.priority': () => data.priority,
    'work_order_details.notes': () => data.notes,
    'location_assignment.location_id': () => data.location_id,
    'location_assignment.assigned_technician': () => data.assigned_technician
  };

  for (const [fieldKey, getValue] of Object.entries(fieldMapping)) {
    const [sectionName, fieldName] = fieldKey.split('.');
    const isVisible = await isFieldVisible(businessUnitId, sectionName, fieldName);
    
    if (isVisible) {
      const value = getValue();
      if (value !== undefined && value !== null) {
        // Reconstruct vehicle_info object if any vehicle fields are visible
        if (fieldKey.startsWith('vehicle_info.')) {
          if (!filtered.vehicle_info) {
            filtered.vehicle_info = {};
          }
          filtered.vehicle_info[fieldName] = value;
        } else if (fieldKey.startsWith('customer_info.')) {
          filtered[fieldName.replace('customer_', '')] = value;
        } else if (fieldKey.startsWith('work_order_details.')) {
          filtered[fieldName] = value;
        } else if (fieldKey.startsWith('location_assignment.')) {
          filtered[fieldName] = value;
        }
      }
    }
  }

  return filtered;
}

/**
 * Helper to check if table exists
 */
async function checkTableExists(tableName) {
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

module.exports = {
  getFieldVisibilitySettings,
  getDefaultFieldVisibility,
  isFieldVisible,
  isFieldRequired,
  validateRequiredFields,
  filterVisibleFields
};





