const db = require('../database/connection');
const logger = require('../utils/logger');

async function tableExists(tableName) {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const checkQuery =
      dbType === 'mysql'
        ? `SHOW TABLES LIKE '${tableName}'`
        : `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '${tableName}') as exists`;
    const result = await db.query(checkQuery);
    return dbType === 'mysql' ? result.rows.length > 0 : !!result.rows[0]?.exists;
  } catch {
    return false;
  }
}

async function columnExists(tableName, columnName) {
  try {
    const dbType = process.env.DB_TYPE || 'postgresql';
    const checkQuery =
      dbType === 'mysql'
        ? `SHOW COLUMNS FROM ${tableName} LIKE '${columnName}'`
        : `SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = '${tableName}' AND column_name = '${columnName}'
          ) as exists`;
    const result = await db.query(checkQuery);
    return dbType === 'mysql' ? result.rows.length > 0 : !!result.rows[0]?.exists;
  } catch {
    return false;
  }
}

async function getActorRoleAndBu(actorUserId) {
  const dbType = process.env.DB_TYPE || 'postgresql';
  const ph = dbType === 'mysql' ? '?' : '$1';
  const hasBu = await columnExists('users', 'business_unit_id');
  const actorResult = await db.query(
    `SELECT ${hasBu ? 'u.business_unit_id,' : ''} r.name as role_name
     FROM users u
     JOIN roles r ON u.role_id = r.id
     WHERE u.id = ${ph}`,
    [String(actorUserId)]
  );
  return {
    roleName: actorResult.rows[0]?.role_name || null,
    businessUnitId: hasBu ? actorResult.rows[0]?.business_unit_id || null : null
  };
}

async function enforceSameBusinessUnitOrSuperAdmin({ actorUserId, targetUserId }) {
  const dbType = process.env.DB_TYPE || 'postgresql';
  const actor = await getActorRoleAndBu(actorUserId);

  if (!actor.roleName) {
    return { ok: false, error: { code: 'AUTHORIZATION_FAILED', message: 'Role not found' } };
  }

  if (actor.roleName.toLowerCase() === 'super admin') return { ok: true, actor };

  // If schema doesn't have BU scoping columns, skip BU enforcement (legacy DB compatibility).
  const hasBu = await columnExists('users', 'business_unit_id');
  if (!hasBu) return { ok: true, actor };

  if (!actor.businessUnitId) {
    return {
      ok: false,
      error: { code: 'AUTHORIZATION_FAILED', message: 'You must be assigned to a business unit' }
    };
  }

  const ph = dbType === 'mysql' ? '?' : '$1';
  const target = await db.query(`SELECT business_unit_id FROM users WHERE id = ${ph}`, [
    String(targetUserId)
  ]);
  const targetBu = target.rows[0]?.business_unit_id || null;
  if (!targetBu || String(targetBu) !== String(actor.businessUnitId)) {
    return {
      ok: false,
      error: {
        code: 'AUTHORIZATION_FAILED',
        message: 'Cannot manage technicians outside your business unit'
      }
    };
  }

  return { ok: true, actor };
}

function normalizeTechProfileInput(input = {}) {
  return {
    employee_code: input.employee_code ? String(input.employee_code).trim() : null,
    trade: input.trade !== undefined ? (input.trade ? String(input.trade).trim() : null) : undefined,
    hourly_rate:
      input.hourly_rate !== undefined && input.hourly_rate !== null && input.hourly_rate !== ''
        ? Number(input.hourly_rate)
        : input.hourly_rate === null || input.hourly_rate === ''
          ? null
          : undefined,
    max_concurrent_jobs:
      input.max_concurrent_jobs !== undefined && input.max_concurrent_jobs !== null && input.max_concurrent_jobs !== ''
        ? parseInt(input.max_concurrent_jobs, 10)
        : input.max_concurrent_jobs === null || input.max_concurrent_jobs === ''
          ? null
          : undefined,
    skill_tags: Array.isArray(input.skill_tags) ? input.skill_tags : undefined,
    schedule: Array.isArray(input.schedule) ? input.schedule : undefined
  };
}

