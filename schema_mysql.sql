-- ============================================================================
-- Workshop Technician Time Tracking (WTTT) - Database Schema
-- MySQL 8.0+ Compatible (for XAMPP)
-- ============================================================================

-- Create database (run this first if database doesn't exist)
-- CREATE DATABASE wttt CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- USE wttt;

-- ============================================================================
-- ROLES AND USERS
-- ============================================================================

-- Roles table: Defines system roles with fine-grained permissions
CREATE TABLE IF NOT EXISTS roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  permissions JSON NOT NULL DEFAULT ('{}'), -- Fine-grained permissions
  is_system_role BOOLEAN DEFAULT false, -- System roles cannot be deleted
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Users table: All system users (admins, service advisors, technicians)
CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()), -- UUID stored as CHAR(36)
  email VARCHAR(255) UNIQUE NOT NULL,
  display_name VARCHAR(200) NOT NULL,
  password_hash TEXT, -- NULL if SSO-only user
  role_id INT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  is_email_verified BOOLEAN DEFAULT false,
  last_login_at TIMESTAMP NULL,
  mfa_enabled BOOLEAN DEFAULT false,
  mfa_secret TEXT, -- Encrypted TOTP secret
  sso_provider VARCHAR(50), -- 'saml', 'oidc', 'local', etc.
  sso_external_id VARCHAR(255), -- External SSO user ID
  metadata JSON DEFAULT ('{}'), -- Custom fields
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by CHAR(36),
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT,
  CONSTRAINT fk_users_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT chk_email_format CHECK (email REGEXP '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Technicians table: Extends users with technician-specific information
CREATE TABLE IF NOT EXISTS technicians (
  user_id CHAR(36) PRIMARY KEY,
  employee_code VARCHAR(50) UNIQUE,
  trade VARCHAR(100), -- e.g., "Mechanic", "Electrician", "Body Shop"
  skill_tags JSON, -- Array of skill tags
  hourly_rate DECIMAL(10,2), -- Optional for reporting
  max_concurrent_jobs INT DEFAULT 1, -- Multi-tasking limit
  metadata JSON DEFAULT ('{}'), -- Custom fields
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_technicians_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- SCHEDULING
-- ============================================================================

-- Technician schedules: Recurring weekly schedules and exceptions
CREATE TABLE IF NOT EXISTS tech_schedules (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  technician_id CHAR(36) NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  weekday TINYINT NOT NULL, -- 0=Sunday, 1=Monday, ..., 6=Saturday
  timezone VARCHAR(64) DEFAULT 'Asia/Dubai',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_tech_schedules_technician FOREIGN KEY (technician_id) REFERENCES technicians(user_id) ON DELETE CASCADE,
  CONSTRAINT chk_valid_weekday CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT chk_valid_time_range CHECK (end_time > start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Schedule exceptions: One-time schedule changes (holidays, time off, etc.)
CREATE TABLE IF NOT EXISTS schedule_exceptions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  technician_id CHAR(36) NOT NULL,
  exception_date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  is_working_day BOOLEAN DEFAULT false, -- false = day off, true = special working day
  reason TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_schedule_exceptions_technician FOREIGN KEY (technician_id) REFERENCES technicians(user_id) ON DELETE CASCADE,
  UNIQUE KEY unique_tech_exception (technician_id, exception_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- JOB CARDS
-- ============================================================================

-- Job cards: Work orders/service tickets
CREATE TABLE IF NOT EXISTS job_cards (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  job_number VARCHAR(100) UNIQUE NOT NULL,
  customer_name VARCHAR(255),
  vehicle_info JSON, -- {make, model, year, vin, license_plate, etc.}
  work_type VARCHAR(100), -- Configurable work type
  priority TINYINT DEFAULT 3, -- 1=Critical, 2=High, 3=Medium, 4=Low, 5=Very Low
  status VARCHAR(50) DEFAULT 'open', -- open, in_progress, on_hold, completed, cancelled
  estimated_hours DECIMAL(5,2),
  actual_hours DECIMAL(5,2), -- Computed from time_logs
  created_by CHAR(36),
  completed_at TIMESTAMP NULL,
  metadata JSON DEFAULT ('{}'), -- Custom fields
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_job_cards_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT chk_valid_priority CHECK (priority BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Job card notes: Notes and comments on job cards
CREATE TABLE IF NOT EXISTS job_card_notes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  job_card_id BIGINT NOT NULL,
  author_id CHAR(36) NOT NULL,
  note_text TEXT NOT NULL,
  is_internal BOOLEAN DEFAULT false, -- Internal notes vs. customer-visible
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_job_card_notes_job_card FOREIGN KEY (job_card_id) REFERENCES job_cards(id) ON DELETE CASCADE,
  CONSTRAINT fk_job_card_notes_author FOREIGN KEY (author_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Job card attachments: Files and photos attached to job cards
CREATE TABLE IF NOT EXISTS job_card_attachments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  job_card_id BIGINT NOT NULL,
  uploaded_by CHAR(36) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL, -- S3 path or storage path
  file_size BIGINT, -- Bytes
  mime_type VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_job_card_attachments_job_card FOREIGN KEY (job_card_id) REFERENCES job_cards(id) ON DELETE CASCADE,
  CONSTRAINT fk_job_card_attachments_uploaded_by FOREIGN KEY (uploaded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- ASSIGNMENTS
-- ============================================================================

-- Assignments: Links technicians to job cards
CREATE TABLE IF NOT EXISTS assignments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  job_card_id BIGINT NOT NULL,
  technician_id CHAR(36) NOT NULL,
  assigned_by CHAR(36) NOT NULL,
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(50) DEFAULT 'assigned', -- assigned, in_progress, completed, cancelled
  started_at TIMESTAMP NULL,
  completed_at TIMESTAMP NULL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_assignments_job_card FOREIGN KEY (job_card_id) REFERENCES job_cards(id) ON DELETE CASCADE,
  CONSTRAINT fk_assignments_technician FOREIGN KEY (technician_id) REFERENCES technicians(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_assignments_assigned_by FOREIGN KEY (assigned_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- TIME TRACKING
-- ============================================================================

-- Time logs: Individual time tracking segments (start/stop records)
CREATE TABLE IF NOT EXISTS time_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  assignment_id BIGINT NOT NULL,
  technician_id CHAR(36) NOT NULL,
  job_card_id BIGINT NOT NULL,
  start_ts TIMESTAMP NOT NULL,
  end_ts TIMESTAMP NULL,
  duration_seconds BIGINT DEFAULT 0, -- Calculated in application or via trigger
  status VARCHAR(30) DEFAULT 'active', -- active, paused, finished, cancelled
  notes TEXT,
  client_start_ts TIMESTAMP NULL, -- Client-provided timestamp for offline sync
  client_end_ts TIMESTAMP NULL,
  is_manually_corrected BOOLEAN DEFAULT false,
  correction_reason TEXT,
  corrected_by CHAR(36),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_time_logs_assignment FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
  CONSTRAINT fk_time_logs_technician FOREIGN KEY (technician_id) REFERENCES technicians(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_time_logs_job_card FOREIGN KEY (job_card_id) REFERENCES job_cards(id) ON DELETE CASCADE,
  CONSTRAINT fk_time_logs_corrected_by FOREIGN KEY (corrected_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Timer heartbeats: Track active timer health
CREATE TABLE IF NOT EXISTS timer_heartbeats (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  time_log_id BIGINT NOT NULL,
  technician_id CHAR(36) NOT NULL,
  heartbeat_ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  client_ts TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_timer_heartbeats_time_log FOREIGN KEY (time_log_id) REFERENCES time_logs(id) ON DELETE CASCADE,
  CONSTRAINT fk_timer_heartbeats_technician FOREIGN KEY (technician_id) REFERENCES technicians(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- SYSTEM CONFIGURATION
-- ============================================================================

-- System settings: Global configuration
CREATE TABLE IF NOT EXISTS system_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  `key` VARCHAR(100) UNIQUE NOT NULL,
  value JSON NOT NULL,
  description TEXT,
  category VARCHAR(50), -- 'netsuite', 'timer', 'general', etc.
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by CHAR(36),
  CONSTRAINT fk_system_settings_updated_by FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Custom field definitions: Meta-fields for job cards and technicians
CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL, -- 'job_card', 'technician', 'user'
  field_name VARCHAR(100) NOT NULL,
  field_label VARCHAR(200) NOT NULL,
  field_type VARCHAR(50) NOT NULL, -- 'text', 'number', 'date', 'boolean', 'dropdown', 'file'
  field_config JSON DEFAULT ('{}'), -- Validation rules, options, etc.
  is_required BOOLEAN DEFAULT false,
  display_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_entity_field (entity_type, field_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Dashboard configurations: Per-role and per-user dashboard layouts
CREATE TABLE IF NOT EXISTS dashboard_configurations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  role_id INT,
  user_id CHAR(36),
  widget_config JSON NOT NULL, -- Array of widget configurations
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_dashboard_configurations_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  CONSTRAINT fk_dashboard_configurations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_single_owner CHECK ((role_id IS NOT NULL AND user_id IS NULL) OR (role_id IS NULL AND user_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- AUDIT AND LOGGING
-- ============================================================================

-- Audit logs: Comprehensive audit trail
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_id CHAR(36),
  action VARCHAR(200) NOT NULL, -- 'user.created', 'timelog.started', etc.
  object_type VARCHAR(50) NOT NULL, -- 'user', 'job_card', 'timelog', etc.
  object_id TEXT, -- ID of the affected object
  details JSON DEFAULT ('{}'), -- Additional context
  ip_address VARCHAR(45), -- IPv4 or IPv6
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_logs_actor FOREIGN KEY (actor_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- INTEGRATION
-- ============================================================================

-- NetSuite sync queue: Queue for syncing time logs to NetSuite
CREATE TABLE IF NOT EXISTS netsuite_sync_queue (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  time_log_id BIGINT,
  assignment_id BIGINT,
  job_card_id BIGINT,
  sync_status VARCHAR(50) DEFAULT 'pending', -- pending, processing, completed, failed
  sync_attempts INT DEFAULT 0,
  last_error TEXT,
  netsuite_record_id VARCHAR(255), -- NetSuite record ID after successful sync
  sync_data JSON, -- Data payload sent to NetSuite
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP NULL,
  next_retry_at TIMESTAMP NULL,
  CONSTRAINT fk_netsuite_sync_queue_time_log FOREIGN KEY (time_log_id) REFERENCES time_logs(id) ON DELETE CASCADE,
  CONSTRAINT fk_netsuite_sync_queue_assignment FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE CASCADE,
  CONSTRAINT fk_netsuite_sync_queue_job_card FOREIGN KEY (job_card_id) REFERENCES job_cards(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Integration logs: Log of all integration attempts
CREATE TABLE IF NOT EXISTS integration_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  integration_type VARCHAR(50) NOT NULL, -- 'netsuite', 'erp', etc.
  direction VARCHAR(20) NOT NULL, -- 'outbound', 'inbound'
  status VARCHAR(50) NOT NULL, -- 'success', 'error', 'pending'
  request_payload JSON,
  response_payload JSON,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Users indexes
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role_id ON users(role_id);
CREATE INDEX idx_users_is_active ON users(is_active);
CREATE INDEX idx_users_sso_external_id ON users(sso_external_id);

-- Technicians indexes
CREATE INDEX idx_technicians_employee_code ON technicians(employee_code);

-- Schedule indexes
CREATE INDEX idx_tech_schedules_technician ON tech_schedules(technician_id, weekday, is_active);
CREATE INDEX idx_schedule_exceptions_technician_date ON schedule_exceptions(technician_id, exception_date);

-- Job card indexes
CREATE INDEX idx_job_cards_job_number ON job_cards(job_number);
CREATE INDEX idx_job_cards_status ON job_cards(status);
CREATE INDEX idx_job_cards_created_by ON job_cards(created_by);
CREATE INDEX idx_job_cards_created_at ON job_cards(created_at);
CREATE INDEX idx_job_cards_priority ON job_cards(priority);
CREATE INDEX idx_job_cards_work_type ON job_cards(work_type);

-- Job card notes indexes
CREATE INDEX idx_job_card_notes_job_card ON job_card_notes(job_card_id);
CREATE INDEX idx_job_card_notes_created_at ON job_card_notes(created_at);

-- Job card attachments indexes
CREATE INDEX idx_job_card_attachments_job_card ON job_card_attachments(job_card_id);

-- Assignment indexes
CREATE INDEX idx_assignments_job_card ON assignments(job_card_id);
CREATE INDEX idx_assignments_technician ON assignments(technician_id);
CREATE INDEX idx_assignments_status ON assignments(status);
CREATE INDEX idx_assignments_assigned_at ON assignments(assigned_at);
CREATE INDEX idx_assignments_tech_status ON assignments(technician_id, status);

-- Time log indexes (critical for performance)
CREATE INDEX idx_time_logs_assignment ON time_logs(assignment_id);
CREATE INDEX idx_time_logs_technician ON time_logs(technician_id);
CREATE INDEX idx_time_logs_job_card ON time_logs(job_card_id);
CREATE INDEX idx_time_logs_start_ts ON time_logs(start_ts);
CREATE INDEX idx_time_logs_status ON time_logs(status);
-- Critical: Active timer lookup
CREATE INDEX idx_time_logs_technician_active ON time_logs(technician_id, status);
-- Composite for reporting
CREATE INDEX idx_time_logs_tech_job_date ON time_logs(technician_id, job_card_id, start_ts);

-- Timer heartbeat indexes
CREATE INDEX idx_timer_heartbeats_time_log ON timer_heartbeats(time_log_id);
CREATE INDEX idx_timer_heartbeats_technician ON timer_heartbeats(technician_id);
CREATE INDEX idx_timer_heartbeats_ts ON timer_heartbeats(heartbeat_ts);

-- Audit log indexes
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_object ON audit_logs(object_type, object_id(100));
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);

-- NetSuite sync queue indexes
CREATE INDEX idx_netsuite_sync_queue_status ON netsuite_sync_queue(sync_status);
CREATE INDEX idx_netsuite_sync_queue_time_log ON netsuite_sync_queue(time_log_id);
CREATE INDEX idx_netsuite_sync_queue_next_retry ON netsuite_sync_queue(next_retry_at);

-- Integration log indexes
CREATE INDEX idx_integration_logs_type ON integration_logs(integration_type);
CREATE INDEX idx_integration_logs_created_at ON integration_logs(created_at);

-- ============================================================================
-- INITIAL DATA
-- ============================================================================

-- Insert default system roles
INSERT INTO roles (name, description, permissions, is_system_role) VALUES
  ('Admin', 'Full system access', 
   '{"users": ["create", "read", "update", "delete"], "roles": ["create", "read", "update", "delete"], "job_cards": ["create", "read", "update", "delete", "view_all"], "assignments": ["create", "read", "update", "delete", "view_all"], "timelogs": ["read", "update", "delete", "view_all", "correct"], "reports": ["view_all", "export"], "settings": ["read", "update"], "audit": ["read"]}',
   true),
  ('ServiceAdvisor', 'Service advisor access', 
   '{"job_cards": ["create", "read", "update"], "assignments": ["create", "read", "update"], "timelogs": ["read"], "reports": ["view_assigned", "export"]}',
   true),
  ('Technician', 'Technician access', 
   '{"job_cards": ["read_assigned"], "assignments": ["read_assigned"], "timelogs": ["create", "read_own", "update_own"]}',
   true)
ON DUPLICATE KEY UPDATE name=name;

-- Insert default system settings
INSERT INTO system_settings (`key`, value, description, category) VALUES
  ('timer.idle_timeout_seconds', '"300"', 'Idle timeout in seconds (default: 5 minutes)', 'timer'),
  ('timer.multi_tasking_allowed', '"false"', 'Allow technicians to have multiple active timers', 'timer'),
  ('timer.heartbeat_interval_seconds', '"30"', 'Heartbeat interval in seconds', 'timer'),
  ('system.timezone', '"Asia/Dubai"', 'Default system timezone', 'general'),
  ('netsuite.enabled', '"false"', 'Enable NetSuite integration', 'netsuite'),
  ('netsuite.sync_mode', '"batch"', 'Sync mode: real-time or batch', 'netsuite'),
  ('netsuite.batch_sync_schedule', '"0 2 * * *"', 'Cron expression for batch sync (default: 2 AM daily)', 'netsuite')
ON DUPLICATE KEY UPDATE `key`=`key`;

-- Trigger to calculate duration_seconds when end_ts is updated
DELIMITER //
CREATE TRIGGER IF NOT EXISTS update_time_log_duration
BEFORE UPDATE ON time_logs
FOR EACH ROW
BEGIN
  IF NEW.end_ts IS NOT NULL AND NEW.end_ts != OLD.end_ts THEN
    SET NEW.duration_seconds = TIMESTAMPDIFF(SECOND, NEW.start_ts, NEW.end_ts);
  ELSEIF NEW.end_ts IS NULL AND OLD.end_ts IS NOT NULL THEN
    SET NEW.duration_seconds = 0;
  ELSEIF NEW.end_ts IS NULL THEN
    SET NEW.duration_seconds = TIMESTAMPDIFF(SECOND, NEW.start_ts, NOW());
  END IF;
END//
DELIMITER ;

-- Trigger to calculate duration_seconds on insert
DELIMITER //
CREATE TRIGGER IF NOT EXISTS insert_time_log_duration
BEFORE INSERT ON time_logs
FOR EACH ROW
BEGIN
  IF NEW.end_ts IS NOT NULL THEN
    SET NEW.duration_seconds = TIMESTAMPDIFF(SECOND, NEW.start_ts, NEW.end_ts);
  ELSE
    SET NEW.duration_seconds = 0;
  END IF;
END//
DELIMITER ;

