// Small windows of the desktop app (address + QR, port prompt) as self-contained HTML for data: URLs.

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STYLE = `
:root { color-scheme: light dark; --bg: #f8fafc; --fg: #0f172a; --muted: #475569; --card: #fff; --line: #cbd5e1; --accent: #4f46e5; }
@media (prefers-color-scheme: dark) { :root { --bg: #0f172a; --fg: #e2e8f0; --muted: #94a3b8; --card: #1e293b; --line: #334155; --accent: #818cf8; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 20px; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); }
h1 { font-size: 17px; margin: 0 0 8px; }
p { margin: 0 0 12px; color: var(--muted); }
code { font: 13px ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }
.row { display: flex; gap: 8px; align-items: center; margin: 6px 0; }
.qr { display: block; width: 240px; height: 240px; margin: 12px auto; border-radius: 12px; background: #fff; }
button, input { font: inherit; border-radius: 8px; border: 1px solid var(--line); padding: 6px 12px; background: var(--card); color: var(--fg); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
input { width: 100%; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.error { color: #dc2626; min-height: 1.5em; }
`;

function page(title, body, script = '') {
    return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;
}

/** "Adresse für andere Geräte": the LAN address, the connect link as QR code (svgPath from frontend/src/app/qr.js). */
function addressPage({ address, link, qr, others = [] }) {
    const qrSvg = qr
        ? `<svg class="qr" viewBox="0 0 ${qr.size} ${qr.size}" role="img" aria-label="QR-Code für die Manga-Shelf-App" shape-rendering="crispEdges"><rect width="${qr.size}" height="${qr.size}" fill="#fff"/><path d="${escapeHtml(qr.path)}" fill="#000"/></svg>`
        : '';
    const more = others.length
        ? `<p>Weitere Adressen dieses Computers: ${others.map((a) => `<code>${escapeHtml(a)}</code>`).join(', ')}</p>`
        : '';
    const body = `
<h1>Adresse für andere Geräte</h1>
<p>Handys und andere PCs im selben Netz verbinden sich über diese Adresse. In der Manga-Shelf-App den QR-Code scannen oder die Adresse eintragen.</p>
<div class="row"><code id="address">${escapeHtml(address)}</code><button type="button" data-copy="${escapeHtml(address)}">Adresse kopieren</button></div>
${qrSvg}
<div class="row"><button type="button" data-copy="${escapeHtml(link)}">Verbindungslink kopieren</button></div>
${more}
<p>Unterwegs ist der Server nur über eine öffentliche Adresse oder ein VPN (z. B. Tailscale) erreichbar.</p>`;
    const script = `document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => { window.desktopDialog.copy(b.dataset.copy); b.textContent = 'Kopiert'; }));`;
    return page('Adresse für andere Geräte', body, script);
}

/** Port prompt (1–65535); the value goes back through window.desktopDialog.submit. */
function portPage({ port, hint }) {
    const body = `
<h1>Port des Servers</h1>
<p>${escapeHtml(hint)}</p>
<form id="form" novalidate>
<label for="port">Port (1–65535)</label>
<input id="port" name="port" inputmode="numeric" autocomplete="off" value="${escapeHtml(port)}" aria-describedby="error">
<div id="error" class="error" role="alert"></div>
<div class="actions"><button type="button" id="cancel">Abbrechen</button><button type="submit" class="primary">Übernehmen</button></div>
</form>`;
    const script = `
const input = document.getElementById('port');
input.focus(); input.select();
document.getElementById('cancel').addEventListener('click', () => window.desktopDialog.cancel());
document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  const n = Number(text);
  if (!/^\\d{1,5}$/.test(text) || n < 1 || n > 65535) { document.getElementById('error').textContent = 'Bitte eine Zahl von 1 bis 65535 eingeben.'; return; }
  window.desktopDialog.submit(n);
});`;
    return page('Port ändern', body, script);
}

const dataUrl = (html) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

module.exports = { escapeHtml, addressPage, portPage, dataUrl };
