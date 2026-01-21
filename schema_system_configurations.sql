-- ============================================================================
-- System Configurations - NO HARDCODED VALUES
-- All dropdowns, statuses, and options are configurable
-- ============================================================================

-- ============================================================================
-- ASSET STATUSES (Configurable per BU)
-- ============================================================================
CREATE TABLE IF NOT EXISTS asset_statuses (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_unit_id BIGINT NOT NULL,
  status_code VARCHAR(50) NOT NULL,
  status_name VARCHAR(100) NOT NULL,
  description TEXT,
  color VARCHAR(20) DEFAULT '#28a745',
  badge_style VARCHAR(20) DEFAULT 'success', -- success, warning, danger, info
  is_active BOOLEAN DEFAULT true,
  is_system_default BOOLEAN DEFAULT false,
  display_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by CHAR(36),
  CONSTRAINT fk_asset_statuses_bu FOREIGN KEY (business_unit_id) REFERENCES business_units(id) ON DELETE CASCADE,
  CONSTRAINT fk_asset_statuses_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  UNIQUE KEY unique_asset_status_per_bu (business_unit_id, status_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default asset statuses for each BU
INSERT INTO asset_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, display_order)
SELECT bu.id, 'active', 'Active', 'Asset is operational and available for use', '#28a745', 'success', true, 1
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM asset_statuses WHERE business_unit_id = bu.id AND status_code = 'active');

INSERT INTO asset_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, display_order)
SELECT bu.id, 'in_maintenance', 'In Maintenance', 'Asset is currently being serviced or repaired', '#ffc107', 'warning', true, 2
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM asset_statuses WHERE business_unit_id = bu.id AND status_code = 'in_maintenance');

INSERT INTO asset_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, display_order)
SELECT bu.id, 'broken', 'Broken', 'Asset is not functional and requires repair', '#dc3545', 'danger', true, 3
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM asset_statuses WHERE business_unit_id = bu.id AND status_code = 'broken');

INSERT INTO asset_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, display_order)
SELECT bu.id, 'retired', 'Retired', 'Asset is no longer in service', '#6c757d', 'info', true, 4
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM asset_statuses WHERE business_unit_id = bu.id AND status_code = 'retired');

-- ============================================================================
-- PART STATUSES (Configurable per BU)
-- ============================================================================
CREATE TABLE IF NOT EXISTS part_statuses (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_unit_id BIGINT NOT NULL,
  status_code VARCHAR(50) NOT NULL,
  status_name VARCHAR(100) NOT NULL,
  description TEXT,
  color VARCHAR(20) DEFAULT '#28a745',
  badge_style VARCHAR(20) DEFAULT 'success',
  is_active BOOLEAN DEFAULT true,
  is_system_default BOOLEAN DEFAULT false,
  display_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by CHAR(36),
  CONSTRAINT fk_part_statuses_bu FOREIGN KEY (business_unit_id) REFERENCES business_units(id) ON DELETE CASCADE,
  CONSTRAINT fk_part_statuses_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  UNIQUE KEY unique_part_status_per_bu (business_unit_id, status_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default part statuses
INSERT INTO part_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, display_order)
SELECT bu.id, 'in_stock', 'In Stock', 'Part is available in inventory', '#28a745', 'success', true, 1
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM part_statuses WHERE business_unit_id = bu.id AND status_code = 'in_stock');

INSERT INTO part_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, display_order)
SELECT bu.id, 'low_stock', 'Low Stock', 'Part inventory is below reorder level', '#ffc107', 'warning', true, 2
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM part_statuses WHERE business_unit_id = bu.id AND status_code = 'low_stock');

INSERT INTO part_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, display_order)
SELECT bu.id, 'out_of_stock', 'Out of Stock', 'Part is not available in inventory', '#dc3545', 'danger', true, 3
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM part_statuses WHERE business_unit_id = bu.id AND status_code = 'out_of_stock');

INSERT INTO part_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, display_order)
SELECT bu.id, 'ordered', 'Ordered', 'Part has been ordered from supplier', '#17a2b8', 'info', true, 4
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM part_statuses WHERE business_unit_id = bu.id AND status_code = 'ordered');

