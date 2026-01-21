-- ============================================================================
-- Asset & Workshop Management System - Additional Schema
-- PostgreSQL 14+ Compatible
-- Extends existing WTTT schema
-- ============================================================================

-- ============================================================================
-- BUSINESS UNITS
-- ============================================================================

CREATE TABLE IF NOT EXISTS business_units (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  code VARCHAR(50) UNIQUE, -- Business unit code/identifier
  is_active BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}', -- Custom fields
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by UUID REFERENCES users(id)
);

CREATE INDEX idx_business_units_code ON business_units(code);
CREATE INDEX idx_business_units_active ON business_units(is_active);

-- ============================================================================
-- LOCATIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS locations (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  address TEXT,
  city VARCHAR(100),
  state VARCHAR(100),
  country VARCHAR(100) DEFAULT 'UAE',
  postal_code VARCHAR(20),
  phone VARCHAR(50),
  email VARCHAR(255),
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  is_active BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}', -- Custom fields
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by UUID REFERENCES users(id)
);

CREATE INDEX idx_locations_business_unit ON locations(business_unit_id);
CREATE INDEX idx_locations_active ON locations(is_active);

-- ============================================================================
-- ENHANCED EMPLOYEES (Extend existing users/technicians)
-- ============================================================================

-- Add business_unit_id and location_id to users table
ALTER TABLE users 
  ADD COLUMN IF NOT EXISTS business_unit_id BIGINT REFERENCES business_units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location_id BIGINT REFERENCES locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cost_center VARCHAR(100),
  ADD COLUMN IF NOT EXISTS employee_number VARCHAR(50) UNIQUE;

CREATE INDEX idx_users_business_unit ON users(business_unit_id);
CREATE INDEX idx_users_location ON users(location_id);
CREATE INDEX idx_users_employee_number ON users(employee_number);

-- ============================================================================
-- ASSETS / INVENTORY
-- ============================================================================

CREATE TABLE IF NOT EXISTS assets (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  serial_number VARCHAR(255),
  barcode VARCHAR(255) UNIQUE, -- Barcode/QR code identifier
  qr_code VARCHAR(255) UNIQUE, -- QR code identifier (alternative to barcode)
  asset_tag VARCHAR(100) UNIQUE, -- Internal asset tag
  cost DECIMAL(15,2),
  purchase_date DATE,
  warranty_expiry DATE,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE RESTRICT,
  location_id BIGINT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  parent_asset_id BIGINT REFERENCES assets(id) ON DELETE SET NULL, -- For hierarchical assets
  status VARCHAR(50) DEFAULT 'active', -- active, in_maintenance, disposed, retired, etc.
  asset_type VARCHAR(100), -- Vehicle, Equipment, Tool, etc.
  manufacturer VARCHAR(255),
  model VARCHAR(255),
  year INTEGER,
  metadata JSONB DEFAULT '{}', -- Custom fields (VIN, license_plate, etc. for vehicles)
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by UUID REFERENCES users(id)
);

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
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  part_number VARCHAR(100), -- Manufacturer part number
  serial_number VARCHAR(255),
  barcode VARCHAR(255) UNIQUE,
  qr_code VARCHAR(255) UNIQUE,
  cost DECIMAL(15,2),
  parent_asset_id BIGINT REFERENCES assets(id) ON DELETE CASCADE,
  location_id BIGINT REFERENCES locations(id) ON DELETE SET NULL,
  status VARCHAR(50) DEFAULT 'active', -- active, installed, removed, disposed
  manufacturer VARCHAR(255),
  metadata JSONB DEFAULT '{}', -- Custom fields
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by UUID REFERENCES users(id)
);

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
  ADD COLUMN IF NOT EXISTS asset_id BIGINT REFERENCES assets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location_id BIGINT REFERENCES locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS job_type VARCHAR(100), -- Mechanical, Electrical, Body Shop, etc.
  ADD COLUMN IF NOT EXISTS parent_work_order_id BIGINT REFERENCES job_cards(id) ON DELETE SET NULL, -- For sequential jobs
  ADD COLUMN IF NOT EXISTS reassigned_from_id BIGINT REFERENCES job_cards(id) ON DELETE SET NULL; -- Track reassignment history

CREATE INDEX idx_job_cards_asset ON job_cards(asset_id);
CREATE INDEX idx_job_cards_location ON job_cards(location_id);
CREATE INDEX idx_job_cards_job_type ON job_cards(job_type);
CREATE INDEX idx_job_cards_parent ON job_cards(parent_work_order_id);

