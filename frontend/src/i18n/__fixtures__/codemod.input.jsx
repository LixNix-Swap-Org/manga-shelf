// Codemod fixture (input): one case per rule. i18nCodemod.test.js runs the codemod on it and renders both files.
import { useState } from 'react';
import { formatCount, formatEuro } from '../../utils/format.js';
import { notify } from '../../utils/notify.js';

export const SAVED_TEXT = 'Gespeichert.';

const SORT_OPTIONS = [
  { id: 'title', label: 'Titel A–Z' },
  { id: 'added', label: 'Zuletzt hinzugefügt' }
];

function statusText(count) {
  return count === 1 ? 'Ein Band fehlt' : 'Mehrere Bände fehlen';
}

export default function CodemodSample({ user = { username: 'anna' }, count = 3, price = 7.5, volume = { status: 'Fehlt' }, busy = false }) {
  const [error] = useState('');
  const save = () => {
    if (!window.confirm('Änderungen wirklich speichern?')) return;
    notify.success(`Band ${count} gespeichert`, { action: { label: 'Rückgängig', onClick: () => {} } });
  };
  const title = user.username || 'Unbekannter Benutzer';
  return (
    <section aria-label="Beispiel">
      <h2>Einstellungen</h2>
      <p>
        Angemeldet als <strong>{user.username}</strong>.
      </p>
      <p>Du hast {formatCount(count, 'Band', 'Bände')} für {formatEuro(price)} im Regal.</p>
      <button type="button" title="Speichern und schließen" onClick={save}>
        {busy ? 'Speichert…' : 'Speichern'}
      </button>
      <input className="input-field" placeholder={`Suche in ${count} Reihen`} />
      <span>{count === 1 ? 'Band' : 'Bände'}</span>
      <span>Status: {volume.status === 'Fehlt' ? 'fehlt noch' : 'vorhanden'}</span>
      <span>{volume.status}</span>
      <select className="input-field" aria-label="Sortierung">
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
