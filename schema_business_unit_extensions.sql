-- Business Unit Extensions Schema
-- Supports: Field Visibility, Role Hierarchy, Work Order Stages, BU-specific configurations

-- ============================================
-- 1. Work Order Sections Reference Table
-- ============================================
-- Defines all possible sections and fields for Work Orders
-- This is a reference/master table that lists all available fields

CREATE TABLE IF NOT EXISTS work_order_sections_reference (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  section_name VARCHAR(100) NOT NULL,
  section_display_name VARCHAR(255) NOT NULL,
  section_order INT DEFAULT 0,
  field_name VARCHAR(100) NOT NULL,
  field_display_name VARCHAR(255) NOT NULL,
  field_type VARCHAR(50) NOT NULL, -- 'text', 'number', 'date', 'select', 'textarea', 'email', 'phone'
  field_order INT DEFAULT 0,
  default_visibility BOOLEAN DEFAULT TRUE,
  default_required BOOLEAN DEFAULT FALSE,
  validation_rules JSON, -- e.g., {"min": 0, "max": 100, "pattern": "^[A-Z0-9]+$"}
  options JSON, -- For select fields: [{"value": "option1", "label": "Option 1"}]
  help_text TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_section_field (section_name, field_name),
  INDEX idx_section (section_name),
  INDEX idx_section_order (section_order, field_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 2. Field Visibility Settings Table
-- ============================================
-- Stores per-Business Unit visibility and mandatory rules

CREATE TABLE IF NOT EXISTS field_visibility_settings (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_unit_id INT NOT NULL,
  section_name VARCHAR(100) NOT NULL,
  field_name VARCHAR(100) NOT NULL,
  is_visible BOOLEAN DEFAULT TRUE,
  is_required BOOLEAN DEFAULT FALSE,
  custom_label VARCHAR(255),
  custom_help_text TEXT,
  created_by BIGINT,
  updated_by BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_bu_section_field (business_unit_id, section_name, field_name),
  INDEX idx_business_unit (business_unit_id),
  INDEX idx_section_field (section_name, field_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Add foreign keys separately if tables exist
-- Note: These will fail gracefully if tables don't exist yet

-- ============================================
-- 3. Business Unit Job Types Table
-- ============================================
-- Each Business Unit can have its own set of Job Types

CREATE TABLE IF NOT EXISTS business_unit_job_types (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_unit_id INT NOT NULL,
  job_type_code VARCHAR(50) NOT NULL,
  job_type_name VARCHAR(255) NOT NULL,
  description TEXT,
  default_estimated_hours DECIMAL(10,2),
  is_active BOOLEAN DEFAULT TRUE,
  display_order INT DEFAULT 0,
  created_by BIGINT,
  updated_by BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_bu_job_type (business_unit_id, job_type_code),
  INDEX idx_business_unit (business_unit_id),
  INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 4. Work Order Stage History Table
-- ============================================
-- Tracks reassignments, stages, and technician movements

CREATE TABLE IF NOT EXISTS work_order_stage_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  work_order_id BIGINT NOT NULL,
  assignment_id BIGINT,
  stage_name VARCHAR(100) NOT NULL,
  stage_order INT DEFAULT 0,
  from_technician_id BIGINT,
  to_technician_id BIGINT NOT NULL,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  duration_seconds INT,
  notes TEXT,
  status VARCHAR(50) DEFAULT 'in_progress',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_work_order (work_order_id),
  INDEX idx_assignment (assignment_id),
  INDEX idx_technician (to_technician_id),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 5. Business Unit Module Settings Table
-- ============================================
-- Controls which modules/features are enabled per Business Unit

CREATE TABLE IF NOT EXISTS business_unit_module_settings (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_unit_id INT NOT NULL,
  module_name VARCHAR(100) NOT NULL,
  is_enabled BOOLEAN DEFAULT TRUE,
  module_config JSON,
  created_by BIGINT,
  updated_by BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_bu_module (business_unit_id, module_name),
  INDEX idx_business_unit (business_unit_id),
  INDEX idx_module (module_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================
-- 6. Update Existing Tables
-- ============================================

-- Add business_unit_id to job_cards if not exists
ALTER TABLE job_cards 
ADD COLUMN IF NOT EXISTS business_unit_id INT,
ADD INDEX IF NOT EXISTS idx_business_unit (business_unit_id);

-- Add foreign key if column was just added
-- Note: This will fail if column already exists with different constraints
-- ALTER TABLE job_cards 
-- ADD FOREIGN KEY (business_unit_id) REFERENCES business_units(id) ON DELETE RESTRICT;

-- ============================================
-- 7. Insert Default Work Order Sections Reference Data
-- ============================================

INSERT INTO work_order_sections_reference (section_name, section_display_name, section_order, field_name, field_display_name, field_type, field_order, default_visibility, default_required, help_text) VALUES
('customer_info', 'Customer Information', 1, 'customer_name', 'Customer Name', 'text', 1, TRUE, TRUE, 'Full name of the customer'),
('customer_info', 'Customer Information', 1, 'customer_email', 'Email', 'email', 2, TRUE, FALSE, 'Customer email address'),
('customer_info', 'Customer Information', 1, 'customer_phone', 'Phone Number', 'phone', 3, TRUE, FALSE, 'Customer contact number'),
('customer_info', 'Customer Information', 1, 'customer_address', 'Address', 'textarea', 4, TRUE, FALSE, 'Customer address'),
('vehicle_info', 'Vehicle/Asset Information', 2, 'vehicle_type', 'Vehicle Type', 'select', 1, TRUE, FALSE, 'Type of vehicle or asset'),
('vehicle_info', 'Vehicle/Asset Information', 2, 'make', 'Make', 'text', 2, TRUE, FALSE, 'Manufacturer name'),
('vehicle_info', 'Vehicle/Asset Information', 2, 'model', 'Model', 'text', 3, TRUE, FALSE, 'Model name'),
('vehicle_info', 'Vehicle/Asset Information', 2, 'year', 'Year', 'number', 4, TRUE, FALSE, 'Manufacturing year'),
('vehicle_info', 'Vehicle/Asset Information', 2, 'vin', 'VIN/Serial Number', 'text', 5, TRUE, FALSE, 'Vehicle Identification Number or Serial Number'),
('vehicle_info', 'Vehicle/Asset Information', 2, 'license_plate', 'License Plate', 'text', 6, TRUE, FALSE, 'License plate number'),
('vehicle_info', 'Vehicle/Asset Information', 2, 'odometer', 'Odometer Reading', 'number', 7, TRUE, FALSE, 'Current odometer reading'),
('vehicle_info', 'Vehicle/Asset Information', 2, 'color', 'Color', 'text', 8, TRUE, FALSE, 'Vehicle color'),
('work_order_details', 'Work Order Details', 3, 'work_type', 'Work Type', 'select', 1, TRUE, TRUE, 'Type of work to be performed'),
('work_order_details', 'Work Order Details', 3, 'problem_description', 'Problem Description', 'textarea', 2, TRUE, TRUE, 'Description of the problem or issue'),
('work_order_details', 'Work Order Details', 3, 'estimated_hours', 'Estimated Hours', 'number', 3, TRUE, FALSE, 'Estimated time to complete'),
('work_order_details', 'Work Order Details', 3, 'priority', 'Priority', 'select', 4, TRUE, FALSE, 'Priority level'),
('work_order_details', 'Work Order Details', 3, 'notes', 'Additional Notes', 'textarea', 5, TRUE, FALSE, 'Any additional notes or instructions'),
('location_assignment', 'Location & Assignment', 4, 'location_id', 'Location', 'select', 1, TRUE, TRUE, 'Location where work will be performed'),
('location_assignment', 'Location & Assignment', 4, 'assigned_technician', 'Assigned Technician', 'select', 2, TRUE, FALSE, 'Technician assigned to this work order'),
('financial_info', 'Financial Information', 5, 'estimated_cost', 'Estimated Cost', 'number', 1, FALSE, FALSE, 'Estimated cost of the work'),
('financial_info', 'Financial Information', 5, 'customer_payment_method', 'Payment Method', 'select', 2, FALSE, FALSE, 'Preferred payment method')
ON DUPLICATE KEY UPDATE 
  section_display_name = VALUES(section_display_name),
  field_display_name = VALUES(field_display_name),
  updated_at = CURRENT_TIMESTAMP;

-- ============================================
-- 8. Create Default Visibility Settings for Existing Business Units
-- ============================================
-- This will be handled by the API when a BU is created or when settings are initialized

