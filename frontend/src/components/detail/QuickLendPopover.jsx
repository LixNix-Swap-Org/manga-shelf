import { useState, useEffect, useRef } from 'react';
import { Clock, Handshake, User, Users, X } from 'lucide-react';
import { t } from '../../i18n/index.js';
import { getLastBorrower, rememberLastBorrower } from '../../utils/lendingHelpers';

/**
 * 1-Click Quick Lend Popover:
 * Displays remembered last borrower chip, household member pills (excluding copy owner),
 * and manual borrower input with instant single-click dispatch.
 */
export default function QuickLendPopover({
  isOpen,
  onClose,
  onLend,
  volumeTitle,
  copy,
  user,
  currentUserId,
  users = [],
  accounts = [],
  anchorRef
}) {
  const [customName, setCustomName] = useState('');
  const popoverRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    const outside = (e) => {
      if (!popoverRef.current) return false;
      if (popoverRef.current.contains(e.target)) return false;
      if (anchorRef?.current && anchorRef.current.contains(e.target)) return false;
      return true;
    };
    const onPointer = (e) => {
      if (outside(e)) onClose?.();
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen, onClose, anchorRef]);

  if (!isOpen) return null;

  const effectiveUserId = currentUserId ?? user?.id;
  const memberList = users.length > 0 ? users : accounts;
  const excludedOwnerId = copy?.owner_user_id ?? effectiveUserId;
  const eligibleMembers = memberList.filter(
    (m) => String(m.id ?? m.user_id) !== String(excludedOwnerId)
  );
  const lastBorrower = getLastBorrower(effectiveUserId);

  const handleLendLastBorrower = () => {
    if (!lastBorrower) return;
    const payload = lastBorrower.user_id
      ? { user_id: lastBorrower.user_id }
      : { name: lastBorrower.name || String(lastBorrower) };
    rememberLastBorrower(effectiveUserId, lastBorrower);
    onLend?.(payload);
    onClose?.();
  };

  const handleLendMember = (member) => {
    const mId = member.id ?? member.user_id;
    const mName = member.username ?? member.name;
    const payload = { user_id: mId };
    rememberLastBorrower(effectiveUserId, { user_id: mId, name: mName });
    onLend?.(payload);
    onClose?.();
  };

  const handleLendCustom = (e) => {
    e.preventDefault();
    const trimmed = customName.trim();
    if (!trimmed) return;
    const payload = { name: trimmed };
    rememberLastBorrower(effectiveUserId, payload);
    onLend?.(payload);
    onClose?.();
  };

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="false"
      aria-label={t('Exemplar verleihen')}
      onClick={(e) => e.stopPropagation()}
      className="absolute right-0 top-full mt-2 z-40 w-[min(300px,calc(100vw-2rem))] glass-panel bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl p-3 space-y-3 text-left"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-2">
        <div className="min-w-0">
          <p className="text-xs font-bold text-white flex items-center gap-1.5 truncate">
            <Handshake className="w-3.5 h-3.5 text-violet-400 shrink-0" aria-hidden="true" />
            <span className="truncate">{t('Verleihen')}</span>
          </p>
          {volumeTitle && (
            <p className="text-[10px] text-slate-400 truncate">{volumeTitle}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 -mr-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          aria-label={t('Schließen')}
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* 1-Click Last Borrower Chip */}
      {lastBorrower && (
        <div>
          <p className="text-[11px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
            <Clock className="w-3 h-3 text-violet-400" aria-hidden="true" />
            <span>{t('Zuletzt verliehen an')}</span>
          </p>
          <button
            type="button"
            onClick={handleLendLastBorrower}
            data-last-borrower-btn
            className="w-full hit-44 flex items-center justify-between px-3 py-1.5 rounded-xl bg-violet-500/20 hover:bg-violet-500/30 text-violet-200 border border-violet-500/40 text-xs font-semibold transition-all text-left cursor-pointer"
            aria-label={t('Zuletzt: {name}', { name: lastBorrower.name || String(lastBorrower) })}
          >
            <span className="flex items-center gap-1.5 truncate">
              <Clock className="w-3.5 h-3.5 text-violet-400 shrink-0" aria-hidden="true" />
              <span className="truncate">{lastBorrower.name || String(lastBorrower)}</span>
            </span>
          </button>
        </div>
      )}

      {/* 1-Click Household Members */}
      {eligibleMembers.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-slate-400 mb-1.5 flex items-center gap-1">
            <Users className="w-3 h-3 text-teal-400" aria-hidden="true" />
            <span>{t('Haushaltsmitglieder')}</span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {eligibleMembers.map((member) => {
              const mId = member.id ?? member.user_id;
              const mName = member.username ?? member.name;
              return (
                <button
                  key={mId}
                  type="button"
                  onClick={() => handleLendMember(member)}
                  className="hit-44 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-teal-600/30 hover:border-teal-500/50 text-slate-200 hover:text-white border border-slate-700 text-xs font-medium transition-all cursor-pointer"
                  aria-label={mName}
                >
                  <User className="w-3 h-3 text-teal-400" aria-hidden="true" />
                  <span>{mName}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Other Person Manual Input */}
      <form onSubmit={handleLendCustom} className="space-y-1.5 pt-1 border-t border-slate-800">
        <label htmlFor="custom-borrower-input" className="block text-[11px] font-semibold text-slate-400">
          {t('Andere Person')}
        </label>
        <div className="flex gap-1.5">
          <input
            id="custom-borrower-input"
            type="text"
            maxLength={64}
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            placeholder={t('Name (z. B. Freund, Kollege)')}
            className="flex-1 input-field py-1.5 text-xs bg-slate-950/80 min-w-0"
          />
          <button
            type="submit"
            disabled={!customName.trim()}
            className="hit-44 px-3 py-1.5 rounded-lg bg-violet-700 hover:bg-violet-800 disabled:opacity-50 disabled:pointer-events-none text-white text-xs font-semibold shrink-0 transition-colors cursor-pointer"
          >
            {t('Verleihen')}
          </button>
        </div>
      </form>
    </div>
  );
}
