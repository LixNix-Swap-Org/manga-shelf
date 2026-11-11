import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import LastChanged from '../components/detail/volumeEdit/LastChanged';

describe('LastChanged', () => {
  it('names who changed the volume and when', () => {
    render(<LastChanged volume={{ updated_by_name: 'Jörg', updated_at: '2026-11-11 18:43:00' }} />);
    const line = screen.getByTestId('volume-last-changed');
    expect(line.textContent).toMatch(/^Zuletzt geändert von Jörg am /);
    expect(line.textContent).toMatch(/2026/);
  });

  it('keeps the date when the account is gone', () => {
    render(<LastChanged volume={{ updated_by_name: null, updated_at: '2026-11-11 18:43:00' }} />);
    expect(screen.getByTestId('volume-last-changed').textContent).toMatch(/^Zuletzt geändert am /);
  });

  it('shows nothing for a volume no one changed since the update', () => {
    const { container } = render(<LastChanged volume={{ updated_by_name: null, updated_at: null }} />);
    expect(container.textContent).toBe('');
  });
});
