// Covers the reader bar and its read-count display.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReaderBar from '../components/detail/ReaderBar';

const readers = [
  { user_id: 1, username: 'max', display_name: 'Max', read_count: 3, total_owned: 5 },
  { user_id: 2, username: 'lea', read_count: 1, total_owned: 5 }
];
const props = (over = {}) => ({
  readers,
  selectedReaderId: 'ALL',
  setSelectedReaderId: vi.fn(),
  user: { id: 1 },
  ownedCount: 5,
  currentReaderReadCount: 3,
  currentReaderUnreadCount: 2,
  ...over
});
const openChip = () => fireEvent.click(document.getElementById('btn-reader-chip'));
const isActive = (name) => screen.getByRole('button', { name }).className.includes('bg-brand-700');

describe('ReaderBar', () => {
  it('renders nothing without readers', () => {
    const { container } = render(<ReaderBar {...props({ readers: [] })} />);
    expect(container.innerHTML).toBe('');
  });

  it('lists every reader with read / owned and the progress of the active one', () => {
    render(<ReaderBar {...props()} />);
    expect(screen.getByRole('button', { name: 'Leser und Besitz: Max liest' })).toBeTruthy();
    openChip();
    expect(screen.getByRole('button', { name: /^Max\s*3 \/ 5$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^lea\s*1 \/ 5$/ })).toBeTruthy();
    expect(screen.getByText('60%')).toBeTruthy();
    expect(isActive(/^Max/)).toBe(true);
    expect(isActive(/^lea/)).toBe(false);
  });

  it('clicking another reader reports that reader', () => {
    const p = props();
    const { rerender } = render(<ReaderBar {...p} />);
    openChip();
    fireEvent.click(screen.getByRole('button', { name: /^lea/ }));
    expect(p.setSelectedReaderId).toHaveBeenCalledWith(2);

    rerender(<ReaderBar {...p} selectedReaderId={2} currentReaderReadCount={1} currentReaderUnreadCount={4} />);
    expect(isActive(/^lea/)).toBe(true);
    expect(isActive(/^Max/)).toBe(false);
    expect(screen.getByText('20%')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Leser und Besitz: lea liest/ })).toBeTruthy();
  });

  it('never shows more read than owned volumes or more than 100 %', () => {
    render(<ReaderBar {...props({ readers: [{ user_id: 1, username: 'max', read_count: 2, total_owned: 1 }], ownedCount: 1, currentReaderReadCount: 2, currentReaderUnreadCount: -1 })} />);
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.getByText(/Gelesen:/).textContent).toBe('Gelesen: 1 von 1');
    expect(screen.getByText(/SuB:/).textContent).toBe('SuB: 0');
    // one reader and nothing to pick: the chip only names the reader
    expect(screen.queryByRole('button', { name: /Leser und Besitz/ })).toBeNull();
    expect(document.getElementById('btn-reader-chip').textContent).toBe('max liest');
  });

  it('"Gelesen am" starts empty (now) without a picked date and reports a pick or a cleared field', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const setReadDate = vi.fn();
    const { rerender } = render(<ReaderBar {...props({ canToggle: true, readDate: null, setReadDate })} />);
    const field = screen.getByLabelText('Gelesen am');
    expect(field.value).toBe('');
    fireEvent.change(field, { target: { value: '2026-09-01' } });
    expect(setReadDate).toHaveBeenLastCalledWith('2026-09-01');
    rerender(<ReaderBar {...props({ canToggle: true, readDate: '2026-09-01', setReadDate })} />);
    expect(screen.getByLabelText('Gelesen am').value).toBe('2026-09-01');
    rerender(<ReaderBar {...props({ canToggle: true, readDate: null, setReadDate })} />);
    expect(screen.getByLabelText('Gelesen am').value).toBe('');
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('"+ Band n gelesen" marks the next unread volume, only for a reader who may tick', () => {
    const onMarkNextRead = vi.fn();
    const { rerender } = render(<ReaderBar {...props({ canToggle: true, nextUnreadVolume: { id: 9, volume_number: '4' }, onMarkNextRead })} />);
    fireEvent.click(screen.getByRole('button', { name: /\+ Band 4 gelesen/ }));
    expect(onMarkNextRead).toHaveBeenCalledTimes(1);
    rerender(<ReaderBar {...props({ canToggle: false, nextUnreadVolume: { id: 9, volume_number: '4' }, onMarkNextRead })} />);
    expect(screen.queryByRole('button', { name: /\+ Band 4 gelesen/ })).toBeNull();
    rerender(<ReaderBar {...props({ canToggle: true, nextUnreadVolume: null, onMarkNextRead })} />);
    expect(screen.queryByRole('button', { name: /gelesen$/ })).toBeNull();
  });

  it('the chip closes on Escape and on a click outside; a picked date and owner filter show in the chip', () => {
    const owners = {
      users: [{ user_id: 1, username: 'max', display_name: 'Max' }, { user_id: 2, username: 'lea' }],
      volumes: [{ id: 1, status: 'Vorhanden', owners: [{ user_id: 1 }] }, { id: 2, status: 'Fehlt', owners: [] }],
      ownerFilter: 'ALL', setOwnerFilter: vi.fn(), ownerMissing: false, setOwnerMissing: vi.fn()
    };
    const { rerender } = render(<ReaderBar {...props({ owners, canToggle: true, setReadDate: vi.fn() })} />);
    const chip = screen.getByRole('button', { name: 'Leser und Besitz: Max liest · Alle Bände' });
    fireEvent.click(chip);
    expect(screen.getByRole('group', { name: 'Besitz filtern' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^lea\s*0 \/ 2$/ })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(chip);
    fireEvent.click(chip);
    fireEvent.pointerDown(document.body);
    expect(chip.getAttribute('aria-expanded')).toBe('false');

    rerender(<ReaderBar {...props({ owners: { ...owners, ownerFilter: 2, ownerMissing: true }, canToggle: true, setReadDate: vi.fn(), readDate: '2026-09-01' })} />);
    expect(screen.getByRole('button', { name: 'Leser und Besitz: Max liest · Bände von lea · fehlt noch · gelesen am 01.09.2026' })).toBeTruthy();
  });

  it('with one person the ownership choice stays out of the chip', () => {
    const owners = {
      users: [{ user_id: 1, username: 'max' }], volumes: [], ownerFilter: 'ALL',
      setOwnerFilter: vi.fn(), ownerMissing: false, setOwnerMissing: vi.fn()
    };
    render(<ReaderBar {...props({ readers: [readers[0]], owners, canToggle: true, setReadDate: vi.fn() })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Leser und Besitz: Max liest' }));
    expect(screen.queryByRole('group', { name: 'Besitz filtern' })).toBeNull();
    expect(screen.getByLabelText('Gelesen am')).toBeTruthy();
  });
});