-- ============================================================================
-- JOB HISTORY / LOGS (Enhanced from time_logs)
-- ============================================================================

-- Add reassignment tracking to time_logs
ALTER TABLE time_logs
  ADD COLUMN IF NOT EXISTS reassigned_from_id BIGINT REFERENCES assignments(id) ON DELETE SET NULL;

CREATE INDEX idx_time_logs_reassigned_from ON time_logs(reassigned_from_id);

-- Create comprehensive job history table
CREATE TABLE IF NOT EXISTS job_history (
  id BIGSERIAL PRIMARY KEY,
  work_order_id BIGINT NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  assignment_id BIGINT REFERENCES assignments(id) ON DELETE SET NULL,
  technician_id UUID REFERENCES technicians(user_id) ON DELETE SET NULL,
  action_type VARCHAR(50) NOT NULL, -- assigned, started, paused, resumed, completed, reassigned, cancelled
  start_time TIMESTAMP WITH TIME ZONE,
  end_time TIMESTAMP WITH TIME ZONE,
  duration_seconds BIGINT,
  status VARCHAR(50), -- assigned, in_progress, completed, cancelled, reassigned
  notes TEXT,
  reassigned_from_id BIGINT REFERENCES assignments(id) ON DELETE SET NULL,
  reassigned_to_id BIGINT REFERENCES assignments(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by UUID REFERENCES users(id)
);

CREATE INDEX idx_job_history_work_order ON job_history(work_order_id);
CREATE INDEX idx_job_history_assignment ON job_history(assignment_id);
CREATE INDEX idx_job_history_technician ON job_history(technician_id);
CREATE INDEX idx_job_history_action_type ON job_history(action_type);
CREATE INDEX idx_job_history_created_at ON job_history(created_at);

-- ============================================================================
-- ASSET MOVEMENT / HISTORY
-- ============================================================================

CREATE TABLE IF NOT EXISTS asset_movements (
  id BIGSERIAL PRIMARY KEY,
  asset_id BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  from_location_id BIGINT REFERENCES locations(id) ON DELETE SET NULL,
  to_location_id BIGINT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  moved_by UUID NOT NULL REFERENCES users(id),
  movement_type VARCHAR(50) DEFAULT 'transfer', -- transfer, maintenance, disposal, etc.
  reason TEXT,
  notes TEXT,
  moved_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_asset_movements_asset ON asset_movements(asset_id);
CREATE INDEX idx_asset_movements_from_location ON asset_movements(from_location_id);
CREATE INDEX idx_asset_movements_to_location ON asset_movements(to_location_id);
CREATE INDEX idx_asset_movements_moved_at ON asset_movements(moved_at);

-- ============================================================================
-- PARTS USAGE IN WORK ORDERS
-- ============================================================================

CREATE TABLE IF NOT EXISTS work_order_parts (
  id BIGSERIAL PRIMARY KEY,
  work_order_id BIGINT NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  part_id BIGINT NOT NULL REFERENCES parts(id) ON DELETE RESTRICT,
  quantity INTEGER DEFAULT 1,
  unit_cost DECIMAL(15,2),
  total_cost DECIMAL(15,2) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
  installed_by UUID REFERENCES users(id),
  installed_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_work_order_parts_work_order ON work_order_parts(work_order_id);
CREATE INDEX idx_work_order_parts_part ON work_order_parts(part_id);

-- ============================================================================
-- BARCODE / QR CODE SCANNING LOGS
-- ============================================================================

CREATE TABLE IF NOT EXISTS barcode_scans (
  id BIGSERIAL PRIMARY KEY,
  barcode VARCHAR(255) NOT NULL,
  qr_code VARCHAR(255),
  entity_type VARCHAR(50) NOT NULL, -- asset, part, work_order, etc.
  entity_id BIGINT NOT NULL, -- ID of the scanned entity
  scanned_by UUID NOT NULL REFERENCES users(id),
  scan_type VARCHAR(50) DEFAULT 'scan', -- scan, create, update, movement
  location_id BIGINT REFERENCES locations(id),
  notes TEXT,
  scanned_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_barcode_scans_barcode ON barcode_scans(barcode);
CREATE INDEX idx_barcode_scans_qr_code ON barcode_scans(qr_code);
CREATE INDEX idx_barcode_scans_entity ON barcode_scans(entity_type, entity_id);
CREATE INDEX idx_barcode_scans_scanned_at ON barcode_scans(scanned_at);

-- ============================================================================
-- ORACLE NETSUITE INTEGRATION PREPARATION
-- ============================================================================

CREATE TABLE IF NOT EXISTS netsuite_sync_log (
  id BIGSERIAL PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL, -- asset, work_order, part, etc.
  entity_id BIGINT NOT NULL,
  netsuite_record_id VARCHAR(255), -- NetSuite internal ID
  sync_type VARCHAR(50) NOT NULL, -- create, update, delete
  sync_status VARCHAR(50) DEFAULT 'pending', -- pending, success, failed, retry
  sync_data JSONB NOT NULL, -- Data sent to NetSuite
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  last_sync_attempt TIMESTAMP WITH TIME ZONE,
  synced_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX idx_netsuite_sync_entity ON netsuite_sync_log(entity_type, entity_id);
CREATE INDEX idx_netsuite_sync_status ON netsuite_sync_log(sync_status);
CREATE INDEX idx_netsuite_sync_pending ON netsuite_sync_log(sync_status, created_at) WHERE sync_status = 'pending';

-- ============================================================================
-- ANALYTICS & REPORTING VIEWS
-- ============================================================================

-- View: Asset Utilization
CREATE OR REPLACE VIEW asset_utilization AS
SELECT 
  a.id,
  a.name,
  a.asset_tag,
  a.status,
  bu.name as business_unit_name,
  l.name as location_name,
  COUNT(DISTINCT jc.id) as total_work_orders,
  COUNT(DISTINCT CASE WHEN jc.status = 'completed' THEN jc.id END) as completed_work_orders,
  COALESCE(SUM(CASE WHEN tl.status = 'finished' THEN tl.duration_seconds ELSE 0 END), 0) / 3600.0 as total_hours_used
FROM assets a
LEFT JOIN business_units bu ON a.business_unit_id = bu.id
LEFT JOIN locations l ON a.location_id = l.id
LEFT JOIN job_cards jc ON a.id = jc.asset_id
LEFT JOIN assignments ass ON jc.id = ass.job_card_id
LEFT JOIN time_logs tl ON ass.id = tl.assignment_id
GROUP BY a.id, a.name, a.asset_tag, a.status, bu.name, l.name;

-- View: Technician Performance by Location
CREATE OR REPLACE VIEW technician_performance_by_location AS
SELECT 
  t.user_id,
  u.display_name,
  u.employee_number,
  l.id as location_id,
  l.name as location_name,
  COUNT(DISTINCT jc.id) as total_jobs,
  COUNT(DISTINCT CASE WHEN jc.status = 'completed' THEN jc.id END) as completed_jobs,
  COALESCE(SUM(CASE WHEN tl.status = 'finished' THEN tl.duration_seconds ELSE 0 END), 0) / 3600.0 as total_hours,
  AVG(CASE WHEN jc.status = 'completed' AND jc.estimated_hours > 0 
    THEN (COALESCE(SUM(CASE WHEN tl.status = 'finished' THEN tl.duration_seconds ELSE 0 END), 0) / 3600.0) / jc.estimated_hours 
    ELSE NULL END) as efficiency_ratio
FROM technicians t
JOIN users u ON t.user_id = u.id
LEFT JOIN locations l ON u.location_id = l.id
LEFT JOIN assignments ass ON t.user_id = ass.technician_id
LEFT JOIN job_cards jc ON ass.job_card_id = jc.id
LEFT JOIN time_logs tl ON ass.id = tl.assignment_id
GROUP BY t.user_id, u.display_name, u.employee_number, l.id, l.name;

-- ============================================================================
-- TRIGGERS FOR AUTOMATIC UPDATES
-- ============================================================================

-- Trigger: Update asset updated_at timestamp
CREATE OR REPLACE FUNCTION update_asset_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_asset_timestamp
  BEFORE UPDATE ON assets
  FOR EACH ROW
  EXECUTE FUNCTION update_asset_timestamp();

-- Trigger: Log asset movements automatically
CREATE OR REPLACE FUNCTION log_asset_movement()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.location_id IS DISTINCT FROM NEW.location_id THEN
    INSERT INTO asset_movements (asset_id, from_location_id, to_location_id, moved_by, movement_type, moved_at)
    VALUES (NEW.id, OLD.location_id, NEW.location_id, NEW.updated_by, 'transfer', now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_log_asset_movement
  AFTER UPDATE OF location_id ON assets
  FOR EACH ROW
  WHEN (OLD.location_id IS DISTINCT FROM NEW.location_id)
  EXECUTE FUNCTION log_asset_movement();

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
WHERE NOT EXISTS (SELECT 1 FROM locations WHERE name = 'Main Location' AND business_unit_id = (SELECT id FROM business_units WHERE code = 'MBU001' LIMIT 1));





