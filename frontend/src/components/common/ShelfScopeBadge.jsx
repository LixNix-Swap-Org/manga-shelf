import { Library, X } from 'lucide-react';
import { t } from '../../i18n/index.js';

/**
 * "Regal: <name>" on a screen whose figures follow the shelf chosen in the collection toolbar; the X shows every shelf
 * again (`onClear`). Renders nothing without a name.
 */
export default function ShelfScopeBadge({ name, onClear, className = '' }) {
  if (!name) return null;
  return (
    <div className={`shelf-scope-badge inline-flex max-w-full items-center gap-1.5 rounded-xl border border-teal-500/40 bg-teal-500/10 px-2.5 py-1 text-xs text-teal-200 ${className}`}>
      <Library className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{t('Regal: {name}', { name })}</span>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          className="hit-44 shrink-0 rounded-md p-0.5 text-teal-300 hover:text-white hover:bg-teal-500/20"
          aria-label={t('Alle Regale anzeigen')}
          title={t('Alle Regale anzeigen')}
        >
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
