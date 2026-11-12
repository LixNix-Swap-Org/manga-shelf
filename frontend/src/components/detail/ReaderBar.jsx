import { useEffect, useId, useRef, useState } from 'react';
import { BookOpen, Check, ChevronDown, Users } from 'lucide-react';
import { localDateString } from '../../hooks/useVolumeActions';
import { rich } from '../../i18n/react.jsx';
import { t } from '../../i18n/index.js';
import OwnerFilterBar, { ownerChoices, Radio } from './OwnerFilterBar';

const shortDate = (iso) => {
  const [y, m, d] = String(iso).split('-');
  return d && m && y ? `${d}.${m}.${y}` : iso;
};

/**
 * The reading row of the detail page: one chip for "who reads, whose volumes" ("Max liest | Alle Bände"), the
 * "+ Band n gelesen" button and the read / unread progress of the shown reader. The chip opens a panel with the reader
 * choice ("Wer liest?"), the ownership filter ("Wessen Bände zeigen?", `owners`, only with two or more people) and the
 * "Gelesen am" date for the next read toggles (with setReadDate and canToggle; an empty field means now). The panel stays
 * mounted while closed, so its labels keep working for assistive tech and tests. With `onMarkNextRead`, "+ Band n gelesen"
 * marks the first owned volume the shown reader has not read (undo from the toast, like a tick on the volume).
 */
