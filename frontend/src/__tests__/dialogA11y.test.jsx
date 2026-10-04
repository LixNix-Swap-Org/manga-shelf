// useDialogA11y: focus trap, Escape, history entries and the on-screen keyboard.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import useDialogA11y, { HISTORY_STATE_KEY, dialogEntryOnTop } from '../hooks/useDialogA11y';

function Dialog({ open, onClose, autoFocusField = false, dataAutofocus = false, returnFocusRef }) {
  const ref = useDialogA11y(open, { returnFocusRef });
  if (!open) return null;
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Testdialog" tabIndex={-1}>
      <button type="button">Erster</button>
      <input aria-label="Titel" autoFocus={autoFocusField} data-autofocus={dataAutofocus || undefined} />
      <button type="button" onClick={onClose}>Schließen</button>
    </div>
  );
}

function Page({ autoFocusField, dataAutofocus, openerInMenu = false, withFallback = false }) {
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(true);
  const fallbackRef = useRef(null);
  return (
    <>
      <button type="button" ref={fallbackRef}>Menü</button>
      {(!openerInMenu || menuOpen) && (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            if (openerInMenu) setMenuOpen(false);
          }}
        >
          Öffnen
        </button>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        autoFocusField={autoFocusField}
        dataAutofocus={dataAutofocus}
        returnFocusRef={withFallback ? fallbackRef : undefined}
      />
    </>
  );
}

const openFrom = (name) => {
  const opener = screen.getByRole('button', { name });
  opener.focus();
  fireEvent.click(opener);
  return opener;
};

describe('useDialogA11y', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns focus to the opener when the dialog has an autoFocus field', () => {
    render(<Page autoFocusField />);
    const opener = openFrom('Öffnen');
    expect(document.activeElement).toBe(screen.getByLabelText('Titel'));
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('returns focus to the opener without autofocus', () => {
    render(<Page />);
    const opener = openFrom('Öffnen');
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(document.activeElement).toBe(opener);
  });

  it('focuses a [data-autofocus] element on open and still restores the opener', () => {
    render(<Page dataAutofocus />);
    const opener = openFrom('Öffnen');
    expect(document.activeElement).toBe(screen.getByLabelText('Titel'));
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(document.activeElement).toBe(opener);
  });

  it('falls back to returnFocusRef when the opener unmounted with its menu', () => {
    render(<Page openerInMenu withFallback autoFocusField />);
    openFrom('Öffnen');
    expect(screen.queryByRole('button', { name: 'Öffnen' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Menü' }));
  });

  it('does not move focus to an element inside the closed dialog or to body', () => {
    render(<Page openerInMenu autoFocusField />);
    openFrom('Öffnen');
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
  });

  it('skips an opener that is no longer rendered (display:none) and falls back to returnFocusRef', () => {
    render(<Page withFallback autoFocusField />);
    const opener = openFrom('Öffnen');
    const rect = [{ top: 0, left: 0, width: 10, height: 10 }];
    vi.spyOn(document.documentElement, 'getClientRects').mockReturnValue(rect);
    vi.spyOn(opener, 'getClientRects').mockReturnValue([]);
    vi.spyOn(screen.getByRole('button', { name: 'Menü' }), 'getClientRects').mockReturnValue(rect);
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Menü' }));
  });

  it('moves on when focus() on the opener fails silently', () => {
    render(<Page withFallback autoFocusField />);
    const opener = openFrom('Öffnen');
    opener.focus = () => {};
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Menü' }));
  });

  it('without a usable opener or fallback focus goes to the page heading, never to body', () => {
    render(
      <>
        <h1 tabIndex={-1}>Sammlung</h1>
        <Page openerInMenu autoFocusField />
      </>
    );
    openFrom('Öffnen');
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Sammlung' }));
  });

  it('leaves focus alone when something outside already took it on close', () => {
    let close;
    function Harness() {
      const [open, setOpen] = useState(false);
      close = () => {
        document.getElementById('other').focus();
        setOpen(false);
      };
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Öffnen</button>
          <button type="button" id="other">Anderes</button>
          <Dialog open={open} onClose={() => setOpen(false)} />
        </>
      );
    }
    render(<Harness />);
    openFrom('Öffnen');
    act(() => close());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Anderes' }));
  });

  it('keeps Tab inside the dialog', () => {
    render(<Page />);
    openFrom('Öffnen');
    const dialog = screen.getByRole('dialog');
    const items = Array.from(dialog.querySelectorAll('button, input'));
    // jsdom has no layout, so offsetParent is null everywhere; give the controls one so the trap sees them
    items.forEach((el) => Object.defineProperty(el, 'offsetParent', { configurable: true, get: () => dialog }));
    const last = items[items.length - 1];
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

function BackDialogPage() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const ref = useDialogA11y(open, { onClose: close });
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Öffnen</button>
      {open && <div ref={ref} role="dialog" aria-modal="true" aria-label="Statistik" tabIndex={-1}>Inhalt</div>}
    </>
  );
}

describe('useDialogA11y: history across a reload', () => {
  it('a dialog entry left by the previous page load does not swallow the first Back', async () => {
    window.history.replaceState(null, '', '/');
    window.history.pushState({ [HISTORY_STATE_KEY]: ['vorher:1'] }, '', '/');
    render(<BackDialogPage />);
    fireEvent.click(screen.getByText('Öffnen'));
    const tokens = window.history.state[HISTORY_STATE_KEY];
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).not.toBe('vorher:1');
    expect(tokens[1]).toMatch(/^[a-z0-9]+:\d+$/);
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('dialogEntryOnTop tells whether the current entry belongs to a dialog', async () => {
    window.history.replaceState(null, '', '/');
    expect(dialogEntryOnTop()).toBe(false);
    render(<BackDialogPage />);
    fireEvent.click(screen.getByText('Öffnen'));
    expect(dialogEntryOnTop()).toBe(true);
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(dialogEntryOnTop()).toBe(false);
  });
});

describe('useDialogA11y: on-screen keyboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const stubViewport = () => {
    const viewport = new EventTarget();
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('requestAnimationFrame', (cb) => { cb(); return 1; });
    return viewport;
  };

  it('scrolls the focused field back into view when the keyboard changes the visual viewport', () => {
    const viewport = stubViewport();
    render(<Page autoFocusField />);
    openFrom('Öffnen');
    const field = screen.getByLabelText('Titel');
    expect(document.activeElement).toBe(field);
    field.scrollIntoView = vi.fn();
    act(() => { viewport.dispatchEvent(new Event('resize')); });
    expect(field.scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' });
  });

  it('leaves buttons alone and stops listening once the dialog closes', () => {
    const viewport = stubViewport();
    render(<Page />);
    openFrom('Öffnen');
    const first = screen.getByRole('button', { name: 'Erster' });
    first.focus();
    first.scrollIntoView = vi.fn();
    act(() => { viewport.dispatchEvent(new Event('resize')); });
    expect(first.scrollIntoView).not.toHaveBeenCalled();

    const field = screen.getByLabelText('Titel');
    field.scrollIntoView = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    act(() => { viewport.dispatchEvent(new Event('resize')); });
    expect(field.scrollIntoView).not.toHaveBeenCalled();
  });
});
