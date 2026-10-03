import { useState, useEffect } from 'react';
import { CalendarClock, Check } from 'lucide-react';

const formatDate = (d) => {
  const m = String(d || '').match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return d || '–';
  return m[3] ? `${m[3]}.${m[2]}.${m[1]}` : `${m[2]}.${m[1]}`;
};

/** Hinweis auf Vorbestellungen, deren Termin im Manga-Passion-Kalender inzwischen anders lautet; mit 1-Klick-Übernahme. */
export default function PersonalDateChanges({ canEdit, fetchReleaseRadar }) {
  const [changes, setChanges] = useState([]);
  const [applyingId, setApplyingId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/release-radar/changes');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setChanges(data.changes || []);
      } catch (_) { /* offline: kein Hinweis */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const apply = async (change) => {
    setApplyingId(change.volume_id);
    try {
      const res = await fetch(`/api/volumes/${change.volume_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ release_date: change.new_date })
      });
      if (res.ok) {
        setChanges(prev => prev.filter(c => c.volume_id !== change.volume_id));
        fetchReleaseRadar();
      } else {
        const err = await res.json().catch(() => ({}));
        alert(err.error || 'Termin konnte nicht übernommen werden');
      }
    } catch (_) {
      alert('Netzwerkfehler');
    } finally {
      setApplyingId(null);
    }
  };

  if (changes.length === 0) return null;
  return (
    <div id="radar-date-changes" className="bg-amber-500/10 border border-amber-500/30 text-amber-200 p-4 rounded-2xl text-xs space-y-2.5">
      <p className="font-bold text-sm text-amber-300 flex items-center gap-2">
        <CalendarClock className="w-4 h-4" /> Neue Termine bei Manga Passion ({changes.length})
      </p>
      <ul className="space-y-2">
        {changes.map(c => (
          <li key={c.volume_id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <span>
              <strong>{c.manga_title} {c.volume_number}</strong>: {formatDate(c.stored_date)} → <strong>{formatDate(c.new_date)}</strong>
            </span>
            {canEdit && (
              <button
                type="button"
                onClick={() => apply(c)}
                disabled={applyingId === c.volume_id}
                className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5 self-start sm:self-auto disabled:opacity-50"
              >
                <Check className="w-3.5 h-3.5" /> Termin übernehmen
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
