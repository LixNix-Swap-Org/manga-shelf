import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { WifiOff } from 'lucide-react';
import { formatAge } from '../../utils/offlineStore';
import { t } from '../../i18n/index.js';

const SAFE_AREA_BOTTOM = {
  paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))',
  paddingLeft: 'calc(1rem + env(safe-area-inset-left, 0px))',
  paddingRight: 'calc(1rem + env(safe-area-inset-right, 0px))'
};

// phones: the bottom navigation of the dashboard and the context bar of a series page (3.5rem + inset) sit below it;
// their raised scan button reaches 1.25rem into the banner, so the text keeps above it
const ABOVE_BOTTOM_NAV = 'max-sm:bottom-[calc(3.5rem+env(safe-area-inset-bottom))] max-sm:!pb-6';

/** Read by the Toaster below sm: toasts stay above the raised banner (it ends at 6.5rem + inset). */
export const TOAST_OFFSET_VAR = '--toast-offset';
export const RAISED_TOAST_OFFSET = '7rem';

const withPeriod = (text) => (text.endsWith('.') ? text : `${text}.`);

export default function OfflineBanner({ lastSync }) {
  const { pathname } = useLocation();
  const aboveNav = pathname === '/' || pathname.startsWith('/manga/');
  useEffect(() => {
    if (!aboveNav) return undefined;
    const root = document.documentElement;
    root.style.setProperty(TOAST_OFFSET_VAR, RAISED_TOAST_OFFSET);
    return () => root.style.removeProperty(TOAST_OFFSET_VAR);
  }, [aboveNav]);
  return (
    <div role="status" style={SAFE_AREA_BOTTOM} className={`fixed bottom-0 inset-x-0 z-40 flex items-center justify-center gap-2 pt-2 bg-amber-500/95 text-slate-950 text-xs font-semibold shadow-lg ${aboveNav ? ABOVE_BOTTOM_NAV : ''}`}>
      <WifiOff className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>
        {t('Offline – Stand der Sammlung: {age}', { age: withPeriod(lastSync ? formatAge(lastSync) : t('unbekannt')) })}
        <span className="hidden sm:inline"> {t('Nur Ansicht, Änderungen sind erst mit Verbindung möglich.')}</span>
      </span>
    </div>
  );
}