export default function ReaderBar({
  readers, selectedReaderId, setSelectedReaderId, user, ownedCount, currentReaderReadCount, currentReaderUnreadCount,
  canToggle = false, readDate = null, setReadDate, nextUnreadVolume = null, onMarkNextRead, owners = null
}) {
  const dateId = useId();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => rootRef.current && !rootRef.current.contains(e.target);
    const onPointer = (e) => { if (outside(e)) setOpen(false); };
    const onFocus = (e) => { if (outside(e)) setOpen(false); };
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (readers.length === 0) return null;
  // reads of volumes that are not (or no longer) owned must not push the bar past 100 %
  const readOfOwned = Math.min(currentReaderReadCount, ownedCount);
  const pct = ownedCount > 0 ? Math.min(100, Math.round((readOfOwned / ownedCount) * 100)) : 0;
  const unread = Math.max(0, currentReaderUnreadCount);

  const isSelected = (r) => String(selectedReaderId) === String(r.user_id) || (selectedReaderId === 'ALL' && String(r.user_id) === String(user?.id));
  const shown = readers.find(isSelected) || readers[0];
  const nameOf = (u) => u.display_name || u.username;
  // "4 von deinen 8" / "3 von 5 eigenen": only when the person owns some, but not all, of the owned volumes
  const ownPart = (r) => {
    const own = Number(r.own_owned) || 0;
    if (own === 0 || own >= (Number(r.total_owned) || 0)) return null;
    const read = Math.min(Number(r.own_read) || 0, own);
    return String(r.user_id) === String(user?.id) ? t('{read} von deinen {own}', { read, own }) : t('{read} von {own} eigenen', { read, own });
  };
  const ownerList = owners ? ownerChoices(owners) : [];
  const ownerFiltered = ownerList.length > 0 && owners.ownerFilter !== 'ALL';
  const chosenOwner = ownerFiltered ? ownerList.find((c) => String(c.user.user_id) === String(owners.ownerFilter))?.user : null;
  const showDate = canToggle && Boolean(setReadDate);
  const hasChoices = readers.length > 1 || ownerList.length > 0 || showDate;
  const narrowed = ownerFiltered || Boolean(readDate);

  const readerLabel = t('{name} liest', { name: nameOf(shown) });
  let ownerLabel = null;
  if (ownerList.length) {
    ownerLabel = chosenOwner ? t('Bände von {name}', { name: nameOf(chosenOwner) }) : t('Alle Bände');
    if (chosenOwner && owners.ownerMissing) ownerLabel = `${ownerLabel} · ${t('fehlt noch')}`;
  }
  const dateLabel = readDate ? t('gelesen am {date}', { date: shortDate(readDate) }) : null;
  const chipText = [readerLabel, ownerLabel, dateLabel].filter(Boolean).join(' · ');
  const chipBody = (
    <>
      <BookOpen className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
      <span className="truncate">{readerLabel}</span>
      {ownerLabel && (
        <>
          <span aria-hidden="true" className="w-px h-4 bg-slate-700 shrink-0" />
          <Users className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
          <span className="truncate">{ownerLabel}</span>
        </>
      )}
      {dateLabel && <span className="truncate text-brand-200 font-medium">· {dateLabel}</span>}
    </>
  );
  const row = (on) => `w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-sm ${on ? 'bg-brand-700/30 text-white font-semibold' : 'text-slate-300 hover:bg-slate-800/70'}`;

  return (
    <div className="mb-4 p-3.5 bg-slate-950/80 rounded-2xl border border-slate-800 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3 shadow-inner">
      <div className="flex flex-wrap items-center gap-2.5">
        <div ref={rootRef} className="relative">
          {hasChoices ? (
            <button
              ref={buttonRef}
              type="button"
              id="btn-reader-chip"
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={t('Leser und Besitz: {label}', { label: chipText })}
              onClick={() => setOpen((v) => !v)}
              className={`flex items-center gap-2 rounded-xl border px-3.5 min-h-[40px] text-sm font-semibold max-w-[min(30rem,calc(100vw-4rem))] ${open ? 'border-sky-400 ring-2 ring-sky-400/35' : ''} ${narrowed ? 'border-brand-500/50 bg-brand-500/15 text-brand-100' : 'border-slate-700 bg-slate-900/90 text-slate-200 hover:border-slate-600'}`}
            >
              {chipBody}
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
            </button>
          ) : (
            <span id="btn-reader-chip" className="flex items-center gap-2 rounded-xl border border-slate-800 px-3.5 min-h-[40px] text-sm font-semibold text-slate-200">
              {chipBody}
            </span>
          )}
          {hasChoices && (
            <div
              id={panelId}
              hidden={!open}
              className="absolute left-0 top-full mt-2 z-40 w-[min(360px,calc(100vw-2rem))] rounded-2xl border border-slate-700/80 bg-slate-900 shadow-2xl p-3 space-y-3"
            >
              <div className="space-y-1">
                <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                  <BookOpen className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" /> {t('Wer liest?')}
                </span>
                <div role="group" aria-label={t('Leser auswählen')} className="space-y-0.5">
                  {readers.map(r => {
                    const on = isSelected(r);
                    return (
                      <button
                        key={r.user_id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setSelectedReaderId(r.user_id)}
                        className={row(on)}
                      >
                        <Radio on={on} />
                        <span>{nameOf(r)}</span>
                        <span className="ml-auto flex items-center gap-1.5">
                          {ownPart(r) && (
                            <span className="text-[11px] text-amber-300/90 whitespace-nowrap" title={t('Gelesen von den eigenen Bänden')}>{ownPart(r)}</span>
                          )}
                          <span className="text-[11px] font-mono px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-300" title={t('Gelesen von allen Bänden im Regal')}>
                            {Math.min(r.read_count, r.total_owned)} / {r.total_owned}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              {ownerList.length > 0 && (
                <div className="border-t border-slate-800 pt-3">
                  <OwnerFilterBar {...owners} />
                </div>
              )}
              {showDate && (
                <div className="border-t border-slate-800 pt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs px-2.5">
                  <label htmlFor={dateId} className="font-semibold text-slate-300 whitespace-nowrap">{t('Gelesen am')}</label>
                  <input
                    id={dateId}
                    type="date"
                    max={localDateString()}
                    value={readDate || ''}
                    onChange={(e) => setReadDate(e.target.value)}
                    aria-describedby={readDate ? undefined : `${dateId}-hint`}
                    className="input-field text-base sm:text-xs py-1 px-2 !w-auto min-w-[9rem] min-h-[2rem] ml-auto"
                    title={t('Datum für die nächsten Häkchen „gelesen“ (leer = jetzt)')}
                  />
                  {!readDate && (
                    <span id={`${dateId}-hint`} className="text-slate-400 whitespace-nowrap w-full text-right">{t('leer = jetzt')}</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {canToggle && nextUnreadVolume && onMarkNextRead && (
          <button
            type="button"
            id="btn-mark-next-read"
            onClick={onMarkNextRead}
            className="inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-xl text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25"
            title={t('Den nächsten ungelesenen Band als gelesen markieren')}
          >
            <Check className="w-3.5 h-3.5" aria-hidden="true" />
            {t('+ Band {volume} gelesen', { volume: nextUnreadVolume.volume_number })}
          </button>
        )}
      </div>

      {/* Reading Progress Percentage Bar for current selected reader */}
      <div className="flex items-center gap-3 w-full lg:w-auto justify-between lg:justify-end">
        <div className="text-xs text-slate-300 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="whitespace-nowrap">{rich('Gelesen: {read} von {owned}', { read: <strong className="font-mono text-emerald-400">{readOfOwned}</strong>, owned: <span className="font-mono">{ownedCount}</span> })}</span>
          <span className="text-slate-500" aria-hidden="true">|</span>
          <span className="whitespace-nowrap">{rich('SuB: {unread}', { unread: <strong className="font-mono text-amber-400">{unread}</strong> })}</span>
        </div>
        <div
          role="progressbar"
          aria-label={t('Lesefortschritt')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={t('{read} von {owned} gelesen', { read: readOfOwned, owned: ownedCount })}
          className="w-24 sm:w-32 h-2.5 bg-slate-900 rounded-full overflow-hidden border border-slate-800"
        >
          <div
            className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-300"
            style={{ width: `${pct}%` }}
            title={t('{pct}% gelesen', { pct })}
          />
        </div>
        <span className="text-xs font-mono font-bold text-emerald-400">
          {pct}%
        </span>
      </div>
    </div>
  );
}
