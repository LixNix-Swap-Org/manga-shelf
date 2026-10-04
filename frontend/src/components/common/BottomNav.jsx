import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, Ellipsis, Library, ScanBarcode, ShoppingCart, X } from 'lucide-react';
import BarcodeScannerButton from './BarcodeScannerButton';
import { formatBadgeCount } from '../dashboard/dashboardShell';
import { useKeyboardOpen } from '../../hooks/useKeyboardOpen';

// below Tailwind's `sm` (640 px): phones get the bottom navigation instead of the top quick toggles
export const NARROW_QUERY = '(max-width: 639.98px)';

const matches = (query) => {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && Boolean(window.matchMedia(query)?.matches);
  } catch (_) {
    return false;
  }
};

/** True while the viewport is phone-sized; false without matchMedia (tests, old browsers keep the top controls). */
export function useIsNarrow(query = NARROW_QUERY) {
  const [narrow, setNarrow] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    if (!list) return undefined;
    const update = () => setNarrow(Boolean(list.matches));
    update();
    if (typeof list.addEventListener === 'function') {
      list.addEventListener('change', update);
      return () => list.removeEventListener('change', update);
    }
    list.addListener?.(update);
    return () => list.removeListener?.(update);
  }, [query]);
  return narrow;
}

// a 56 px bar; the bottom inset (home indicator) is added below it
export const BOTTOM_NAV_HEIGHT = '3.5rem';

// next to its button, not inside: the number is not part of the visible label (label in name, WCAG 2.5.3)
function Badge({ count, className }) {
  if (!count) return null;
  return (
    <span aria-hidden="true" className={`pointer-events-none absolute top-1 left-1/2 ml-2 h-4 min-w-4 px-1 rounded-full flex items-center justify-center font-mono font-bold text-[10px] leading-none text-slate-950 ${className}`}>
      {formatBadgeCount(count)}
    </span>
  );
}

const itemClass = (active) => `relative flex-1 min-w-0 min-h-[56px] flex flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition-colors ${
  active ? 'text-white' : 'text-slate-400 hover:text-slate-200'
}`;

// Phone bottom navigation; takes the mobile button ids over from the header while shown, so they stay unique.
// Portalled into <body>: the sticky header's backdrop filter would anchor a fixed element. With `narrow` false it stays
// mounted but hidden and id-less, so an open scanner survives rotating the phone.
export default function BottomNav({
  activeMainView, setView, missingCount = 0, releaseCount = 0, onScan, mobileMenuOpen = false, setMobileMenuOpen, menuToggleRef,
  narrow = true
}) {
  const navRef = useRef(null);
  // like the detail bar: hidden while the on-screen keyboard is up, so it does not cover the focused field
  const keyboardOpen = useKeyboardOpen(navRef);
  if (typeof document === 'undefined') return null;
  const id = (name) => (narrow ? name : undefined);
  const go = (view) => {
    setMobileMenuOpen?.(false);
    setView(view);
  };
  return createPortal(
    <nav
      ref={navRef}
      id="bottom-nav"
      aria-label="Hauptnavigation"
      data-keyboard={keyboardOpen ? 'open' : undefined}
      hidden={!narrow || undefined}
      className={`${keyboardOpen ? 'hidden' : ''} fixed inset-x-0 bottom-0 z-40 sm:hidden border-t border-slate-800/90 bg-slate-950/95 backdrop-blur-md shadow-[0_-8px_24px_rgba(0,0,0,0.35)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]`}
    >
      <div className="flex items-stretch justify-around max-w-lg mx-auto">
        <button
          type="button"
          id={id('btn-bottom-shelf')}
          aria-current={activeMainView === 'shelf' ? 'page' : undefined}
          onClick={() => go('shelf')}
          className={itemClass(activeMainView === 'shelf')}
        >
          <Library className={`w-5 h-5 ${activeMainView === 'shelf' ? 'text-brand-300' : ''}`} aria-hidden="true" />
          Sammlung
        </button>
        <div className="relative flex-1 min-w-0 flex">
          <button
            type="button"
            id={id('btn-mobile-shopping')}
            aria-current={activeMainView === 'shopping' ? 'page' : undefined}
            aria-label={missingCount > 0 ? `Einkauf – Einkaufsliste, ${missingCount} fehlend` : 'Einkauf – Einkaufsliste'}
            onClick={() => go('shopping')}
            className={itemClass(activeMainView === 'shopping')}
          >
            <ShoppingCart className={`w-5 h-5 ${activeMainView === 'shopping' ? 'text-emerald-300' : ''}`} aria-hidden="true" />
            <span aria-hidden="true">Einkauf</span>
          </button>
          <Badge count={missingCount} className="bg-emerald-500" />
        </div>
        <div className="flex-1 min-w-0 flex items-start justify-center">
          <BarcodeScannerButton
            id={id('btn-bottom-scan')}
            buttonText="Scannen"
            scannerTitle="Barcode scannen"
            onDetected={onScan}
            className="-mt-5 w-14 h-14 rounded-full bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white shadow-lg shadow-indigo-950/60 border-4 border-slate-950 flex items-center justify-center active:scale-95 transition disabled:opacity-60"
          >
            <ScanBarcode className="w-6 h-6" aria-hidden="true" />
            <span className="sr-only">Scannen</span>
          </BarcodeScannerButton>
        </div>
        <div className="relative flex-1 min-w-0 flex">
          <button
            type="button"
            id={id('btn-mobile-radar')}
            aria-current={activeMainView === 'radar' ? 'page' : undefined}
            aria-label={releaseCount > 0 ? `Radar – Release-Radar, ${releaseCount} Termine` : 'Radar – Release-Radar'}
            onClick={() => go('radar')}
            className={itemClass(activeMainView === 'radar')}
          >
            <Calendar className={`w-5 h-5 ${activeMainView === 'radar' ? 'text-sky-300' : ''}`} aria-hidden="true" />
            <span aria-hidden="true">Radar</span>
          </button>
          <Badge count={releaseCount} className="bg-sky-500" />
        </div>
        <button
          type="button"
          id={id('btn-mobile-menu-toggle')}
          ref={narrow ? menuToggleRef : undefined}
          aria-expanded={mobileMenuOpen}
          aria-controls="mobile-menu-drawer"
          aria-label={mobileMenuOpen ? 'Mehr – Menü schließen' : 'Mehr – Menü öffnen'}
          onClick={() => setMobileMenuOpen?.(!mobileMenuOpen)}
          className={itemClass(mobileMenuOpen)}
        >
          {mobileMenuOpen ? <X className="w-5 h-5" aria-hidden="true" /> : <Ellipsis className="w-5 h-5" aria-hidden="true" />}
          <span aria-hidden="true">Mehr</span>
        </button>
      </div>
    </nav>,
    document.body
  );
}
