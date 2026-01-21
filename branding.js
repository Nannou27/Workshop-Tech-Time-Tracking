// Dynamic Branding Loader (Global + per-BU)
// - Loads branding from backend (public for login, effective for authenticated portals)
// - Applies CSS variables + logo + system name across pages

(function () {
  const API_BASE_URL = window.API_BASE_URL || '/api/v1';

  function normalizeCurrencyCodeLike(v) { return v; } // placeholder to avoid accidental global collisions

  function safeJson(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try { return JSON.parse(value); } catch { return null; }
  }

  function applyCssVars(colors) {
    const root = document.documentElement;
    const c = colors || {};
    if (c.primary) root.style.setProperty('--brand-primary', c.primary);
    if (c.secondary) root.style.setProperty('--brand-secondary', c.secondary);
    if (c.accent) root.style.setProperty('--brand-accent', c.accent);
    if (c.background) root.style.setProperty('--brand-bg', c.background);
    if (c.text) root.style.setProperty('--brand-text', c.text);
  }

  function setText(selector, text) {
    try {
      const nodes = document.querySelectorAll(selector);
      nodes.forEach(n => { n.textContent = text; });
    } catch {}
  }

  function setLogo(selector, url) {
    try {
      const nodes = document.querySelectorAll(selector);
      nodes.forEach(n => {
        if (!url) {
          n.style.display = 'none';
          return;
        }
        n.style.display = '';
        n.src = url;
      });
    } catch {}
  }

  async function fetchBranding() {
    const accessToken = localStorage.getItem('access_token');
    const endpoint = accessToken ? `${API_BASE_URL}/branding/effective` : `${API_BASE_URL}/branding/public`;
    const headers = {};
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
    const res = await fetch(endpoint, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || 'Failed to load branding');
    return data.data || {};
  }

  function applyBranding(b) {
    const systemName = (b && b.system_name) ? String(b.system_name) : 'WTTT';
    applyCssVars(b.colors || {});

    // Apply system name
    setText('[data-brand="system-name"]', systemName);
    try { document.title = systemName + (document.title ? ` | ${document.title.replace(/^.*\|\s*/, '')}` : ''); } catch {}

    // Apply logo
    setLogo('[data-brand="logo"]', b.logo_data_url || null);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const branding = await fetchBranding();
      applyBranding(branding);
    } catch (err) {
      // Silent fallback: pages already have default CSS variables.
      console.warn('Branding load failed (using defaults):', err.message);
    }
  });
})();


