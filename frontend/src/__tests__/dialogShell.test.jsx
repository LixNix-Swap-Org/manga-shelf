// ToolDialog on short screens and the backup import dialog.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ToolDialog from '../components/modals/ToolDialog';
import BackupExportModal from '../components/modals/BackupExportModal';

describe('ToolDialog on short screens', () => {
  it('scrolls as a whole there: no height cap, body and footer in the flow, compact header', () => {
    render(<ToolDialog title="Papierkorb" subtitle="Gelöschte Reihen" Icon={() => null} onClose={vi.fn()} footer={<span>Fuß</span>}>Inhalt</ToolDialog>);
    const dialog = screen.getByRole('dialog', { name: 'Papierkorb' });
    expect(dialog.className).toMatch(/(^|\s)dialog-overlay(\s|$)/);
    expect(dialog.className).toContain('z-[60]');
    const box = dialog.firstElementChild;
    expect(box.className).toMatch(/(^|\s)dialog-box(\s|$)/);
    expect(box.className).toContain('short:max-h-none');
    expect(box.className).toContain('short:p-4');
    expect(screen.getByText('Gelöschte Reihen').className).toContain('short:hidden');
    expect(screen.getByText('Inhalt').className).toContain('short:overflow-visible');
    expect(screen.getAllByRole('button', { name: 'Schließen' })[0].className).toContain('hit-44');
  });
});

describe('BackupExportModal import', () => {
  it('one named button opens the picker; the file input is hidden from assistive technology', () => {
    render(<BackupExportModal onClose={vi.fn()} />);
    const input = document.querySelector('input[type="file"]');
    expect(input.getAttribute('accept')).toBe('.zip,application/zip');
    expect(input.getAttribute('aria-hidden')).toBe('true');
    expect(input.tabIndex).toBe(-1);
    expect(input.className).toBe('hidden');
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'ZIP-Datei auswählen' }));
    expect(click).toHaveBeenCalled();
  });
});
