import { describe, it, expect } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import useDialogA11y from '../hooks/useDialogA11y';

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