INSERT INTO part_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, display_order)
SELECT bu.id, 'installed', 'Installed', 'Part is currently installed in an asset', '#6f42c1', 'info', true, 5
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM part_statuses WHERE business_unit_id = bu.id AND status_code = 'installed');

-- ============================================================================
-- JOB CARD STATUSES (Configurable per BU)
-- ============================================================================
CREATE TABLE IF NOT EXISTS job_card_statuses (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_unit_id BIGINT NOT NULL,
  status_code VARCHAR(50) NOT NULL,
  status_name VARCHAR(100) NOT NULL,
  description TEXT,
  color VARCHAR(20) DEFAULT '#ffc107',
  badge_style VARCHAR(20) DEFAULT 'warning',
  is_active BOOLEAN DEFAULT true,
  is_system_default BOOLEAN DEFAULT false,
  is_closed_status BOOLEAN DEFAULT false, -- Cannot reopen job from this status
  display_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by CHAR(36),
  CONSTRAINT fk_job_card_statuses_bu FOREIGN KEY (business_unit_id) REFERENCES business_units(id) ON DELETE CASCADE,
  CONSTRAINT fk_job_card_statuses_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  UNIQUE KEY unique_job_card_status_per_bu (business_unit_id, status_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default job card statuses
INSERT INTO job_card_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, is_closed_status, display_order)
SELECT bu.id, 'open', 'Open', 'Job card created, waiting for assignment', '#ffc107', 'warning', true, false, 1
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM job_card_statuses WHERE business_unit_id = bu.id AND status_code = 'open');

INSERT INTO job_card_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, is_closed_status, display_order)
SELECT bu.id, 'assigned', 'Assigned', 'Job has been assigned to a technician', '#17a2b8', 'info', true, false, 2
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM job_card_statuses WHERE business_unit_id = bu.id AND status_code = 'assigned');

INSERT INTO job_card_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, is_closed_status, display_order)
SELECT bu.id, 'in_progress', 'In Progress', 'Technician is actively working on the job', '#007bff', 'info', true, false, 3
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM job_card_statuses WHERE business_unit_id = bu.id AND status_code = 'in_progress');

INSERT INTO job_card_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, is_closed_status, display_order)
SELECT bu.id, 'completed', 'Completed', 'Job has been finished successfully', '#28a745', 'success', true, true, 4
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM job_card_statuses WHERE business_unit_id = bu.id AND status_code = 'completed');

INSERT INTO job_card_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, is_closed_status, display_order)
SELECT bu.id, 'cancelled', 'Cancelled', 'Job was cancelled and will not be completed', '#dc3545', 'danger', true, true, 5
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM job_card_statuses WHERE business_unit_id = bu.id AND status_code = 'cancelled');

-- ============================================================================
-- PRIORITY LEVELS (Configurable per BU)
-- ============================================================================
CREATE TABLE IF NOT EXISTS priority_levels (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_unit_id BIGINT NOT NULL,
  priority_value INT NOT NULL,
  priority_name VARCHAR(100) NOT NULL,
  description TEXT,
  color VARCHAR(20) DEFAULT '#ffc107',
  badge_style VARCHAR(20) DEFAULT 'warning',
  is_active BOOLEAN DEFAULT true,
  display_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by CHAR(36),
  CONSTRAINT fk_priority_levels_bu FOREIGN KEY (business_unit_id) REFERENCES business_units(id) ON DELETE CASCADE,
  CONSTRAINT fk_priority_levels_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  UNIQUE KEY unique_priority_per_bu (business_unit_id, priority_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default priority levels
INSERT INTO priority_levels (business_unit_id, priority_value, priority_name, description, color, badge_style, display_order)
SELECT bu.id, 1, 'Critical', 'Urgent - Must be addressed immediately', '#dc3545', 'danger', 1
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM priority_levels WHERE business_unit_id = bu.id AND priority_value = 1);

INSERT INTO priority_levels (business_unit_id, priority_value, priority_name, description, color, badge_style, display_order)
SELECT bu.id, 2, 'High', 'Important - Should be addressed soon', '#fd7e14', 'warning', 2
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM priority_levels WHERE business_unit_id = bu.id AND priority_value = 2);

