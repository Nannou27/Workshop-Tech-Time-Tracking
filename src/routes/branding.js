const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../database/connection');
const logger = require('../utils/logger');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

const DB_TYPE = () => (process.env.DB_TYPE || 'postgresql');
const keyColumn = () => (DB_TYPE() === 'mysql' ? '`key`' : 'key');
const placeholder = (n) => (DB_TYPE() === 'mysql' ? '?' : `$${n}`);

function safeJsonParse(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function systemSettingsTableExists() {
  try {
    if (DB_TYPE() === 'mysql') {
      const r = await db.query(`SHOW TABLES LIKE 'system_settings'`);
      return (r.rows || []).length > 0;
    }
    const r = await db.query(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'system_settings') as exists`);
    return !!r.rows?.[0]?.exists;
  } catch {
    return false;
  }
}

async function getSetting(key) {
  const exists = await systemSettingsTableExists();
  if (!exists) return null;
  try {
    const r = await db.query(
      `SELECT value FROM system_settings WHERE ${keyColumn()} = ${placeholder(1)} LIMIT 1`,
      [key]
    );
    if (!r.rows || r.rows.length === 0) return null;
    return safeJsonParse(r.rows[0].value) ?? r.rows[0].value;
  } catch (err) {
    logger.warn('Branding getSetting failed:', err);
    return null;
  }
}

async function upsertSetting(key, value, actorId, description = null, category = 'branding') {
  const exists = await systemSettingsTableExists();
  if (!exists) {
    const e = new Error('system_settings table is missing; cannot save branding settings.');
    e.code = 'SCHEMA_MISMATCH';
    throw e;
  }
  const v = JSON.stringify(value);
  const desc = description || `Branding: ${key}`;

  if (DB_TYPE() === 'mysql') {
    await db.query(
      `INSERT INTO system_settings (${keyColumn()}, value, description, category, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE value = ?, description = ?, category = ?, updated_by = ?, updated_at = NOW()`,
      [key, v, desc, category, actorId, v, desc, category, actorId]
    );
    return;
  }

  await db.query(
    `INSERT INTO system_settings (key, value, description, category, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (key) DO UPDATE
       SET value = $2, description = $3, category = $4, updated_by = $5, updated_at = now()`,
    [key, v, desc, category, actorId]
  );
}

async function deleteSetting(key) {
  const exists = await systemSettingsTableExists();
  if (!exists) return;
  if (DB_TYPE() === 'mysql') {
    await db.query(`DELETE FROM system_settings WHERE ${keyColumn()} = ?`, [key]);
  } else {
    await db.query(`DELETE FROM system_settings WHERE key = $1`, [key]);
  }
}

function defaultBranding() {
  // Fallback palette inspired by the provided Legend Holding Group logo.
  // This is used only when no DB branding is configured yet.
  return {
    system_name: 'WTTT',
    logo_data_url: null,
    colors: {
      primary: '#4B2B7F',   // purple
      secondary: '#0B1F3A', // dark navy
      accent: '#F39C12',    // orange
      background: '#FFFFFF',
      text: '#0B1F3A'
    }
  };
}

function normalizeBranding(raw) {
  const base = defaultBranding();
  const obj = (raw && typeof raw === 'object') ? raw : {};
  const colors = (obj.colors && typeof obj.colors === 'object') ? obj.colors : {};
  return {
    system_name: (obj.system_name || base.system_name),
    logo_data_url: (obj.logo_data_url || null),
    colors: {
      primary: colors.primary || base.colors.primary,
      secondary: colors.secondary || base.colors.secondary,
      accent: colors.accent || base.colors.accent,
      background: colors.background || base.colors.background,
      text: colors.text || base.colors.text
    }
  };
}

// -------------------------
// Public endpoint (login page, unauthenticated)
// -------------------------
router.get('/public', async (req, res) => {
  const global = await getSetting('branding.global');
  const branding = normalizeBranding(global);
  res.json({ data: { ...branding, source: global ? 'global' : 'default' } });
});

// -------------------------
// Authenticated endpoints
// -------------------------
router.use(authenticate);

// Super Admin helper: fetch raw global branding + enforce flag
router.get('/global', requireSuperAdmin, async (req, res, next) => {
  try {
    const global = normalizeBranding(await getSetting('branding.global'));
    const enforce = await getSetting('branding.enforce_global');
    const enforceGlobal = (enforce === true || enforce === 'true' || enforce === 1 || enforce === '1');
    res.json({ data: { ...global, enforce_global: enforceGlobal } });
  } catch (error) {
    logger.error('Branding global fetch error:', error);
    next(error);
  }
});

// Super Admin helper: fetch raw BU override (if any)
router.get('/business-unit/:business_unit_id', requireSuperAdmin, async (req, res, next) => {
  try {
    const buId = String(req.params.business_unit_id);
    const key = `branding.bu.${buId}`;
    const raw = await getSetting(key);
    if (!raw) return res.json({ data: null });
    res.json({ data: normalizeBranding(raw) });
  } catch (error) {
    logger.error('Branding BU fetch error:', error);
    next(error);
  }
});

// GET /api/v1/branding/effective
// Returns effective branding for current user (global or BU override, depending on enforce flag).
router.get('/effective', async (req, res) => {
  try {
    const global = await getSetting('branding.global');
    const enforce = await getSetting('branding.enforce_global');
    const enforceGlobal = (enforce === true || enforce === 'true' || enforce === 1 || enforce === '1');

    const buId = req.user.businessUnitId ? String(req.user.businessUnitId) : null;
    const buKey = buId ? `branding.bu.${buId}` : null;
    const buBranding = (!enforceGlobal && buKey) ? await getSetting(buKey) : null;

    const effective = normalizeBranding(buBranding || global);
    const source = buBranding ? 'business_unit' : (global ? 'global' : 'default');

    res.json({
      data: {
        ...effective,
        source,
        enforce_global: enforceGlobal,
        business_unit_id: buId
      }
    });
  } catch (error) {
    logger.error('Branding effective error:', error);
    res.json({ data: { ...defaultBranding(), source: 'default' } });
  }
});

// Super Admin: update global branding
router.patch(
  '/global',
  requireSuperAdmin,
  [
    body('system_name').optional().isString().isLength({ min: 1, max: 120 }),
    body('logo_data_url').optional({ nullable: true }).isString(),
    body('colors').optional().isObject(),
    body('colors.primary').optional().isString(),
    body('colors.secondary').optional().isString(),
    body('colors.accent').optional().isString(),
    body('colors.background').optional().isString(),
    body('colors.text').optional().isString(),
    body('enforce_global').optional().isBoolean()
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
        });
      }

      const current = normalizeBranding(await getSetting('branding.global'));
      const incoming = req.body || {};

      const nextBranding = normalizeBranding({
        ...current,
        ...incoming,
        colors: { ...(current.colors || {}), ...(incoming.colors || {}) }
      });

      await upsertSetting('branding.global', nextBranding, req.user.id, 'Global branding settings', 'branding');

      if (incoming.enforce_global !== undefined) {
        await upsertSetting('branding.enforce_global', !!incoming.enforce_global, req.user.id, 'Enforce global branding', 'branding');
      }

      await db.query(
        `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
         VALUES ($1, 'branding.global.updated', 'branding', 'global', $2)`,
        [req.user.id, JSON.stringify({ updated: Object.keys(incoming) })]
      );

      res.json({ data: nextBranding });
    } catch (error) {
      logger.error('Branding global update error:', error);
      next(error);
    }
  }
);

// Super Admin: update branding for a Business Unit override
router.patch(
  '/business-unit/:business_unit_id',
  requireSuperAdmin,
  [
    body('system_name').optional().isString().isLength({ min: 1, max: 120 }),
    body('logo_data_url').optional({ nullable: true }).isString(),
    body('colors').optional().isObject(),
    body('colors.primary').optional().isString(),
    body('colors.secondary').optional().isString(),
    body('colors.accent').optional().isString(),
    body('colors.background').optional().isString(),
    body('colors.text').optional().isString()
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
        });
      }

      const buId = String(req.params.business_unit_id);
      const key = `branding.bu.${buId}`;
      const current = normalizeBranding(await getSetting(key));
      const incoming = req.body || {};

      const nextBranding = normalizeBranding({
        ...current,
        ...incoming,
        colors: { ...(current.colors || {}), ...(incoming.colors || {}) }
      });

      await upsertSetting(key, nextBranding, req.user.id, `Branding override for BU ${buId}`, 'branding');

      await db.query(
        `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
         VALUES ($1, 'branding.business_unit.updated', 'branding', $2, $3)`,
        [req.user.id, buId, JSON.stringify({ updated: Object.keys(incoming) })]
      );

      res.json({ data: nextBranding });
    } catch (error) {
      logger.error('Branding BU update error:', error);
      next(error);
    }
  }
);

// Super Admin: clear BU override
router.delete('/business-unit/:business_unit_id', requireSuperAdmin, async (req, res, next) => {
  try {
    const buId = String(req.params.business_unit_id);
    await deleteSetting(`branding.bu.${buId}`);
    await db.query(
      `INSERT INTO audit_logs (actor_id, action, object_type, object_id, details)
       VALUES ($1, 'branding.business_unit.cleared', 'branding', $2, $3)`,
      [req.user.id, buId, JSON.stringify({ business_unit_id: buId })]
    );
    res.json({ message: 'Business Unit branding override cleared' });
  } catch (error) {
    logger.error('Branding BU delete error:', error);
    next(error);
  }
});

module.exports = router;


