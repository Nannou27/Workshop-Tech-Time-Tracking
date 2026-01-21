-- Business Unit Extensions Schema (PostgreSQL)
-- Supports: Field Visibility, Role Hierarchy, Work Order Stages, BU-specific configurations

-- ============================================
-- 1. Work Order Sections Reference Table
-- ============================================

CREATE TABLE IF NOT EXISTS work_order_sections_reference (
  id BIGSERIAL PRIMARY KEY,
  section_name VARCHAR(100) NOT NULL,
  section_display_name VARCHAR(255) NOT NULL,
  section_order INT DEFAULT 0,
  field_name VARCHAR(100) NOT NULL,
  field_display_name VARCHAR(255) NOT NULL,
  field_type VARCHAR(50) NOT NULL,
  field_order INT DEFAULT 0,
  default_visibility BOOLEAN DEFAULT TRUE,
  default_required BOOLEAN DEFAULT FALSE,
  validation_rules JSONB,
  options JSONB,
  help_text TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT unique_section_field UNIQUE (section_name, field_name)
);

CREATE INDEX idx_section ON work_order_sections_reference(section_name);
CREATE INDEX idx_section_order ON work_order_sections_reference(section_order, field_order);

-- ============================================
-- 2. Field Visibility Settings Table
-- ============================================

CREATE TABLE IF NOT EXISTS field_visibility_settings (
  id BIGSERIAL PRIMARY KEY,
  business_unit_id INT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  section_name VARCHAR(100) NOT NULL,
  field_name VARCHAR(100) NOT NULL,
  is_visible BOOLEAN DEFAULT TRUE,
  is_required BOOLEAN DEFAULT FALSE,
  custom_label VARCHAR(255),
  custom_help_text TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT unique_bu_section_field UNIQUE (business_unit_id, section_name, field_name)
);

CREATE INDEX idx_business_unit ON field_visibility_settings(business_unit_id);
CREATE INDEX idx_section_field ON field_visibility_settings(section_name, field_name);

-- ============================================
-- 3. Business Unit Job Types Table
-- ============================================

CREATE TABLE IF NOT EXISTS business_unit_job_types (
  id BIGSERIAL PRIMARY KEY,
  business_unit_id INT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  job_type_code VARCHAR(50) NOT NULL,
  job_type_name VARCHAR(255) NOT NULL,
  description TEXT,
  default_estimated_hours DECIMAL(10,2),
  is_active BOOLEAN DEFAULT TRUE,
  display_order INT DEFAULT 0,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT unique_bu_job_type UNIQUE (business_unit_id, job_type_code)
);

CREATE INDEX idx_business_unit ON business_unit_job_types(business_unit_id);
CREATE INDEX idx_active ON business_unit_job_types(is_active);

-- ============================================
-- 4. Work Order Stage History Table
-- ============================================

CREATE TABLE IF NOT EXISTS work_order_stage_history (
  id BIGSERIAL PRIMARY KEY,
  work_order_id BIGINT NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  assignment_id BIGINT REFERENCES assignments(id) ON DELETE SET NULL,
  stage_name VARCHAR(100) NOT NULL,
  stage_order INT DEFAULT 0,
  from_technician_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  to_technician_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  duration_seconds INT,
  notes TEXT,
  status VARCHAR(50) DEFAULT 'in_progress',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_work_order ON work_order_stage_history(work_order_id);
CREATE INDEX idx_assignment ON work_order_stage_history(assignment_id);
CREATE INDEX idx_technician ON work_order_stage_history(to_technician_id);
CREATE INDEX idx_status ON work_order_stage_history(status);
CREATE INDEX idx_created_at ON work_order_stage_history(created_at);

-- ============================================
-- 5. Business Unit Module Settings Table
-- ============================================

CREATE TABLE IF NOT EXISTS business_unit_module_settings (
  id BIGSERIAL PRIMARY KEY,
  business_unit_id INT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  module_name VARCHAR(100) NOT NULL,
  is_enabled BOOLEAN DEFAULT TRUE,
  module_config JSONB,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT unique_bu_module UNIQUE (business_unit_id, module_name)
);

CREATE INDEX idx_business_unit ON business_unit_module_settings(business_unit_id);
CREATE INDEX idx_module ON business_unit_module_settings(module_name);

-- ============================================
-- 6. Update Existing Tables
-- ============================================

-- Add business_unit_id to job_cards if not exists
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'job_cards' AND column_name = 'business_unit_id'
  ) THEN
    ALTER TABLE job_cards ADD COLUMN business_unit_id INT;
    CREATE INDEX idx_business_unit ON job_cards(business_unit_id);
    -- Note: Foreign key will be added after ensuring business_units table exists
  END IF;
