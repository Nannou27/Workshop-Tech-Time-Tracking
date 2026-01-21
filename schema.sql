-- ============================================================================
-- Workshop Technician Time Tracking (WTTT) - Database Schema
-- PostgreSQL 14+ Compatible
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- For text search performance

-- ============================================================================
-- ROLES AND USERS
-- ============================================================================

-- Roles table: Defines system roles with fine-grained permissions
CREATE TABLE roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  permissions JSONB NOT NULL DEFAULT '{}', -- Fine-grained permissions
  is_system_role BOOLEAN DEFAULT false, -- System roles cannot be deleted
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Users table: All system users (admins, service advisors, technicians)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  display_name VARCHAR(200) NOT NULL,
  password_hash TEXT, -- NULL if SSO-only user
  role_id INT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  is_active BOOLEAN DEFAULT true,
  is_email_verified BOOLEAN DEFAULT false,
  last_login_at TIMESTAMP WITH TIME ZONE,
  mfa_enabled BOOLEAN DEFAULT false,
  mfa_secret TEXT, -- Encrypted TOTP secret
  sso_provider VARCHAR(50), -- 'saml', 'oidc', 'local', etc.
  sso_external_id VARCHAR(255), -- External SSO user ID
  metadata JSONB DEFAULT '{}', -- Custom fields
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  created_by UUID REFERENCES users(id),
  CONSTRAINT email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
);

