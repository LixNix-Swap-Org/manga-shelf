import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import OwnerFilterBar from '../components/detail/OwnerFilterBar';

const users = [
  { user_id: 1, username: 'max', display_name: 'Max' },
  { user_id: 2, username: 'lea' }
];
const volumes = [
  { id: 1, status: 'Vorhanden', owners: [{ user_id: 1 }] },
  { id: 2, status: 'Vorhanden', owners: [{ user_id: 1 }, { user_id: 2 }] },
  { id: 3, status: 'Fehlt', owners: [] },
  { id: 4, status: 'Vorbestellt' },
  { id: 5, status: 'Erscheint bald' }
];

function Stateful() {
  const [ownerFilter, setOwnerFilter] = useState('ALL');
  const [ownerMissing, setOwnerMissing] = useState(false);
  return (
    <>
      <OwnerFilterBar users={users} volumes={volumes} ownerFilter={ownerFilter} setOwnerFilter={setOwnerFilter} ownerMissing={ownerMissing} setOwnerMissing={setOwnerMissing} />
      <output data-testid="state">{`${ownerFilter}|${ownerMissing}`}</output>
    </>
  );
}

describe('OwnerFilterBar', () => {
  it('renders nothing for a single user', () => {
    const { container } = render(
      <OwnerFilterBar users={[users[0]]} volumes={volumes} ownerFilter="ALL" setOwnerFilter={vi.fn()} ownerMissing={false} setOwnerMissing={vi.fn()} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('shows one chip per person with owned / releasable counts', () => {
    render(<Stateful />);
    expect(screen.getByRole('button', { name: 'Alle' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Max\s*2 \/ 3$/ }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /^lea\s*1 \/ 3$/ })).toBeTruthy();
    expect(screen.queryByLabelText('Nur zeigen, was noch fehlt')).toBeNull();
  });

  it('click selects a person, a second click or "Alle" resets the filter', () => {
    render(<Stateful />);
    const state = () => screen.getByTestId('state').textContent;
    const max = screen.getByRole('button', { name: /^Max/ });

    fireEvent.click(max);
    expect(state()).toBe('1|false');
    expect(max.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByLabelText('Nur zeigen, was noch fehlt'));
    expect(state()).toBe('1|true');

    fireEvent.click(screen.getByRole('button', { name: 'Alle' }));
    expect(state()).toBe('ALL|false');
    expect(screen.queryByLabelText('Nur zeigen, was noch fehlt')).toBeNull();

    fireEvent.click(max);
    fireEvent.click(max);
    expect(state()).toBe('ALL|false');
  });

  it('total and missing count use the same rule: preorders, orders and announced volumes do not count', () => {
    const vols = [
      ...[...Array(12)].map((_, i) => ({ id: i, status: 'Vorhanden', owners: [{ user_id: 1 }] })),
      ...[...Array(5)].map((_, i) => ({ id: 20 + i, status: 'Fehlt', owners: [] })),
      ...[...Array(3)].map((_, i) => ({ id: 30 + i, status: 'Vorbestellt', owners: [] })),
      { id: 40, status: 'Bestellt', owners: [] }
    ];
    render(<OwnerFilterBar users={users} volumes={vols} ownerFilter="ALL" setOwnerFilter={vi.fn()} ownerMissing={false} setOwnerMissing={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^Max\s*12 \/ 17$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^lea\s*0 \/ 17$/ })).toBeTruthy();
  });

  it('hides accounts that cannot own anything unless they own something here', () => {
    const withRoles = [
      { user_id: 1, username: 'max', role: 'admin' },
      { user_id: 2, username: 'gast', role: 'visitor' },
      { user_id: 3, username: 'ed', role: 'editor' }
    ];
    const base = [{ id: 1, status: 'Vorhanden', owners: [{ user_id: 1 }] }, { id: 3, status: 'Fehlt', owners: [] }];
    const { rerender, container } = render(
      <OwnerFilterBar users={withRoles} volumes={base} ownerFilter="ALL" setOwnerFilter={vi.fn()} ownerMissing={false} setOwnerMissing={vi.fn()} />
    );
    expect(screen.queryByRole('button', { name: /^gast/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^ed/ })).toBeTruthy();

    const owned = [...base, { id: 9, status: 'Vorhanden', owners: [{ user_id: 2 }] }];
    rerender(<OwnerFilterBar users={withRoles} volumes={owned} ownerFilter="ALL" setOwnerFilter={vi.fn()} ownerMissing={false} setOwnerMissing={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^gast/ })).toBeTruthy();

    rerender(<OwnerFilterBar users={withRoles.slice(0, 2)} volumes={base} ownerFilter="ALL" setOwnerFilter={vi.fn()} ownerMissing={false} setOwnerMissing={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });
});