async function ensureTechnicianProfile({
  actorUserId,
  targetUserId,
  employeeNumberFallback,
  profileInput = {},
  allowUpdate = true
}) {
  const dbType = process.env.DB_TYPE || 'postgresql';

  const techniciansTableExists = await tableExists('technicians');
  if (!techniciansTableExists) {
    return {
      ok: false,
      error: {
        code: 'FEATURE_NOT_AVAILABLE',
        message: 'Technicians feature is not available in this database (technicians table missing).'
      }
    };
  }

  // Authorization / BU scoping
  if (actorUserId) {
    const scopeCheck = await enforceSameBusinessUnitOrSuperAdmin({
      actorUserId,
      targetUserId
    });
    if (!scopeCheck.ok) return scopeCheck;
  }

  // Verify user exists and is Technician role
  const ph = dbType === 'mysql' ? '?' : '$1';
  const hasEmployeeNumber = await columnExists('users', 'employee_number');
  const userResult = await db.query(
    `SELECT u.id, ${hasEmployeeNumber ? 'u.employee_number,' : ''} r.name as role_name
     FROM users u
     JOIN roles r ON u.role_id = r.id
     WHERE u.id = ${ph}`,
    [String(targetUserId)]
  );
  if (userResult.rows.length === 0) {
    return { ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: 'User not found' } };
  }
  if (userResult.rows[0].role_name !== 'Technician') {
    return {
      ok: false,
      error: {
        code: 'INVALID_ROLE',
        message: 'User must have Technician role to create a technician profile'
      }
    };
  }

  const normalized = normalizeTechProfileInput(profileInput);

  // Determine employee_code
  const employeeCode =
    normalized.employee_code ||
    (employeeNumberFallback ? String(employeeNumberFallback).trim() : null) ||
    (hasEmployeeNumber && userResult.rows[0].employee_number
      ? String(userResult.rows[0].employee_number).trim()
      : null) ||
    `TECH${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

  // Check existing profile
  const existing = await db.query(`SELECT user_id FROM technicians WHERE user_id = ${ph}`, [
    String(targetUserId)
  ]);

  // Uniqueness check for employee_code (if column exists / schema supports it)
  const hasEmployeeCode = await columnExists('technicians', 'employee_code');
  if (hasEmployeeCode && employeeCode) {
    const codeCheck = await db.query(
      dbType === 'mysql'
        ? `SELECT user_id FROM technicians WHERE employee_code = ? AND user_id <> ?`
        : `SELECT user_id FROM technicians WHERE employee_code = $1 AND user_id <> $2`,
      [employeeCode, String(targetUserId)]
    );
    if (codeCheck.rows.length > 0) {
      return {
        ok: false,
        error: { code: 'RESOURCE_CONFLICT', message: 'Employee code already exists' }
      };
    }
  }

  if (existing.rows.length === 0) {
    // Create profile
    const trade = normalized.trade === undefined ? null : normalized.trade;
    const hourlyRate = normalized.hourly_rate === undefined ? null : normalized.hourly_rate;
    const maxJobs =
      normalized.max_concurrent_jobs === undefined || normalized.max_concurrent_jobs === null
        ? 3
        : normalized.max_concurrent_jobs;
    const skillTags = normalized.skill_tags === undefined ? [] : normalized.skill_tags;

    if (dbType === 'mysql') {
      await db.query(
        `INSERT INTO technicians (user_id, employee_code, trade, hourly_rate, max_concurrent_jobs, skill_tags)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [String(targetUserId), employeeCode, trade, hourlyRate, maxJobs, JSON.stringify(skillTags)]
      );
    } else {
      await db.query(
        `INSERT INTO technicians (user_id, employee_code, trade, hourly_rate, max_concurrent_jobs, skill_tags)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [String(targetUserId), employeeCode, trade, hourlyRate, maxJobs, JSON.stringify(skillTags)]
      );
    }

    logger.info(`[TECH PROFILE] Created technician profile for user ${targetUserId}`);
  } else if (allowUpdate) {
    // Update profile fields (best-effort) so both flows are consistent
    const updates = [];
    const params = [];
    let idx = 0;

    const pushUpdate = (col, val) => {
      idx += 1;
      updates.push(`${col} = ${dbType === 'mysql' ? '?' : `$${idx}`}`);
      params.push(val);
    };

    if (hasEmployeeCode && employeeCode) pushUpdate('employee_code', employeeCode);
    if (normalized.trade !== undefined) pushUpdate('trade', normalized.trade);
    if (normalized.hourly_rate !== undefined) pushUpdate('hourly_rate', normalized.hourly_rate);
    if (normalized.max_concurrent_jobs !== undefined)
      pushUpdate('max_concurrent_jobs', normalized.max_concurrent_jobs);
    if (normalized.skill_tags !== undefined)
      pushUpdate('skill_tags', JSON.stringify(normalized.skill_tags));

    if (updates.length > 0) {
      if (dbType === 'mysql') {
        params.push(String(targetUserId));
        await db.query(
          `UPDATE technicians SET ${updates.join(', ')}, updated_at = NOW() WHERE user_id = ?`,
          params
        );
      } else {
        params.push(String(targetUserId));
        await db.query(
          `UPDATE technicians SET ${updates.join(', ')}, updated_at = now() WHERE user_id = $${
            idx + 1
          }`,
          params
        );
      }
      logger.info(`[TECH PROFILE] Updated technician profile for user ${targetUserId}`);
    }
  }

  // Schedule upsert (non-blocking if tables missing)
  if (normalized.schedule && normalized.schedule.length > 0) {
    const schedulesTableExists = await tableExists('tech_schedules');
    if (schedulesTableExists) {
      // Replace schedule
      if (dbType === 'mysql') {
        await db.query(`DELETE FROM tech_schedules WHERE technician_id = ?`, [String(targetUserId)]);
        for (const row of normalized.schedule) {
          await db.query(
            `INSERT INTO tech_schedules (technician_id, start_time, end_time, weekday, timezone, is_active)
             VALUES (?, ?, ?, ?, ?, true)`,
            [
              String(targetUserId),
              row.start_time,
              row.end_time,
              row.weekday,
              row.timezone || 'Asia/Dubai'
            ]
          );
        }
      } else {
        await db.query(`DELETE FROM tech_schedules WHERE technician_id = $1`, [String(targetUserId)]);
        for (const row of normalized.schedule) {
          await db.query(
            `INSERT INTO tech_schedules (technician_id, start_time, end_time, weekday, timezone, is_active)
             VALUES ($1, $2, $3, $4, $5, true)`,
            [
              String(targetUserId),
              row.start_time,
              row.end_time,
              row.weekday,
              row.timezone || 'Asia/Dubai'
            ]
          );
        }
      }
    }
  }

  return { ok: true, employee_code: employeeCode };
}

async function findTechnicianIntegrityIssues() {
  const dbType = process.env.DB_TYPE || 'postgresql';
  const techniciansTableExists = await tableExists('technicians');
  if (!techniciansTableExists) return { ok: true, data: { orphans: [], role_mismatches: [] } };

  // Orphans: technician row with no user
  const orphans = await db.query(
    dbType === 'mysql'
      ? `SELECT t.user_id FROM technicians t LEFT JOIN users u ON u.id = t.user_id WHERE u.id IS NULL`
      : `SELECT t.user_id FROM technicians t LEFT JOIN users u ON u.id = t.user_id WHERE u.id IS NULL`
  );

  // Role mismatches: user exists but role is not Technician
  const mismatches = await db.query(
    dbType === 'mysql'
      ? `SELECT t.user_id, r.name as role_name
         FROM technicians t
         JOIN users u ON u.id = t.user_id
         JOIN roles r ON r.id = u.role_id
         WHERE r.name <> 'Technician'`
      : `SELECT t.user_id, r.name as role_name
         FROM technicians t
         JOIN users u ON u.id = t.user_id
         JOIN roles r ON r.id = u.role_id
         WHERE r.name <> 'Technician'`
  );

  return {
    ok: true,
    data: { orphans: orphans.rows || [], role_mismatches: mismatches.rows || [] }
  };
}

module.exports = {
  ensureTechnicianProfile,
  findTechnicianIntegrityIssues
};


