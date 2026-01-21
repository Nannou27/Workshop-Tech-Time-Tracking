-- ============================================================================
-- Asset & Workshop Management System - Additional Schema
-- MySQL 8.0+ Compatible (for XAMPP)
-- Extends existing WTTT schema
-- ============================================================================

-- ============================================================================
-- BUSINESS UNITS
-- ============================================================================

CREATE TABLE IF NOT EXISTS business_units (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  code VARCHAR(50) UNIQUE, -- Business unit code/identifier
  is_active BOOLEAN DEFAULT true,
  metadata JSON DEFAULT ('{}'), -- Custom fields
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by CHAR(36),
  CONSTRAINT fk_business_units_created_by FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_business_units_code ON business_units(code);
CREATE INDEX idx_business_units_active ON business_units(is_active);

-- ============================================================================
-- LOCATIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS locations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  address TEXT,
  city VARCHAR(100),
  state VARCHAR(100),
  country VARCHAR(100) DEFAULT 'UAE',
  postal_code VARCHAR(20),
  phone VARCHAR(50),
  email VARCHAR(255),
  business_unit_id BIGINT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  metadata JSON DEFAULT ('{}'), -- Custom fields
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by CHAR(36),
  CONSTRAINT fk_locations_business_unit FOREIGN KEY (business_unit_id) REFERENCES business_units(id) ON DELETE RESTRICT,
  CONSTRAINT fk_locations_created_by FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_locations_business_unit ON locations(business_unit_id);
CREATE INDEX idx_locations_active ON locations(is_active);

-- ============================================================================
-- ENHANCED EMPLOYEES (Extend existing users/technicians)
-- ============================================================================

-- Add business_unit_id and location_id to users table
ALTER TABLE users 
  ADD COLUMN business_unit_id BIGINT NULL,
  ADD COLUMN location_id BIGINT NULL,
  ADD COLUMN cost_center VARCHAR(100) NULL,
  ADD COLUMN employee_number VARCHAR(50) NULL UNIQUE,
  ADD CONSTRAINT fk_users_business_unit FOREIGN KEY (business_unit_id) REFERENCES business_units(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_users_location FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL;

CREATE INDEX idx_users_business_unit ON users(business_unit_id);
CREATE INDEX idx_users_location ON users(location_id);
CREATE INDEX idx_users_employee_number ON users(employee_number);

-- ============================================================================
-- ASSETS / INVENTORY
-- ============================================================================

CREATE TABLE IF NOT EXISTS assets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  serial_number VARCHAR(255),
  barcode VARCHAR(255) UNIQUE, -- Barcode/QR code identifier
  qr_code VARCHAR(255) UNIQUE, -- QR code identifier (alternative to barcode)
  asset_tag VARCHAR(100) UNIQUE, -- Internal asset tag
  cost DECIMAL(15,2),
  purchase_date DATE,
  warranty_expiry DATE,
  business_unit_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  parent_asset_id BIGINT NULL, -- For hierarchical assets
  status VARCHAR(50) DEFAULT 'active', -- active, in_maintenance, disposed, retired, etc.
  asset_type VARCHAR(100), -- Vehicle, Equipment, Tool, etc.
  manufacturer VARCHAR(255),
  model VARCHAR(255),
  year INTEGER,
  metadata JSON DEFAULT ('{}'), -- Custom fields (VIN, license_plate, etc. for vehicles)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by CHAR(36),
  CONSTRAINT fk_assets_business_unit FOREIGN KEY (business_unit_id) REFERENCES business_units(id) ON DELETE RESTRICT,
  CONSTRAINT fk_assets_location FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_assets_parent FOREIGN KEY (parent_asset_id) REFERENCES assets(id) ON DELETE SET NULL,
  CONSTRAINT fk_assets_created_by FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_assets_barcode ON assets(barcode);
CREATE INDEX idx_assets_qr_code ON assets(qr_code);
CREATE INDEX idx_assets_serial_number ON assets(serial_number);
CREATE INDEX idx_assets_business_unit ON assets(business_unit_id);
CREATE INDEX idx_assets_location ON assets(location_id);
CREATE INDEX idx_assets_parent ON assets(parent_asset_id);
CREATE INDEX idx_assets_status ON assets(status);

-- ============================================================================
-- PARTS / COMPONENTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS parts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  part_number VARCHAR(100), -- Manufacturer part number
  serial_number VARCHAR(255),
  barcode VARCHAR(255) UNIQUE,
  qr_code VARCHAR(255) UNIQUE,
  cost DECIMAL(15,2),
  parent_asset_id BIGINT NULL,
  location_id BIGINT NULL,
  status VARCHAR(50) DEFAULT 'active', -- active, installed, removed, disposed
  manufacturer VARCHAR(255),
  metadata JSON DEFAULT ('{}'), -- Custom fields
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by CHAR(36),
  CONSTRAINT fk_parts_parent_asset FOREIGN KEY (parent_asset_id) REFERENCES assets(id) ON DELETE CASCADE,
  CONSTRAINT fk_parts_location FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL,
  CONSTRAINT fk_parts_created_by FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_parts_barcode ON parts(barcode);
CREATE INDEX idx_parts_qr_code ON parts(qr_code);
CREATE INDEX idx_parts_parent_asset ON parts(parent_asset_id);
CREATE INDEX idx_parts_location ON parts(location_id);
CREATE INDEX idx_parts_status ON parts(status);

-- ============================================================================
-- ENHANCED WORK ORDERS (Extend existing job_cards)
-- ============================================================================

-- Add new columns to job_cards table
ALTER TABLE job_cards
  ADD COLUMN asset_id BIGINT NULL,
  ADD COLUMN location_id BIGINT NULL,
  ADD COLUMN job_type VARCHAR(100) NULL, -- Mechanical, Electrical, Body Shop, etc.
  ADD COLUMN parent_work_order_id BIGINT NULL, -- For sequential jobs
  ADD COLUMN reassigned_from_id BIGINT NULL, -- Track reassignment history
  ADD CONSTRAINT fk_job_cards_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_job_cards_location FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_job_cards_parent FOREIGN KEY (parent_work_order_id) REFERENCES job_cards(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_job_cards_reassigned_from FOREIGN KEY (reassigned_from_id) REFERENCES job_cards(id) ON DELETE SET NULL;

CREATE INDEX idx_job_cards_asset ON job_cards(asset_id);
CREATE INDEX idx_job_cards_location ON job_cards(location_id);
CREATE INDEX idx_job_cards_job_type ON job_cards(job_type);
CREATE INDEX idx_job_cards_parent ON job_cards(parent_work_order_id);

-- ============================================================================
-- JOB HISTORY / LOGS (Enhanced from time_logs)
-- ============================================================================

-- Add reassignment tracking to time_logs
ALTER TABLE time_logs
  ADD COLUMN reassigned_from_id BIGINT NULL,
  ADD CONSTRAINT fk_time_logs_reassigned_from FOREIGN KEY (reassigned_from_id) REFERENCES assignments(id) ON DELETE SET NULL;

CREATE INDEX idx_time_logs_reassigned_from ON time_logs(reassigned_from_id);

-- Create comprehensive job history table
CREATE TABLE IF NOT EXISTS job_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  work_order_id BIGINT NOT NULL,
  assignment_id BIGINT NULL,
  technician_id CHAR(36) NULL,
  action_type VARCHAR(50) NOT NULL, -- assigned, started, paused, resumed, completed, reassigned, cancelled
  start_time TIMESTAMP NULL,
  end_time TIMESTAMP NULL,
  duration_seconds BIGINT,
  status VARCHAR(50), -- assigned, in_progress, completed, cancelled, reassigned
  notes TEXT,
  reassigned_from_id BIGINT NULL,
  reassigned_to_id BIGINT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by CHAR(36),
  CONSTRAINT fk_job_history_work_order FOREIGN KEY (work_order_id) REFERENCES job_cards(id) ON DELETE CASCADE,
  CONSTRAINT fk_job_history_assignment FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE SET NULL,
  CONSTRAINT fk_job_history_technician FOREIGN KEY (technician_id) REFERENCES technicians(user_id) ON DELETE SET NULL,
  CONSTRAINT fk_job_history_reassigned_from FOREIGN KEY (reassigned_from_id) REFERENCES assignments(id) ON DELETE SET NULL,
  CONSTRAINT fk_job_history_reassigned_to FOREIGN KEY (reassigned_to_id) REFERENCES assignments(id) ON DELETE SET NULL,
  CONSTRAINT fk_job_history_created_by FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_job_history_work_order ON job_history(work_order_id);
CREATE INDEX idx_job_history_assignment ON job_history(assignment_id);
CREATE INDEX idx_job_history_technician ON job_history(technician_id);
CREATE INDEX idx_job_history_action_type ON job_history(action_type);
CREATE INDEX idx_job_history_created_at ON job_history(created_at);

-- ============================================================================
-- ASSET MOVEMENT / HISTORY
-- ============================================================================

CREATE TABLE IF NOT EXISTS asset_movements (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  asset_id BIGINT NOT NULL,
  from_location_id BIGINT NULL,
  to_location_id BIGINT NOT NULL,
  moved_by CHAR(36) NOT NULL,
  movement_type VARCHAR(50) DEFAULT 'transfer', -- transfer, maintenance, disposal, etc.
  reason TEXT,
  notes TEXT,
  moved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metadata JSON DEFAULT ('{}'),
  CONSTRAINT fk_asset_movements_asset FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
  CONSTRAINT fk_asset_movements_from_location FOREIGN KEY (from_location_id) REFERENCES locations(id) ON DELETE SET NULL,
  CONSTRAINT fk_asset_movements_to_location FOREIGN KEY (to_location_id) REFERENCES locations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_asset_movements_moved_by FOREIGN KEY (moved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_asset_movements_asset ON asset_movements(asset_id);
CREATE INDEX idx_asset_movements_from_location ON asset_movements(from_location_id);
CREATE INDEX idx_asset_movements_to_location ON asset_movements(to_location_id);
CREATE INDEX idx_asset_movements_moved_at ON asset_movements(moved_at);

-- ============================================================================
-- PARTS USAGE IN WORK ORDERS
-- ============================================================================

CREATE TABLE IF NOT EXISTS work_order_parts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  work_order_id BIGINT NOT NULL,
  part_id BIGINT NOT NULL,
  quantity INTEGER DEFAULT 1,
  unit_cost DECIMAL(15,2),
  total_cost DECIMAL(15,2) AS (quantity * unit_cost) STORED,
  installed_by CHAR(36),
  installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_work_order_parts_work_order FOREIGN KEY (work_order_id) REFERENCES job_cards(id) ON DELETE CASCADE,
  CONSTRAINT fk_work_order_parts_part FOREIGN KEY (part_id) REFERENCES parts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_work_order_parts_installed_by FOREIGN KEY (installed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_work_order_parts_work_order ON work_order_parts(work_order_id);
CREATE INDEX idx_work_order_parts_part ON work_order_parts(part_id);

-- ============================================================================
-- BARCODE / QR CODE SCANNING LOGS
-- ============================================================================

CREATE TABLE IF NOT EXISTS barcode_scans (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  barcode VARCHAR(255) NOT NULL,
  qr_code VARCHAR(255),
  entity_type VARCHAR(50) NOT NULL, -- asset, part, work_order, etc.
  entity_id BIGINT NOT NULL, -- ID of the scanned entity
  scanned_by CHAR(36) NOT NULL,
  scan_type VARCHAR(50) DEFAULT 'scan', -- scan, create, update, movement
  location_id BIGINT,
  notes TEXT,
  scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metadata JSON DEFAULT ('{}'),
  CONSTRAINT fk_barcode_scans_scanned_by FOREIGN KEY (scanned_by) REFERENCES users(id),
  CONSTRAINT fk_barcode_scans_location FOREIGN KEY (location_id) REFERENCES locations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_barcode_scans_barcode ON barcode_scans(barcode);
CREATE INDEX idx_barcode_scans_qr_code ON barcode_scans(qr_code);
CREATE INDEX idx_barcode_scans_entity ON barcode_scans(entity_type, entity_id);
CREATE INDEX idx_barcode_scans_scanned_at ON barcode_scans(scanned_at);

-- ============================================================================
-- ORACLE NETSUITE INTEGRATION PREPARATION
-- ============================================================================

CREATE TABLE IF NOT EXISTS netsuite_sync_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL, -- asset, work_order, part, etc.
  entity_id BIGINT NOT NULL,
  netsuite_record_id VARCHAR(255), -- NetSuite internal ID
  sync_type VARCHAR(50) NOT NULL, -- create, update, delete
  sync_status VARCHAR(50) DEFAULT 'pending', -- pending, success, failed, retry
  sync_data JSON NOT NULL, -- Data sent to NetSuite
  error_message TEXT,
  retry_count INT DEFAULT 0,
  last_sync_attempt TIMESTAMP NULL,
  synced_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_netsuite_sync_entity ON netsuite_sync_log(entity_type, entity_id);
CREATE INDEX idx_netsuite_sync_status ON netsuite_sync_log(sync_status);
CREATE INDEX idx_netsuite_sync_pending ON netsuite_sync_log(sync_status, created_at);

-- ============================================================================
-- INITIAL DATA / SEED DATA (Optional)
-- ============================================================================

-- Insert default business unit if none exists
INSERT INTO business_units (name, description, code, is_active)
SELECT 'Main Business Unit', 'Default business unit', 'MBU001', true
WHERE NOT EXISTS (SELECT 1 FROM business_units WHERE code = 'MBU001');

-- Insert default location if none exists
INSERT INTO locations (name, address, business_unit_id, is_active)
SELECT 'Main Location', 'Default location address', 
       (SELECT id FROM business_units WHERE code = 'MBU001' LIMIT 1), true
WHERE NOT EXISTS (
  SELECT 1 FROM locations 
  WHERE name = 'Main Location' 
  AND business_unit_id = (SELECT id FROM business_units WHERE code = 'MBU001' LIMIT 1)
);