INSERT INTO priority_levels (business_unit_id, priority_value, priority_name, description, color, badge_style, display_order)
SELECT bu.id, 3, 'Medium', 'Normal priority - Standard timeline', '#ffc107', 'warning', 3
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM priority_levels WHERE business_unit_id = bu.id AND priority_value = 3);

INSERT INTO priority_levels (business_unit_id, priority_value, priority_name, description, color, badge_style, display_order)
SELECT bu.id, 4, 'Low', 'Can be scheduled later', '#17a2b8', 'info', 4
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM priority_levels WHERE business_unit_id = bu.id AND priority_value = 4);

INSERT INTO priority_levels (business_unit_id, priority_value, priority_name, description, color, badge_style, display_order)
SELECT bu.id, 5, 'Very Low', 'Non-urgent - When time permits', '#6c757d', 'info', 5
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM priority_levels WHERE business_unit_id = bu.id AND priority_value = 5);

-- ============================================================================
-- ASSIGNMENT STATUSES (Configurable per BU)
-- ============================================================================
CREATE TABLE IF NOT EXISTS assignment_statuses (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_unit_id BIGINT NOT NULL,
  status_code VARCHAR(50) NOT NULL,
  status_name VARCHAR(100) NOT NULL,
  description TEXT,
  color VARCHAR(20) DEFAULT '#17a2b8',
  badge_style VARCHAR(20) DEFAULT 'info',
  is_active BOOLEAN DEFAULT true,
  is_system_default BOOLEAN DEFAULT false,
  is_closed_status BOOLEAN DEFAULT false,
  display_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by CHAR(36),
  CONSTRAINT fk_assignment_statuses_bu FOREIGN KEY (business_unit_id) REFERENCES business_units(id) ON DELETE CASCADE,
  CONSTRAINT fk_assignment_statuses_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  UNIQUE KEY unique_assignment_status_per_bu (business_unit_id, status_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default assignment statuses
INSERT INTO assignment_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, is_closed_status, display_order)
SELECT bu.id, 'assigned', 'Assigned', 'Job has been assigned to technician', '#17a2b8', 'info', true, false, 1
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM assignment_statuses WHERE business_unit_id = bu.id AND status_code = 'assigned');

INSERT INTO assignment_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, is_closed_status, display_order)
SELECT bu.id, 'in_progress', 'In Progress', 'Technician is actively working on the job', '#007bff', 'info', true, false, 2
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM assignment_statuses WHERE business_unit_id = bu.id AND status_code = 'in_progress');

INSERT INTO assignment_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, is_closed_status, display_order)
SELECT bu.id, 'completed', 'Completed', 'Job has been finished successfully', '#28a745', 'success', true, true, 3
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM assignment_statuses WHERE business_unit_id = bu.id AND status_code = 'completed');

INSERT INTO assignment_statuses (business_unit_id, status_code, status_name, description, color, badge_style, is_system_default, is_closed_status, display_order)
SELECT bu.id, 'cancelled', 'Cancelled', 'Assignment was cancelled', '#dc3545', 'danger', true, true, 4
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM assignment_statuses WHERE business_unit_id = bu.id AND status_code = 'cancelled');

