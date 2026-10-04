// Codemod fixture (input): one case per rule. i18nCodemod.test.js runs the codemod on it and renders both files.
import { useState } from 'react';
import { formatCount, formatEuro } from '../../utils/format.js';
import { notify } from '../../utils/notify.js';
import { rich } from '../react.jsx';
import { t, tn } from '../index.js';

// i18n
export const SAVED_TEXT = 'Gespeichert.';

// i18n
const SORT_OPTIONS = [
  { id: 'title', label: 'Titel A–Z' },
  { id: 'added', label: 'Zuletzt hinzugefügt' }
];

function statusText(count) {
  return tn('Ein Band fehlt', 'Mehrere Bände fehlen', count);
}

export default function CodemodSample({ user = { username: 'anna' }, count = 3, price = 7.5, volume = { status: 'Fehlt' }, busy = false }) {
  const [error] = useState('');
  const save = () => {
    if (!window.confirm(t('Änderungen wirklich speichern?'))) return;
    notify.success(t('Band {count} gespeichert', { count }), { action: { label: t('Rückgängig'), onClick: () => {} } });
  };
  const title = user.username || t('Unbekannter Benutzer');
  return (
    <section aria-label={t('Beispiel')}>
      <h2>{t('Einstellungen')}</h2>
      <p>
        {rich('Angemeldet als {username}.', { username: <strong>{user.username}</strong> })}
      </p>
      <p>{t('Du hast {count} für {price} im Regal.', { count: formatCount(count, 'Band', 'Bände'), price: formatEuro(price) })}</p>
      <button type="button" title={t('Speichern und schließen')} onClick={save}>
        {busy ? t('Speichert…') : t('Speichern')}
      </button>
      <input className="input-field" placeholder={t('Suche in {count} Reihen', { count })} />
      <span>{tn('Band', 'Bände', count)}</span>
      <span>Status: {volume.status === 'Fehlt' ? t('fehlt noch') : 'vorhanden'}</span>
      <span>{volume.status}</span>
      <select className="input-field" aria-label={t('Sortierung')}>
        {SORT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <p>{statusText(count)} {title}</p>
      {error && <p role="alert">{error}</p>}
      <p>
        {'Hinweis: '}
        <em>nur</em> für dich sichtbar.
      </p>
    </section>
  );
}
