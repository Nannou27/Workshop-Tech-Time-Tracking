-- ============================================================================
-- Technician Efficiency & Productivity Tracking
-- ============================================================================

-- Add shift/clock tracking to time_logs if not exists
ALTER TABLE time_logs 
ADD COLUMN IF NOT EXISTS is_shift_time BOOLEAN DEFAULT false COMMENT 'True if this is clock-in/clock-out time, false if job time',
ADD COLUMN IF NOT EXISTS shift_type VARCHAR(20) COMMENT 'clock_in, clock_out, break_start, break_end';

-- Create technician shifts table for tracking total clocked hours
CREATE TABLE IF NOT EXISTS technician_shifts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  technician_id CHAR(36) NOT NULL,
  business_unit_id BIGINT,
  shift_date DATE NOT NULL,
  clock_in_time TIMESTAMP NOT NULL,
  clock_out_time TIMESTAMP NULL,
  break_seconds BIGINT DEFAULT 0 COMMENT 'Total break time in seconds',
  worked_seconds BIGINT DEFAULT 0 COMMENT 'Time spent on billable jobs',
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_shifts_technician FOREIGN KEY (technician_id) REFERENCES technicians(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_shifts_business_unit FOREIGN KEY (business_unit_id) REFERENCES business_units(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_shifts_technician ON technician_shifts(technician_id);
CREATE INDEX idx_shifts_date ON technician_shifts(shift_date);
CREATE INDEX idx_shifts_business_unit ON technician_shifts(business_unit_id);

-- Create comprehensive technician metrics view (MySQL compatible)
CREATE OR REPLACE VIEW technician_performance_metrics AS
SELECT 
  t.user_id as technician_id,
  u.display_name as technician_name,
  t.employee_code,
  u.business_unit_id,
  bu.name as business_unit_name,
  
  -- Job statistics
  COUNT(DISTINCT CASE WHEN jc.status = 'completed' THEN jc.id END) as completed_jobs,
  COUNT(DISTINCT jc.id) as total_jobs_assigned,
  
  -- Time statistics (from job time logs)
  COALESCE(SUM(CASE WHEN jc.status = 'completed' THEN jc.estimated_hours ELSE 0 END), 0) as total_billed_hours,
  COALESCE(SUM(CASE WHEN jc.status = 'completed' THEN jc.actual_hours ELSE 0 END), 0) as total_worked_hours,
  
  -- Shift statistics (total clocked time) - calculated dynamically
  COALESCE(SUM(
    CASE 
      WHEN ts.clock_out_time IS NOT NULL 
      THEN TIMESTAMPDIFF(SECOND, ts.clock_in_time, ts.clock_out_time)
      ELSE TIMESTAMPDIFF(SECOND, ts.clock_in_time, NOW())
    END
  ), 0) / 3600.0 as total_clocked_hours,
  COALESCE(SUM(ts.break_seconds), 0) / 3600.0 as total_break_hours,
  
  -- EFFICIENCY = Billed Hours / Worked Hours * 100
  -- Higher is better (completing jobs faster than estimated)
  CASE 
    WHEN SUM(CASE WHEN jc.status = 'completed' THEN jc.actual_hours ELSE 0 END) > 0
    THEN (SUM(CASE WHEN jc.status = 'completed' THEN jc.estimated_hours ELSE 0 END) / 
          SUM(CASE WHEN jc.status = 'completed' THEN jc.actual_hours ELSE 0 END)) * 100
    ELSE 0
  END as efficiency_percent,
  
  -- PRODUCTIVITY = Worked Hours / Total Clocked Hours * 100
  -- Higher is better (more time on billable work)
  CASE 
    WHEN SUM(
      CASE 
        WHEN ts.clock_out_time IS NOT NULL 
        THEN TIMESTAMPDIFF(SECOND, ts.clock_in_time, ts.clock_out_time)
        ELSE TIMESTAMPDIFF(SECOND, ts.clock_in_time, NOW())
      END
    ) > 0
    THEN (SUM(CASE WHEN jc.status = 'completed' THEN jc.actual_hours ELSE 0 END) / 
          (SUM(
            CASE 
              WHEN ts.clock_out_time IS NOT NULL 
              THEN TIMESTAMPDIFF(SECOND, ts.clock_in_time, ts.clock_out_time)
              ELSE TIMESTAMPDIFF(SECOND, ts.clock_in_time, NOW())
            END
          ) / 3600.0)) * 100
    ELSE 0
  END as productivity_percent

FROM technicians t
JOIN users u ON t.user_id = u.id
LEFT JOIN business_units bu ON u.business_unit_id = bu.id
LEFT JOIN assignments a ON t.user_id = a.technician_id
LEFT JOIN job_cards jc ON a.job_card_id = jc.id
LEFT JOIN technician_shifts ts ON t.user_id = ts.technician_id
WHERE u.is_active = true
GROUP BY t.user_id, u.display_name, t.employee_code, u.business_unit_id, bu.name;

-- Comments for documentation
-- technician_shifts: Tracks technician clock in/out times for productivity calculation
-- break_seconds: Total unpaid break time
-- worked_seconds: Time spent on billable jobs (updated from time_logs)

