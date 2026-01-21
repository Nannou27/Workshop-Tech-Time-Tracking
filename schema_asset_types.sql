-- ============================================================================
-- Asset Types Management System
-- Allows Business Unit Admins to define custom asset categories
-- ============================================================================

CREATE TABLE IF NOT EXISTS asset_types (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_unit_id BIGINT NOT NULL,
  type_code VARCHAR(50) NOT NULL,
  type_name VARCHAR(255) NOT NULL,
  description TEXT,
  -- Use an ASCII default to avoid MySQL client/charset issues during schema imports.
  -- UI can still store/display emoji values; this is only the fallback default.
  icon VARCHAR(50) DEFAULT 'factory',
  color VARCHAR(20) DEFAULT '#17a2b8',
  is_active BOOLEAN DEFAULT true,
  display_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by CHAR(36),
  updated_by CHAR(36),
  CONSTRAINT fk_asset_types_business_unit FOREIGN KEY (business_unit_id) REFERENCES business_units(id) ON DELETE CASCADE,
  CONSTRAINT fk_asset_types_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_asset_types_updated_by FOREIGN KEY (updated_by) REFERENCES users(id),
  UNIQUE KEY unique_asset_type_per_bu (business_unit_id, type_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_asset_types_business_unit ON asset_types(business_unit_id);
CREATE INDEX idx_asset_types_active ON asset_types(is_active);
CREATE INDEX idx_asset_types_display_order ON asset_types(display_order);

-- Insert default asset types for existing business units
INSERT INTO asset_types (business_unit_id, type_code, type_name, description, icon, display_order)
SELECT bu.id, 'SERVICE_TOOL', 'Service Tool', 'Diagnostic equipment, hand tools, power tools, etc.', 'tool', 1
FROM business_units bu
WHERE NOT EXISTS (
  SELECT 1 FROM asset_types at 
  WHERE at.business_unit_id = bu.id AND at.type_code = 'SERVICE_TOOL'
);

INSERT INTO asset_types (business_unit_id, type_code, type_name, description, icon, display_order)
SELECT bu.id, 'VEHICLE', 'Vehicle', 'Customer vehicles, fleet cars, service trucks', 'vehicle', 2
FROM business_units bu
WHERE NOT EXISTS (
  SELECT 1 FROM asset_types at 
  WHERE at.business_unit_id = bu.id AND at.type_code = 'VEHICLE'
);

INSERT INTO asset_types (business_unit_id, type_code, type_name, description, icon, display_order)
SELECT bu.id, 'EQUIPMENT', 'Workshop Equipment', 'Fixed equipment like lifts, tire changers, alignment machines', 'factory', 3
FROM business_units bu
WHERE NOT EXISTS (
  SELECT 1 FROM asset_types at 
  WHERE at.business_unit_id = bu.id AND at.type_code = 'EQUIPMENT'
);

INSERT INTO asset_types (business_unit_id, type_code, type_name, description, icon, display_order)
SELECT bu.id, 'LIFTING', 'Lifting Equipment', 'Hydraulic jacks, lifts, hoists', 'gear', 4
FROM business_units bu
WHERE NOT EXISTS (
  SELECT 1 FROM asset_types at 
  WHERE at.business_unit_id = bu.id AND at.type_code = 'LIFTING'
);

INSERT INTO asset_types (business_unit_id, type_code, type_name, description, icon, display_order)
SELECT bu.id, 'DIAGNOSTIC', 'Diagnostic Equipment', 'OBD scanners, multimeters, oscilloscopes', 'diagnostic', 5
FROM business_units bu
WHERE NOT EXISTS (
  SELECT 1 FROM asset_types at 
  WHERE at.business_unit_id = bu.id AND at.type_code = 'DIAGNOSTIC'
);

INSERT INTO asset_types (business_unit_id, type_code, type_name, description, icon, display_order)
SELECT bu.id, 'POWER_TOOL', 'Power Tools', 'Electric drills, impact wrenches, grinders', 'power', 6
FROM business_units bu
WHERE NOT EXISTS (
  SELECT 1 FROM asset_types at 
  WHERE at.business_unit_id = bu.id AND at.type_code = 'POWER_TOOL'
);

INSERT INTO asset_types (business_unit_id, type_code, type_name, description, icon, display_order)
SELECT bu.id, 'HAND_TOOL', 'Hand Tools', 'Wrenches, sockets, screwdrivers, pliers', 'hand', 7
FROM business_units bu
WHERE NOT EXISTS (
  SELECT 1 FROM asset_types at 
  WHERE at.business_unit_id = bu.id AND at.type_code = 'HAND_TOOL'
);


