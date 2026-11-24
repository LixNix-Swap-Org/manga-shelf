import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Handshake, Undo2, Users } from 'lucide-react';
import { t } from '../../i18n/index.js';
import { formatNumber } from '../../utils/format';
import useDialogA11y from '../../hooks/useDialogA11y';
import { useIsNarrow } from '../common/BottomNav';

const OWNER_COLORS = ['#38bdf8', '#f472b6', '#a3e635', '#fb923c', '#c084fc', '#2dd4bf', '#facc15', '#f87171'];
const READ_ONLY_ROLES = ['visitor', 'guest'];

/** Fixed colour per user, so badges and filters show the same person alike. */
export function ownerColor(userId) {
  const n = Math.abs(parseInt(userId, 10) || 0);
  return OWNER_COLORS[n % OWNER_COLORS.length];
}

/** Two letters for a reader avatar: the initials of two words, else the first two letters ("admin" -> "Ad"). */
export function readerInitials(name) {
  const words = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length > 1) return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  const word = words[0];
  return word.charAt(0).toUpperCase() + word.charAt(1).toLowerCase();
}

/** How many copies each owner has of the volume: Map user id -> count (at least 1 per owner). */
export function copiesPerOwner(vol) {
  const counts = new Map();
  for (const c of vol?.copies || []) {
    const id = String(c.owner_user_id);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

/**
 * What "Verleihen" in the owner pill offers `userId` for a volume: their lent copies (to take back) and the first copy
 * of theirs that is not lent (to lend). Null when they own no copy.
 */
export function lendChoices(vol, userId) {
  if (userId === null || userId === undefined) return null;
  const mine = (vol?.copies || []).filter((c) => c.owner_user_id !== null && String(c.owner_user_id) === String(userId));
  if (mine.length === 0) return null;
  return { lent: mine.filter((c) => c.lent_to), free: mine.find((c) => !c.lent_to) || null };
}

// the fixed bars at the bottom of a phone screen (app navigation, the series bar of the detail page)
const BOTTOM_BARS = ['bottom-nav', 'detail-bottom-bar'];
const MENU_WIDTH = 208;
const GAP = 6;
const EDGE = 8;
const SWIPE_CLOSE_PX = 60;

/** Height of the fixed bars covering the bottom of the viewport (0 on tablets and PCs). */
export function bottomBarInset(doc = document, vh = window.innerHeight) {
  let inset = 0;
  for (const id of BOTTOM_BARS) {
    const rect = doc.getElementById(id)?.getBoundingClientRect();
    if (rect && rect.height > 0 && rect.bottom >= vh - 1) inset = Math.max(inset, vh - rect.top);
  }
  return inset;
}

/**
 * Where the menu of an anchor goes, from its real height: below when it fits, else above when that side has more room,
 * and limited to the room of the chosen side (the rest scrolls inside the menu).
 */
export function placeMenu(rect, height, { vw, vh, inset = 0, width = MENU_WIDTH }) {
  const left = Math.max(EDGE, Math.min(rect.left, vw - width - EDGE));
  const below = vh - inset - rect.bottom - GAP - EDGE;
  const above = rect.top - GAP - EDGE;
  const openUp = height > below && above > below;
  const room = Math.max(120, openUp ? above : below);
  return {
    left,
    top: openUp ? undefined : rect.bottom + GAP,
    bottom: openUp ? vh - rect.top + GAP : undefined,
    maxHeight: height > room ? room : undefined
  };
}

const samePos = (a, b) => a.left === b.left && a.top === b.top && a.bottom === b.bottom && a.maxHeight === b.maxHeight;

/**
 * The open menu of the owner pill. Phones get a sheet from the bottom above the bars ("Band N", "Fertig", 44 px rows,
 * own scroll area; Back, a swipe down and a tap beside it close it, scrolling the page does not). Tablets and PCs get
 * the popover at the pill, placed by its real height and following the page while it scrolls. Focus goes to the first
 * entry; Escape brings it back to the pill.
 */
function OwnerMenu({ vol, anchorRef, onClose, label, members, owners, canToggle, onToggleOwner, lending, lendTargets, onLend }) {
  const sheet = useIsNarrow();
  const [otherName, setOtherName] = useState(null);
  const [pos, setPos] = useState({ left: EDGE, top: EDGE });
  const [inset, setInset] = useState(0);
  const touchRef = useRef(null);
  const popoverRef = useDialogA11y(true, { history: sheet, onClose });

  const place = useCallback(() => {
    const node = popoverRef.current;
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!node || !rect) return;
    const vh = window.innerHeight;
    const barInset = bottomBarInset(document, vh);
    if (sheet) {
      setInset((v) => (v === barInset ? v : barInset));
      return;
    }
    const next = placeMenu(rect, node.scrollHeight, { vw: window.innerWidth, vh, inset: barInset });
    setPos((cur) => (samePos(cur, next) ? cur : next));
  }, [sheet, anchorRef, popoverRef]);

  useLayoutEffect(() => { place(); }, [place, otherName, vol]);

  useEffect(() => {
    let frame = 0;
    const replace = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    const onPointerDown = (e) => {
      if (anchorRef.current?.contains(e.target) || popoverRef.current?.contains(e.target)) return;
      if (e.target?.closest?.('[data-owner-sheet-backdrop]')) return; // the backdrop closes on its click
      onClose();
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        anchorRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', replace, true);
    window.addEventListener('resize', replace);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', replace, true);
      window.removeEventListener('resize', replace);
    };
  }, [place, onClose, anchorRef, popoverRef]);

  const rowSize = sheet ? 'min-h-[44px] py-2 text-sm' : 'py-1.5';
  const listLimit = (cls) => (sheet ? '' : cls);
  let firstRow = true;
  const autofocus = () => {
    if (!firstRow) return undefined;
    firstRow = false;
    return '';
  };

  const body = (
    <>
      {canToggle && (<>
      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">{t('Besitzer')}</p>
      <div className={`space-y-0.5 ${listLimit('max-h-52 overflow-y-auto custom-scrollbar')}`}>
        {members.map((m) => {
          const uid = m.user_id ?? m.id;
          const name = m.display_name || m.username || m.name;
          const isOwner = owners.some((o) => String(o.user_id) === String(uid));
          return (
            <button
              key={uid}
              type="button"
              data-autofocus={autofocus()}
              aria-pressed={isOwner}
              onClick={(e) => {
                e.stopPropagation();
                onToggleOwner(vol, uid);
              }}
              className={`w-full flex items-center justify-between gap-2 px-2 ${rowSize} rounded-lg text-left transition-colors ${
                isOwner ? 'bg-amber-500/15 text-amber-200 hover:bg-amber-500/25' : 'text-slate-200 hover:bg-slate-800'
              }`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <span
                  aria-hidden="true"
                  className="w-5 h-5 rounded-full text-[9px] font-bold flex items-center justify-center shrink-0 text-slate-950"
                  style={{ background: ownerColor(uid) }}
                >
                  {readerInitials(name)}
                </span>
                <span className="truncate font-medium">{name}</span>
              </span>
              {isOwner && <Check className="w-3.5 h-3.5 text-amber-300 shrink-0" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      </>)}
      {lending && (
        <div data-lend-menu className={canToggle ? 'mt-1 pt-1 border-t border-slate-800' : ''}>
          {lending.lent.map((copy) => (
            <button
              key={`back-${copy.id}`}
              type="button"
              data-autofocus={autofocus()}
              onClick={(e) => { e.stopPropagation(); onLend(copy, null); }}
              className={`w-full flex items-center gap-2 px-2 ${rowSize} rounded-lg text-left text-emerald-300 hover:bg-slate-800 transition-colors`}
            >
              <Undo2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{t('Zurückbekommen von {name}', { name: copy.lent_to })}</span>
            </button>
          ))}
          {lending.free && (
            <>
              <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">{t('Verleihen an')}</p>
              <div className={`space-y-0.5 ${listLimit('max-h-40 overflow-y-auto custom-scrollbar')}`}>
                {lendTargets.map((p) => {
                  const uid = p.user_id ?? p.id;
                  const name = p.display_name || p.username || p.name;
                  return (
                    <button
                      key={`lend-${uid}`}
                      type="button"
                      data-autofocus={autofocus()}
                      onClick={(e) => { e.stopPropagation(); onLend(lending.free, { user_id: Number(uid) }); }}
                      className={`w-full flex items-center gap-2 px-2 ${rowSize} rounded-lg text-left text-slate-200 hover:bg-slate-800 transition-colors`}
                    >
                      <Handshake className="w-3.5 h-3.5 text-violet-300 shrink-0" aria-hidden="true" />
                      <span className="truncate">{name}</span>
                    </button>
                  );
                })}
              </div>
              {otherName === null ? (
                <button
                  type="button"
                  data-autofocus={autofocus()}
                  onClick={(e) => { e.stopPropagation(); setOtherName(''); }}
                  className={`w-full px-2 ${rowSize} rounded-lg text-left text-slate-300 hover:bg-slate-800 transition-colors`}
                >
                  {t('Andere Person …')}
                </button>
              ) : (
                <form
                  className="flex items-center gap-1.5 px-1 py-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const name = otherName.trim();
                    if (name) onLend(lending.free, { name });
                  }}
                >
                  <input
                    type="text"
                    autoFocus
                    maxLength={64}
                    aria-label={t('Name')}
                    placeholder={t('Name')}
                    value={otherName}
                    onChange={(e) => setOtherName(e.target.value)}
                    className={`input-field bg-slate-950 py-1 text-base sm:text-xs min-w-0 flex-1 ${sheet ? 'min-h-[44px]' : ''}`}
                  />
                  <button type="submit" disabled={!otherName.trim()} className={`px-2 py-1 rounded-lg bg-violet-500/20 border border-violet-500/40 text-violet-200 font-semibold disabled:opacity-50 ${sheet ? 'min-h-[44px] px-3' : ''}`}>
                    {t('Verleihen')}
                  </button>
                </form>
              )}
            </>
          )}
        </div>
      )}
    </>
  );

  if (sheet) {
    const onTouchStart = (e) => { touchRef.current = e.touches?.[0]?.clientY ?? null; };
    const onTouchEnd = (e) => {
      const start = touchRef.current;
      touchRef.current = null;
      const end = e.changedTouches?.[0]?.clientY;
      if (start !== null && end !== undefined && end - start > SWIPE_CLOSE_PX) onClose();
    };
    return createPortal(
      <>
        <div
          aria-hidden="true"
          data-owner-sheet-backdrop
          className="fixed inset-0 z-[90] bg-slate-950/50"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
        />
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={label}
          data-owner-popover
          data-owner-sheet
          onClick={(e) => e.stopPropagation()}
          style={{ bottom: inset, maxHeight: `calc(100dvh - ${inset}px - 3rem)` }}
          className="fixed inset-x-0 z-[91] flex flex-col rounded-t-2xl border border-b-0 border-slate-700 bg-slate-900 shadow-2xl text-slate-100"
        >
          <div className="shrink-0 px-3 pt-2 pb-1" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
            <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-700" />
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-white truncate">{t('Band {number}', { number: vol?.volume_number ?? '' })}</p>
              <button type="button" onClick={(e) => { e.stopPropagation(); onClose(); }} className="btn-secondary min-h-[44px] px-4 text-sm font-semibold">
                {t('Fertig')}
              </button>
            </div>
          </div>
          <div className="min-h-0 overflow-y-auto overscroll-contain custom-scrollbar px-3 pb-3">
            {body}
          </div>
        </div>
      </>,
      document.body
    );
  }

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={label}
      data-owner-popover
      onClick={(e) => e.stopPropagation()}
      style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight, width: MENU_WIDTH }}
      className={`z-[90] rounded-xl border border-slate-700 bg-slate-900/95 p-1.5 shadow-2xl backdrop-blur-md text-xs text-slate-100 ${pos.maxHeight ? 'overflow-y-auto overscroll-contain custom-scrollbar' : ''}`}
    >
      {body}
    </div>,
    document.body
  );
}

/**
 * Owners of a volume: the people icon and one coloured circle with initials per owner, in an amber pill like the
 * "Besitz" side of the reader/owner chip. A small number on a circle says that person has more than one copy.
 * Nothing with only one person on the shelf. With `onToggleOwner` (admins) the pill opens the owners list; with `lend`
 * ({ userId, people, onLend }) it also offers to lend the user's own copy to a shelf member or another person, or to
 * take a lent copy back (PUT /api/volumes/:id/copies/:copyId { lent }); the full form stays in "Band bearbeiten".
 */
export default function OwnerBadges({ vol, multiUser, people = null, onToggleOwner = null, lend = null }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  const owners = vol?.owners || [];
  const members = Array.isArray(people)
    ? people.filter((p) => !READ_ONLY_ROLES.includes(p.app_role ?? p.role))
    : [];
  const canToggle = Boolean(onToggleOwner) && members.length > 1;
  const lending = lend?.onLend ? lendChoices(vol, lend.userId) : null;
  const lendTargets = lending?.free
    ? (lend.people || []).filter((p) => String(p.user_id ?? p.id) !== String(lend.userId))
    : [];
  const interactive = multiUser && owners.length > 0 && (canToggle || Boolean(lending));
  const doLend = (copy, lent) => {
    setOpen(false);
    lend.onLend(vol, copy, lent);
  };

  if (!multiUser || owners.length === 0) return null;
  const copies = copiesPerOwner(vol);
  const copiesOf = (o) => Math.max(1, copies.get(String(o.user_id)) || 0);
  const names = owners.map(o => (copiesOf(o) > 1 ? `${o.username} ×${formatNumber(copiesOf(o))}` : o.username)).join(', ');
  const pill = (
    <span
      role="img"
      aria-label={t('Besitzer: {names}', { names })}
      title={t('Besitzer: {names}', { names })}
      data-owner-badges
      className={`inline-flex items-center gap-1 shrink-0 rounded-full pl-1 pr-1.5 py-0.5 bg-amber-500/15 border border-amber-500/40 text-amber-300${interactive ? ' hover:bg-amber-500/25 transition-colors' : ''}`}
    >
      <Users className="w-2.5 h-2.5" aria-hidden="true" />
      {owners.map(o => {
        const n = copiesOf(o);
        return (
          <span
            key={o.user_id}
            aria-hidden="true"
            className={`relative px-1 h-4 min-w-4 ${n > 1 ? 'mr-1.5' : ''} rounded-full text-[9px] font-bold flex items-center justify-center text-slate-950`}
            style={{ background: ownerColor(o.user_id) }}
          >
            {readerInitials(o.username)}
            {n > 1 && (
              <span data-copy-count className="absolute -top-1.5 -right-2 min-w-3 h-3 px-0.5 rounded-full bg-slate-900 border border-amber-400 text-amber-300 text-[8px] leading-none flex items-center justify-center">
                {formatNumber(n)}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
  if (!interactive) return pill;
  const label = canToggle ? t('Besitzer') : t('Besitzer und Verleihen');
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="hit-44 inline-flex rounded-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
      >
        {pill}
      </button>
      {open && typeof document !== 'undefined' && (
        <OwnerMenu
          vol={vol}
          anchorRef={anchorRef}
          onClose={close}
          label={label}
          members={members}
          owners={owners}
          canToggle={canToggle}
          onToggleOwner={onToggleOwner}
          lending={lending}
          lendTargets={lendTargets}
          onLend={doLend}
        />
      )}
    </>
  );
}

/** "Verliehen" when a copy of the volume is lent out; the title names who has it. */
export function LentBadge({ vol, className = '' }) {
  const lent = (vol?.copies || []).filter(c => c.lent_to);
  if (lent.length === 0) return null;
  const names = lent.map(c => c.lent_to).join(', ');
  return (
    <span
      className={`inline-flex items-center gap-1 shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-violet-500/20 text-violet-200 border border-violet-500/40 ${className}`}
      title={t('Ausgeliehen an: {names}', { names })}
      data-lent
    >
      <Handshake className="w-2.5 h-2.5" aria-hidden="true" />
      <span>{t('Verliehen')}</span>
      <span className="sr-only">{t('Ausgeliehen an: {names}', { names })}</span>
    </span>
  );
}