-- Technicians table: Extends users with technician-specific information
CREATE TABLE technicians (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  employee_code VARCHAR(50) UNIQUE,
  trade VARCHAR(100), -- e.g., "Mechanic", "Electrician", "Body Shop"
  skill_tags TEXT[], -- Array of skill tags
  hourly_rate DECIMAL(10,2), -- Optional for reporting
  max_concurrent_jobs INT DEFAULT 1, -- Multi-tasking limit
  metadata JSONB DEFAULT '{}', -- Custom fields
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- ============================================================================
-- SCHEDULING
-- ============================================================================

-- Technician schedules: Recurring weekly schedules and exceptions
CREATE TABLE tech_schedules (
  id BIGSERIAL PRIMARY KEY,
  technician_id UUID NOT NULL REFERENCES technicians(user_id) ON DELETE CASCADE,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  weekday SMALLINT NOT NULL, -- 0=Sunday, 1=Monday, ..., 6=Saturday
  timezone VARCHAR(64) DEFAULT 'Asia/Dubai',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT valid_weekday CHECK (weekday BETWEEN 0 AND 6),
  CONSTRAINT valid_time_range CHECK (end_time > start_time)
);

-- Schedule exceptions: One-time schedule changes (holidays, time off, etc.)
CREATE TABLE schedule_exceptions (
  id BIGSERIAL PRIMARY KEY,
  technician_id UUID NOT NULL REFERENCES technicians(user_id) ON DELETE CASCADE,
  exception_date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  is_working_day BOOLEAN DEFAULT false, -- false = day off, true = special working day
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(technician_id, exception_date)
);

-- ============================================================================
-- JOB CARDS
-- ============================================================================

-- Job cards: Work orders/service tickets
CREATE TABLE job_cards (
  id BIGSERIAL PRIMARY KEY,
  job_number VARCHAR(100) UNIQUE NOT NULL,
  customer_name VARCHAR(255),
  vehicle_info JSONB, -- {make, model, year, vin, license_plate, etc.}
  work_type VARCHAR(100), -- Configurable work type
  priority SMALLINT DEFAULT 3, -- 1=Critical, 2=High, 3=Medium, 4=Low, 5=Very Low
  status VARCHAR(50) DEFAULT 'open', -- open, in_progress, on_hold, completed, cancelled
  estimated_hours DECIMAL(5,2),
  actual_hours DECIMAL(5,2), -- Computed from time_logs
  created_by UUID REFERENCES users(id),
  completed_at TIMESTAMP WITH TIME ZONE,
  metadata JSONB DEFAULT '{}', -- Custom fields
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT valid_priority CHECK (priority BETWEEN 1 AND 5)
);

-- Job card notes: Notes and comments on job cards
CREATE TABLE job_card_notes (
  id BIGSERIAL PRIMARY KEY,
  job_card_id BIGINT NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id),
  note_text TEXT NOT NULL,
  is_internal BOOLEAN DEFAULT false, -- Internal notes vs. customer-visible
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Job card attachments: Files and photos attached to job cards
CREATE TABLE job_card_attachments (
  id BIGSERIAL PRIMARY KEY,
  job_card_id BIGINT NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL REFERENCES users(id),
  file_name VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL, -- S3 path or storage path
  file_size BIGINT, -- Bytes
  mime_type VARCHAR(100),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- ============================================================================
-- ASSIGNMENTS
-- ============================================================================

-- Assignments: Links technicians to job cards
CREATE TABLE assignments (
  id BIGSERIAL PRIMARY KEY,
  job_card_id BIGINT NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  technician_id UUID NOT NULL REFERENCES technicians(user_id) ON DELETE CASCADE,
  assigned_by UUID NOT NULL REFERENCES users(id),
  assigned_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  status VARCHAR(50) DEFAULT 'assigned', -- assigned, in_progress, completed, cancelled
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT unique_active_assignment UNIQUE (job_card_id, technician_id, status) 
    WHERE status IN ('assigned', 'in_progress')
);

-- ============================================================================
-- TIME TRACKING
-- ============================================================================

-- Time logs: Individual time tracking segments (start/stop records)
CREATE TABLE time_logs (
  id BIGSERIAL PRIMARY KEY,
  assignment_id BIGINT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  technician_id UUID NOT NULL REFERENCES technicians(user_id) ON DELETE CASCADE,
  job_card_id BIGINT NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
  start_ts TIMESTAMP WITH TIME ZONE NOT NULL,
  end_ts TIMESTAMP WITH TIME ZONE,
  duration_seconds BIGINT GENERATED ALWAYS AS (
    EXTRACT(epoch FROM coalesce(end_ts, now()) - start_ts)::BIGINT
  ) STORED,
  status VARCHAR(30) DEFAULT 'active', -- active, paused, finished, cancelled
  notes TEXT,
  client_start_ts TIMESTAMP WITH TIME ZONE, -- Client-provided timestamp for offline sync
  client_end_ts TIMESTAMP WITH TIME ZONE,
  is_manually_corrected BOOLEAN DEFAULT false,
  correction_reason TEXT,
  corrected_by UUID REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT valid_time_range CHECK (end_ts IS NULL OR end_ts >= start_ts)
);

-- Timer heartbeats: Track active timer health
CREATE TABLE timer_heartbeats (
  id BIGSERIAL PRIMARY KEY,
  time_log_id BIGINT NOT NULL REFERENCES time_logs(id) ON DELETE CASCADE,
  technician_id UUID NOT NULL REFERENCES technicians(user_id) ON DELETE CASCADE,
  heartbeat_ts TIMESTAMP WITH TIME ZONE DEFAULT now(),
  client_ts TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- ============================================================================
-- SYSTEM CONFIGURATION
-- ============================================================================

-- System settings: Global configuration
CREATE TABLE system_settings (
  id SERIAL PRIMARY KEY,
  key VARCHAR(100) UNIQUE NOT NULL,
  value JSONB NOT NULL,
  description TEXT,
  category VARCHAR(50), -- 'netsuite', 'timer', 'general', etc.
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_by UUID REFERENCES users(id)
);

-- Custom field definitions: Meta-fields for job cards and technicians
CREATE TABLE custom_field_definitions (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL, -- 'job_card', 'technician', 'user'
  field_name VARCHAR(100) NOT NULL,
  field_label VARCHAR(200) NOT NULL,
  field_type VARCHAR(50) NOT NULL, -- 'text', 'number', 'date', 'boolean', 'dropdown', 'file'
  field_config JSONB DEFAULT '{}', -- Validation rules, options, etc.
  is_required BOOLEAN DEFAULT false,
  display_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(entity_type, field_name)
);

-- Dashboard configurations: Per-role and per-user dashboard layouts
CREATE TABLE dashboard_configurations (
  id SERIAL PRIMARY KEY,
  role_id INT REFERENCES roles(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  widget_config JSONB NOT NULL, -- Array of widget configurations
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT single_owner CHECK (
    (role_id IS NOT NULL AND user_id IS NULL) OR
    (role_id IS NULL AND user_id IS NOT NULL)
  )
);

-- ============================================================================
-- AUDIT AND LOGGING
-- ============================================================================

-- Audit logs: Comprehensive audit trail
CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID REFERENCES users(id),
  action VARCHAR(200) NOT NULL, -- 'user.created', 'timelog.started', etc.
  object_type VARCHAR(50) NOT NULL, -- 'user', 'job_card', 'timelog', etc.
  object_id TEXT, -- ID of the affected object
  details JSONB DEFAULT '{}', -- Additional context
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- ============================================================================
-- INTEGRATION
-- ============================================================================

-- NetSuite sync queue: Queue for syncing time logs to NetSuite
CREATE TABLE netsuite_sync_queue (
  id BIGSERIAL PRIMARY KEY,
  time_log_id BIGINT REFERENCES time_logs(id) ON DELETE CASCADE,
  assignment_id BIGINT REFERENCES assignments(id) ON DELETE CASCADE,
  job_card_id BIGINT REFERENCES job_cards(id) ON DELETE CASCADE,
  sync_status VARCHAR(50) DEFAULT 'pending', -- pending, processing, completed, failed
  sync_attempts INT DEFAULT 0,
  last_error TEXT,
  netsuite_record_id VARCHAR(255), -- NetSuite record ID after successful sync
  sync_data JSONB, -- Data payload sent to NetSuite
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  processed_at TIMESTAMP WITH TIME ZONE,
  next_retry_at TIMESTAMP WITH TIME ZONE
);

-- Integration logs: Log of all integration attempts
CREATE TABLE integration_logs (
  id BIGSERIAL PRIMARY KEY,
  integration_type VARCHAR(50) NOT NULL, -- 'netsuite', 'erp', etc.
  direction VARCHAR(20) NOT NULL, -- 'outbound', 'inbound'
  status VARCHAR(50) NOT NULL, -- 'success', 'error', 'pending'
  request_payload JSONB,
  response_payload JSONB,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Users indexes
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role_id ON users(role_id);
CREATE INDEX idx_users_is_active ON users(is_active) WHERE is_active = true;
CREATE INDEX idx_users_sso_external_id ON users(sso_external_id) WHERE sso_external_id IS NOT NULL;

-- Technicians indexes
CREATE INDEX idx_technicians_employee_code ON technicians(employee_code) WHERE employee_code IS NOT NULL;

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
-- GIN index for JSONB vehicle_info search
CREATE INDEX idx_job_cards_vehicle_info ON job_cards USING GIN (vehicle_info);
-- GIN index for metadata search
CREATE INDEX idx_job_cards_metadata ON job_cards USING GIN (metadata);

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
CREATE INDEX idx_time_logs_technician_active ON time_logs(technician_id, status) 
  WHERE status = 'active';
-- Date range queries
CREATE INDEX idx_time_logs_start_ts_range ON time_logs USING BRIN (start_ts);
-- Composite for reporting
CREATE INDEX idx_time_logs_tech_job_date ON time_logs(technician_id, job_card_id, start_ts);

-- Timer heartbeat indexes
CREATE INDEX idx_timer_heartbeats_time_log ON timer_heartbeats(time_log_id);
CREATE INDEX idx_timer_heartbeats_technician ON timer_heartbeats(technician_id);
CREATE INDEX idx_timer_heartbeats_ts ON timer_heartbeats(heartbeat_ts);

-- Audit log indexes
CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_object ON audit_logs(object_type, object_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
-- GIN index for JSONB details search
CREATE INDEX idx_audit_logs_details ON audit_logs USING GIN (details);

-- NetSuite sync queue indexes
CREATE INDEX idx_netsuite_sync_queue_status ON netsuite_sync_queue(sync_status);
CREATE INDEX idx_netsuite_sync_queue_time_log ON netsuite_sync_queue(time_log_id);
CREATE INDEX idx_netsuite_sync_queue_next_retry ON netsuite_sync_queue(next_retry_at) 
  WHERE sync_status = 'failed';

-- Integration log indexes
CREATE INDEX idx_integration_logs_type ON integration_logs(integration_type);
CREATE INDEX idx_integration_logs_created_at ON integration_logs(created_at);

-- ============================================================================
-- FUNCTIONS AND TRIGGERS
-- ============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at triggers
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_roles_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_technicians_updated_at BEFORE UPDATE ON technicians
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_job_cards_updated_at BEFORE UPDATE ON job_cards
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_assignments_updated_at BEFORE UPDATE ON assignments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_time_logs_updated_at BEFORE UPDATE ON time_logs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_system_settings_updated_at BEFORE UPDATE ON system_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_custom_field_definitions_updated_at BEFORE UPDATE ON custom_field_definitions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_dashboard_configurations_updated_at BEFORE UPDATE ON dashboard_configurations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to calculate actual_hours for job_card from time_logs
CREATE OR REPLACE FUNCTION update_job_card_actual_hours()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE job_cards
  SET actual_hours = (
    SELECT COALESCE(SUM(duration_seconds), 0) / 3600.0
    FROM time_logs
    WHERE job_card_id = COALESCE(NEW.job_card_id, OLD.job_card_id)
      AND status = 'finished'
  )
  WHERE id = COALESCE(NEW.job_card_id, OLD.job_card_id);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Trigger to update actual_hours when time_logs change
CREATE TRIGGER update_job_card_hours_on_timelog
  AFTER INSERT OR UPDATE OR DELETE ON time_logs
  FOR EACH ROW EXECUTE FUNCTION update_job_card_actual_hours();

-- Function to create audit log entry
CREATE OR REPLACE FUNCTION create_audit_log(
  p_actor_id UUID,
  p_action VARCHAR,
  p_object_type VARCHAR,
  p_object_id TEXT,
  p_details JSONB DEFAULT '{}'::JSONB
)
RETURNS void AS $$
BEGIN
  INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
  VALUES (p_actor_id, p_action, p_object_type, p_object_id, p_details);
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- INITIAL DATA
-- ============================================================================

-- Insert default system roles
INSERT INTO roles (name, description, permissions, is_system_role) VALUES
  ('Admin', 'Full system access', 
   '{"users": ["create", "read", "update", "delete"], "roles": ["create", "read", "update", "delete"], "job_cards": ["create", "read", "update", "delete", "view_all"], "assignments": ["create", "read", "update", "delete", "view_all"], "timelogs": ["read", "update", "delete", "view_all", "correct"], "reports": ["view_all", "export"], "settings": ["read", "update"], "audit": ["read"]}'::JSONB,
   true),
  ('ServiceAdvisor', 'Service advisor access', 
   '{"job_cards": ["create", "read", "update"], "assignments": ["create", "read", "update"], "timelogs": ["read"], "reports": ["view_assigned", "export"]}'::JSONB,
   true),
  ('Technician', 'Technician access', 
   '{"job_cards": ["read_assigned"], "assignments": ["read_assigned"], "timelogs": ["create", "read_own", "update_own"]}'::JSONB,
   true)
ON CONFLICT (name) DO NOTHING;

-- Insert default system settings
INSERT INTO system_settings (key, value, description, category) VALUES
  ('timer.idle_timeout_seconds', '300', 'Idle timeout in seconds (default: 5 minutes)', 'timer'),
  ('timer.multi_tasking_allowed', 'false', 'Allow technicians to have multiple active timers', 'timer'),
  ('timer.heartbeat_interval_seconds', '30', 'Heartbeat interval in seconds', 'timer'),
  ('system.timezone', '"Asia/Dubai"', 'Default system timezone', 'general'),
  ('netsuite.enabled', 'false', 'Enable NetSuite integration', 'netsuite'),
  ('netsuite.sync_mode', '"batch"', 'Sync mode: real-time or batch', 'netsuite'),
  ('netsuite.batch_sync_schedule', '"0 2 * * *"', 'Cron expression for batch sync (default: 2 AM daily)', 'netsuite')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- PARTITIONING (Optional - for very large deployments)
-- ============================================================================

-- Uncomment for time-based partitioning of time_logs (if needed for > 1M rows/month)
/*
-- Create partition function
CREATE OR REPLACE FUNCTION time_logs_partition_function()
RETURNS TRIGGER AS $$
DECLARE
  partition_name TEXT;
  start_date DATE;
  end_date DATE;
BEGIN
  start_date := DATE_TRUNC('month', NEW.start_ts);
  end_date := start_date + INTERVAL '1 month';
  partition_name := 'time_logs_' || TO_CHAR(start_date, 'YYYY_MM');
  
  -- Create partition if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = partition_name
  ) THEN
    EXECUTE format('CREATE TABLE %I PARTITION OF time_logs
      FOR VALUES FROM (%L) TO (%L)',
      partition_name, start_date, end_date);
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Note: This requires converting time_logs to a partitioned table first
-- ALTER TABLE time_logs PARTITION BY RANGE (start_ts);
*/

-- ============================================================================
-- VIEWS (Optional - for common queries)
-- ============================================================================

-- View: Active timers with job card and technician info
CREATE OR REPLACE VIEW active_timers AS
SELECT 
  tl.id AS time_log_id,
  tl.technician_id,
  u.display_name AS technician_name,
  t.employee_code,
  tl.job_card_id,
  jc.job_number,
  jc.customer_name,
  tl.start_ts,
  tl.duration_seconds,
  tl.status,
  a.id AS assignment_id
FROM time_logs tl
JOIN technicians t ON tl.technician_id = t.user_id
JOIN users u ON t.user_id = u.id
JOIN job_cards jc ON tl.job_card_id = jc.id
LEFT JOIN assignments a ON tl.assignment_id = a.id
WHERE tl.status = 'active';

-- View: Technician availability (simplified)
CREATE OR REPLACE VIEW technician_availability AS
SELECT 
  t.user_id AS technician_id,
  u.display_name AS technician_name,
  t.employee_code,
  COUNT(DISTINCT CASE WHEN tl.status = 'active' THEN tl.id END) AS active_timers,
  COUNT(DISTINCT a.id) FILTER (WHERE a.status IN ('assigned', 'in_progress')) AS active_assignments,
  t.max_concurrent_jobs,
  CASE 
    WHEN COUNT(DISTINCT CASE WHEN tl.status = 'active' THEN tl.id END) >= t.max_concurrent_jobs 
    THEN false 
    ELSE true 
  END AS is_available
FROM technicians t
JOIN users u ON t.user_id = u.id
LEFT JOIN time_logs tl ON t.user_id = tl.technician_id AND tl.status = 'active'
LEFT JOIN assignments a ON t.user_id = a.technician_id AND a.status IN ('assigned', 'in_progress')
WHERE u.is_active = true
GROUP BY t.user_id, u.display_name, t.employee_code, t.max_concurrent_jobs;

-- ============================================================================
-- COMMENTS (Documentation)
-- ============================================================================

COMMENT ON TABLE roles IS 'System roles with fine-grained permissions stored as JSONB';
COMMENT ON TABLE users IS 'All system users with authentication and authorization';
COMMENT ON TABLE technicians IS 'Technician-specific information extending users table';
COMMENT ON TABLE tech_schedules IS 'Recurring weekly schedules for technicians';
COMMENT ON TABLE schedule_exceptions IS 'One-time schedule changes (holidays, time off)';
COMMENT ON TABLE job_cards IS 'Work orders/service tickets';
COMMENT ON TABLE assignments IS 'Links technicians to job cards';
COMMENT ON TABLE time_logs IS 'Time tracking segments - each start/stop creates a record';
COMMENT ON TABLE timer_heartbeats IS 'Health check for active timers';
COMMENT ON TABLE audit_logs IS 'Comprehensive audit trail for all system actions';
COMMENT ON TABLE system_settings IS 'Global system configuration';
COMMENT ON TABLE custom_field_definitions IS 'Dynamic field definitions for job cards and technicians';
COMMENT ON TABLE dashboard_configurations IS 'Dashboard widget configurations per role/user';
COMMENT ON TABLE netsuite_sync_queue IS 'Queue for syncing time logs to NetSuite';
COMMENT ON TABLE integration_logs IS 'Log of all integration attempts';

COMMENT ON COLUMN time_logs.duration_seconds IS 'Computed field: EXTRACT(epoch FROM end_ts - start_ts). NULL end_ts uses now()';
COMMENT ON COLUMN time_logs.client_start_ts IS 'Client-provided timestamp for offline sync reconciliation';
COMMENT ON COLUMN time_logs.is_manually_corrected IS 'Flag indicating manual time correction with audit trail';

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================