END $$;

-- ============================================
-- 7. Insert Default Work Order Sections Reference Data
-- ============================================

INSERT INTO work_order_sections_reference (section_name, section_display_name, section_order, field_name, field_display_name, field_type, field_order, default_visibility, default_required, help_text) VALUES
-- Customer Information Section
('customer_info', 'Customer Information', 1, 'customer_name', 'Customer Name', 'text', 1, TRUE, TRUE, 'Full name of the customer'),
('customer_info', 'Customer Information', 1, 'customer_email', 'Email', 'email', 2, TRUE, FALSE, 'Customer email address'),
('customer_info', 'Customer Information', 1, 'customer_phone', 'Phone Number', 'phone', 3, TRUE, FALSE, 'Customer contact number'),
('customer_info', 'Customer Information', 1, 'customer_address', 'Address', 'textarea', 4, TRUE, FALSE, 'Customer address'),

-- Vehicle/Asset Information Section
('vehicle_info', 'Vehicle/Asset Information', 2, 'vehicle_type', 'Vehicle Type', 'select', 1, TRUE, FALSE, 'Type of vehicle or asset'),
('vehicle_info', 'Vehicle/Asset Information', 2, 'make', 'Make', 'text', 2, TRUE, FALSE, 'Manufacturer name'),
('vehicle_info', 'Vehicle/Asset Information', 2, 'model', 'Model', 'text', 3, TRUE, FALSE, 'Model name'),
('vehicle_info', 'Vehicle/Asset Information', 2, 'year', 'Year', 'number', 4, TRUE, FALSE, 'Manufacturing year'),
('vehicle_info', 'Vehicle/Asset Information', 2, 'vin', 'VIN/Serial Number', 'text', 5, TRUE, FALSE, 'Vehicle Identification Number or Serial Number'),
('vehicle_info', 'Vehicle/Asset Information', 2, 'license_plate', 'License Plate', 'text', 6, TRUE, FALSE, 'License plate number'),
('vehicle_info', 'Vehicle/Asset Information', 2, 'odometer', 'Odometer Reading', 'number', 7, TRUE, FALSE, 'Current odometer reading'),
('vehicle_info', 'Vehicle/Asset Information', 2, 'color', 'Color', 'text', 8, TRUE, FALSE, 'Vehicle color'),

-- Work Order Details Section
('work_order_details', 'Work Order Details', 3, 'work_type', 'Work Type', 'select', 1, TRUE, TRUE, 'Type of work to be performed'),
('work_order_details', 'Work Order Details', 3, 'problem_description', 'Problem Description', 'textarea', 2, TRUE, TRUE, 'Description of the problem or issue'),
('work_order_details', 'Work Order Details', 3, 'estimated_hours', 'Estimated Hours', 'number', 3, TRUE, FALSE, 'Estimated time to complete'),
('work_order_details', 'Work Order Details', 3, 'priority', 'Priority', 'select', 4, TRUE, FALSE, 'Priority level'),
('work_order_details', 'Work Order Details', 3, 'notes', 'Additional Notes', 'textarea', 5, TRUE, FALSE, 'Any additional notes or instructions'),

-- Location & Assignment Section
('location_assignment', 'Location & Assignment', 4, 'location_id', 'Location', 'select', 1, TRUE, TRUE, 'Location where work will be performed'),
('location_assignment', 'Location & Assignment', 4, 'assigned_technician', 'Assigned Technician', 'select', 2, TRUE, FALSE, 'Technician assigned to this work order'),

-- Financial Information Section (Optional)
('financial_info', 'Financial Information', 5, 'estimated_cost', 'Estimated Cost', 'number', 1, FALSE, FALSE, 'Estimated cost of the work'),
('financial_info', 'Financial Information', 5, 'customer_payment_method', 'Payment Method', 'select', 2, FALSE, FALSE, 'Preferred payment method')

ON CONFLICT (section_name, field_name) DO UPDATE SET
  section_display_name = EXCLUDED.section_display_name,
  field_display_name = EXCLUDED.field_display_name,
  updated_at = now();





