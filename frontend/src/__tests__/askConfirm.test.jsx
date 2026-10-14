import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import ConfirmHost, { askConfirm } from '../components/modals/askConfirm';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

  it('a second question cancels the first', async () => {
    render(<ConfirmHost />);
    let first; let second;
    act(() => { first = askConfirm('Eins'); });
    act(() => { second = askConfirm('Zwei'); });
    await expect(first).resolves.toBe(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Löschen' }));
    await expect(second).resolves.toBe(true);
  });
});
