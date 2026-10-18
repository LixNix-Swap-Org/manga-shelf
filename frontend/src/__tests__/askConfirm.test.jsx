// ConfirmDialog and askConfirm: answers, one question at a time, the history entry (Back cancels), ids, focus return.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import ConfirmHost, { askConfirm } from '../components/modals/askConfirm';
import ConfirmDialog from '../components/modals/ConfirmDialog';
import useDialogA11y, { HISTORY_STATE_KEY, afterDialogEntriesDropped } from '../hooks/useDialogA11y';

const tokens = () => window.history.state?.[HISTORY_STATE_KEY] || [];
// the dialog history settles after the drop timer and the 120 ms "kept open" check
const settleHistory = () => act(() => new Promise((r) => setTimeout(r, 200)));

beforeEach(() => { window.history.replaceState(null, '', '/'); });
afterEach(async () => {
  cleanup();
  await settleHistory();
  vi.restoreAllMocks();
});

function Outer({ label = 'Regale', onClose, children }) {
  const ref = useDialogA11y(true, { onClose });
  return <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>{children}</div>;
}

describe('askConfirm', () => {
  it('falls back to window.confirm without a mounted host', async () => {
    const spy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await expect(askConfirm('Sicher?')).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith('Sicher?');
  });

  it('resolves true on confirm and false on cancel, without the native dialog', async () => {
    const spy = vi.spyOn(window, 'confirm');
    render(<ConfirmHost />);
    let result;
    act(() => { result = askConfirm('Band löschen?', { title: 'Band löschen' }); });
    expect(await screen.findByRole('dialog', { name: 'Band löschen' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));
    await expect(result).resolves.toBe(true);

    act(() => { result = askConfirm('Nochmal?', { danger: false }); });
    fireEvent.click(await screen.findByRole('button', { name: 'Abbrechen' }));
    await expect(result).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a second question while one is open answers false at once; the first stays on screen', async () => {
    render(<ConfirmHost />);
    let first; let second;
    act(() => { first = askConfirm('Eins'); });
    act(() => { second = askConfirm('Zwei'); });
    await expect(second).resolves.toBe(false);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText('Eins')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));
    await expect(first).resolves.toBe(true);
  });

  it('Back cancels a pending question: the dialog owns a history entry', async () => {
    render(<ConfirmHost />);
    let result;
    act(() => { result = askConfirm('Band 3 löschen?', { title: 'Band löschen' }); });
    await screen.findByRole('dialog', { name: 'Band löschen' });
    expect(tokens()).toHaveLength(1);
    act(() => { window.history.back(); });
    await expect(result).resolves.toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await settleHistory();
    expect(tokens()).toHaveLength(0);
  });

  it('a yes after a navigation away counts as no (the asking page is gone)', async () => {
    render(<ConfirmHost />);
    let result;
    act(() => { result = askConfirm('Band 3 löschen?'); });
    await screen.findByRole('dialog');
    window.history.pushState({ idx: 4 }, '', '/anderswo');
    fireEvent.click(screen.getByRole('button', { name: 'Löschen' }));
    await expect(result).resolves.toBe(false);
  });

  it('a pushed route the browser reports (Navigation API) answers no and closes the question; the same page keeps it', async () => {
    const navigation = new EventTarget();
    vi.stubGlobal('navigation', navigation);
    try {
      render(<ConfirmHost />);
      let result;
      act(() => { result = askConfirm('Band 3 löschen?', { title: 'Band löschen' }); });
      await screen.findByRole('dialog', { name: 'Band löschen' });
      act(() => { navigation.dispatchEvent(new Event('navigatesuccess')); });
      expect(screen.getByRole('dialog', { name: 'Band löschen' })).toBeTruthy();
      window.history.pushState({ idx: 4 }, '', '/');
      act(() => { navigation.dispatchEvent(new Event('navigatesuccess')); });
      expect(screen.getByRole('dialog', { name: 'Band löschen' })).toBeTruthy();
      window.history.pushState({ idx: 5 }, '', '/anderswo');
      act(() => { navigation.dispatchEvent(new Event('navigatesuccess')); });
      await expect(result).resolves.toBe(false);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a question asked while a ConfirmDialog of a page is open answers false', async () => {
    render(<><ConfirmHost /><ConfirmDialog isOpen title="Reihe löschen?" onConfirm={vi.fn()} onCancel={vi.fn()} /></>);
    let result;
    act(() => { result = askConfirm('Band 3 löschen?'); });
    await expect(result).resolves.toBe(false);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Reihe löschen?' })).toBeTruthy();
  });
});