-- ============================================================================
-- PART CATEGORIES (Configurable per BU)
-- ============================================================================
CREATE TABLE IF NOT EXISTS part_categories (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_unit_id BIGINT NOT NULL,
  category_code VARCHAR(50) NOT NULL,
  category_name VARCHAR(100) NOT NULL,
  description TEXT,
  -- Use an ASCII default to avoid MySQL client/charset issues during schema imports.
  -- UI can still store/display emoji values; this is only the fallback default.
  icon VARCHAR(50) DEFAULT 'tool',
  parent_category_id BIGINT NULL,
  is_active BOOLEAN DEFAULT true,
  display_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by CHAR(36),
  CONSTRAINT fk_part_categories_bu FOREIGN KEY (business_unit_id) REFERENCES business_units(id) ON DELETE CASCADE,
  CONSTRAINT fk_part_categories_parent FOREIGN KEY (parent_category_id) REFERENCES part_categories(id) ON DELETE SET NULL,
  CONSTRAINT fk_part_categories_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  UNIQUE KEY unique_part_category_per_bu (business_unit_id, category_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default part categories
INSERT INTO part_categories (business_unit_id, category_code, category_name, description, icon, display_order)
SELECT bu.id, 'ENGINE', 'Engine Parts', 'Oil filters, air filters, spark plugs, belts', 'gear', 1
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM part_categories WHERE business_unit_id = bu.id AND category_code = 'ENGINE');

INSERT INTO part_categories (business_unit_id, category_code, category_name, description, icon, display_order)
SELECT bu.id, 'BRAKE', 'Brake System', 'Brake pads, rotors, calipers, brake fluid', 'brake', 2
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM part_categories WHERE business_unit_id = bu.id AND category_code = 'BRAKE');

INSERT INTO part_categories (business_unit_id, category_code, category_name, description, icon, display_order)
SELECT bu.id, 'ELECTRICAL', 'Electrical', 'Batteries, alternators, starters, bulbs, fuses', 'electric', 3
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM part_categories WHERE business_unit_id = bu.id AND category_code = 'ELECTRICAL');

INSERT INTO part_categories (business_unit_id, category_code, category_name, description, icon, display_order)
SELECT bu.id, 'SUSPENSION', 'Suspension & Steering', 'Shocks, struts, control arms, tie rods', 'suspension', 4
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM part_categories WHERE business_unit_id = bu.id AND category_code = 'SUSPENSION');

INSERT INTO part_categories (business_unit_id, category_code, category_name, description, icon, display_order)
SELECT bu.id, 'TRANSMISSION', 'Transmission', 'Transmission fluid, clutch kits, CV joints', 'gear', 5
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM part_categories WHERE business_unit_id = bu.id AND category_code = 'TRANSMISSION');

INSERT INTO part_categories (business_unit_id, category_code, category_name, description, icon, display_order)
SELECT bu.id, 'FLUIDS', 'Fluids & Lubricants', 'Engine oil, coolant, brake fluid, grease', 'fluids', 6
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM part_categories WHERE business_unit_id = bu.id AND category_code = 'FLUIDS');

INSERT INTO part_categories (business_unit_id, category_code, category_name, description, icon, display_order)
SELECT bu.id, 'TIRES', 'Tires & Wheels', 'Tires, wheels, valve stems', 'tires', 7
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM part_categories WHERE business_unit_id = bu.id AND category_code = 'TIRES');

INSERT INTO part_categories (business_unit_id, category_code, category_name, description, icon, display_order)
SELECT bu.id, 'BODY', 'Body & Interior', 'Mirrors, handles, wipers, floor mats', 'body', 8
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM part_categories WHERE business_unit_id = bu.id AND category_code = 'BODY');

-- Create indexes
CREATE INDEX idx_asset_statuses_bu ON asset_statuses(business_unit_id);
CREATE INDEX idx_asset_statuses_active ON asset_statuses(is_active);
CREATE INDEX idx_part_statuses_bu ON part_statuses(business_unit_id);
CREATE INDEX idx_part_statuses_active ON part_statuses(is_active);
CREATE INDEX idx_job_card_statuses_bu ON job_card_statuses(business_unit_id);
CREATE INDEX idx_job_card_statuses_active ON job_card_statuses(is_active);
CREATE INDEX idx_priority_levels_bu ON priority_levels(business_unit_id);
CREATE INDEX idx_priority_levels_active ON priority_levels(is_active);
CREATE INDEX idx_assignment_statuses_bu ON assignment_statuses(business_unit_id);
CREATE INDEX idx_assignment_statuses_active ON assignment_statuses(is_active);
CREATE INDEX idx_part_categories_bu ON part_categories(business_unit_id);
CREATE INDEX idx_part_categories_active ON part_categories(is_active);


