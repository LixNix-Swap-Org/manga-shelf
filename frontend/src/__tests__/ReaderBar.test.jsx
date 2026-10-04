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
const isActive = (name) => screen.getByRole('button', { name }).className.includes('bg-brand-700');

describe('ReaderBar', () => {
  it('renders nothing without readers', () => {
    const { container } = render(<ReaderBar {...props({ readers: [] })} />);
    expect(container.innerHTML).toBe('');
  });

  it('lists every reader with read / owned and the progress of the active one', () => {
    render(<ReaderBar {...props()} />);
    expect(screen.getByRole('button', { name: /^Max\s*3 \/ 5$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^lea\s*1 \/ 5$/ })).toBeTruthy();
    expect(screen.getByText('60%')).toBeTruthy();
    expect(isActive(/^Max/)).toBe(true);
    expect(isActive(/^lea/)).toBe(false);
  });

  it('clicking another reader reports that reader', () => {
    const p = props();
    const { rerender } = render(<ReaderBar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /^lea/ }));
    expect(p.setSelectedReaderId).toHaveBeenCalledWith(2);

    rerender(<ReaderBar {...p} selectedReaderId={2} currentReaderReadCount={1} currentReaderUnreadCount={4} />);
    expect(isActive(/^lea/)).toBe(true);
    expect(isActive(/^Max/)).toBe(false);
    expect(screen.getByText('20%')).toBeTruthy();
  });

  it('never shows more read than owned volumes or more than 100 %', () => {
    render(<ReaderBar {...props({ readers: [{ user_id: 1, username: 'max', read_count: 2, total_owned: 1 }], ownedCount: 1, currentReaderReadCount: 2, currentReaderUnreadCount: -1 })} />);
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.getByText(/Gelesen:/).textContent).toBe('Gelesen: 1 von 1');
    expect(screen.getByText(/SuB:/).textContent).toBe('SuB: 0');
    expect(screen.getByRole('button', { name: /^max\s*1 \/ 1$/ }).getAttribute('aria-pressed')).toBe('true');
  });
});