describe('ConfirmDialog', () => {
  const two = (secondOpen, onCancelSecond = vi.fn()) => (
    <>
      <ConfirmDialog isOpen title="Für alle löschen" onConfirm={vi.fn()} onCancel={vi.fn()} />
      <ConfirmDialog isOpen={secondOpen} title="Verwerfen?" onConfirm={vi.fn()} onCancel={onCancelSecond} />
    </>
  );

  it('one at a time: a second one opened meanwhile is cancelled at once and never shown', () => {
    const onCancelSecond = vi.fn();
    const { rerender } = render(two(false, onCancelSecond));
    rerender(two(true, onCancelSecond));
    expect(onCancelSecond).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('dialog').map((d) => d.getAttribute('aria-labelledby') && d.textContent.includes('Für alle löschen'))).toEqual([true]);
  });

  it('ids come from useId, the buttons carry data-confirm-action, the root data-confirm', () => {
    function Swap() {
      const [which, setWhich] = useState('a');
      return (
        <>
          <ConfirmDialog isOpen={which === 'a'} title="Erste" onConfirm={() => setWhich('b')} onCancel={vi.fn()} />
          <ConfirmDialog isOpen={which === 'b'} title="Zweite" onConfirm={vi.fn()} onCancel={vi.fn()} />
        </>
      );
    }
    render(<Swap />);
    const first = screen.getByRole('button', { name: 'Löschen' });
    expect(first.id).not.toBe('confirm-dialog-confirm');
    expect(document.querySelector('[role="dialog"][data-confirm] [data-confirm-action="confirm"]')).toBe(first);
    expect(document.querySelector('[data-confirm-action="cancel"]').textContent).toBe('Abbrechen');
    fireEvent.click(first);
    const second = screen.getByRole('button', { name: 'Löschen' });
    expect(screen.getByRole('dialog', { name: 'Zweite' })).toBeTruthy();
    expect(second.id).not.toBe(first.id);
    expect(document.getElementById('confirm-dialog-confirm')).toBeNull();
  });

  it('only a dangerous question gets the red icon tile and button', () => {
    const { rerender } = render(<ConfirmDialog isOpen isDanger={false} title="Ausfüllen?" confirmLabel="Ausfüllen" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const tile = () => screen.getByRole('dialog').querySelector('svg').parentElement;
    expect(tile().className).not.toMatch(/rose/);
    expect(screen.getByRole('button', { name: 'Ausfüllen' }).className).toMatch(/btn-primary/);
    rerender(<ConfirmDialog isOpen title="Löschen?" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(tile().className).toMatch(/bg-rose-500\/20/);
    expect(screen.getByRole('button', { name: 'Löschen' }).className).toMatch(/btn-danger/);
  });

  it('Escape cancels only the confirmation, the dialog below stays open', () => {
    const onClose = vi.fn();
    function Page() {
      const [ask, setAsk] = useState(true);
      return <Outer onClose={onClose}><ConfirmDialog isOpen={ask} title="Mitglied entfernen?" onConfirm={vi.fn()} onCancel={() => setAsk(false)} /></Outer>;
    }
    render(<Page />);
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Mitglied entfernen?' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Mitglied entfernen?' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Regale' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a confirmation that closes the dialog below removes both history entries', async () => {
    const go = vi.spyOn(window.history, 'go');
    function Page() {
      const [outer, setOuter] = useState(true);
      const [ask, setAsk] = useState(false);
      if (!outer) return <p>zu</p>;
      return (
        <Outer onClose={() => setOuter(false)}>
          <button type="button" onClick={() => setAsk(true)}>Schließen</button>
          <ConfirmDialog isOpen={ask} title="Verwerfen?" confirmLabel="Verwerfen" onConfirm={() => { setAsk(false); setOuter(false); }} onCancel={() => setAsk(false)} />
        </Outer>
      );
    }
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(tokens()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
    await settleHistory();
    expect(go).toHaveBeenCalledWith(-2);
    expect(tokens()).toHaveLength(0);
    expect(screen.getByText('zu')).toBeTruthy();
  });

  it('afterDialogEntriesDropped waits until the confirmation has left history, with the entry of the dialog below on top', async () => {
    const seen = [];
    function Page() {
      const [ask, setAsk] = useState(false);
      return (
        <Outer onClose={vi.fn()}>
          <button type="button" onClick={() => setAsk(true)}>Zur Reihe</button>
          <ConfirmDialog isOpen={ask} title="Verwerfen?" confirmLabel="Verwerfen"
            onConfirm={() => { setAsk(false); afterDialogEntriesDropped(() => seen.push(tokens())); }} onCancel={() => setAsk(false)} />
        </Outer>
      );
    }
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: 'Zur Reihe' }));
    const [outerToken] = tokens();
    expect(tokens()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
    expect(seen).toEqual([]);
    await waitFor(() => expect(seen).toEqual([[outerToken]]));

    afterDialogEntriesDropped(() => seen.push('ohne Dialog'));
    expect(seen).toHaveLength(1);
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]).toBe('ohne Dialog');
  });

  it('Back on a dialog that asks about unsaved input first: the next Back cancels the question, not the dialog', async () => {
    function Page() {
      const [ask, setAsk] = useState(false);
      return (
        <Outer onClose={() => setAsk(true)}>
          <ConfirmDialog isOpen={ask} title="Verwerfen?" confirmLabel="Verwerfen" onConfirm={vi.fn()} onCancel={() => setAsk(false)} />
        </Outer>
      );
    }
    render(<Page />);
    expect(tokens()).toHaveLength(1);
    const outerToken = tokens()[0];
    act(() => { window.history.back(); });
    await screen.findByRole('dialog', { name: 'Verwerfen?' });
    await settleHistory();
    expect(tokens()).toHaveLength(2);
    expect(tokens()[0]).toBe(outerToken);
    act(() => { window.history.back(); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Verwerfen?' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Regale' })).toBeTruthy();
    expect(tokens()).toEqual([outerToken]);
  });

  it('a busy confirmation stays open on Back and gets its entry back', async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog isOpen busy title="Wird gelöscht" onConfirm={vi.fn()} onCancel={onCancel} />);
    act(() => { window.history.back(); });
    await waitFor(() => expect(tokens()).toHaveLength(0));
    await settleHistory();
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Wird gelöscht' })).toBeTruthy();
    expect(tokens()).toHaveLength(1);
  });

  it('focus goes back to the dialog the opener was in when the opener is gone, not to the page heading', () => {
    function Members() {
      const [rows, setRows] = useState(['anna', 'ben']);
      const [asking, setAsking] = useState(null);
      return (
        <>
          <h1 tabIndex={-1}>Sammlung</h1>
          <Outer onClose={vi.fn()}>
            <ul>{rows.map((r) => <li key={r}><button type="button" onClick={() => setAsking(r)}>{`${r} entfernen`}</button></li>)}</ul>
            <ConfirmDialog isOpen={asking !== null} title="Mitglied entfernen?" confirmLabel="Entfernen"
              onConfirm={() => { setRows((list) => list.filter((r) => r !== asking)); setAsking(null); }} onCancel={() => setAsking(null)} />
          </Outer>
        </>
      );
    }
    render(<Members />);
    const trigger = screen.getByRole('button', { name: 'ben entfernen' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement.textContent).toBe('Abbrechen');
    fireEvent.click(screen.getByRole('button', { name: 'Entfernen' }));
    expect(screen.queryByRole('button', { name: 'ben entfernen' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Regale' }));
  });

  it('with the opener still there, focus goes back to it', () => {
    function Single() {
      const [ask, setAsk] = useState(false);
      return (
        <Outer onClose={vi.fn()}>
          <button type="button" onClick={() => setAsk(true)}>Regal löschen</button>
          <ConfirmDialog isOpen={ask} title="Regal löschen?" onConfirm={vi.fn()} onCancel={() => setAsk(false)} />
        </Outer>
      );
    }
    render(<Single />);
    const trigger = screen.getByRole('button', { name: 'Regal löschen' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(document.activeElement).toBe(trigger);
  });
});
