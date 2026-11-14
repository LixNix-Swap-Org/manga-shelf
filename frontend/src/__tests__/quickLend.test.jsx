import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import QuickLendPopover from '../components/detail/QuickLendPopover';
import {
  getLastBorrower,
  rememberLastBorrower,
  selectQuickLendCopy,
  canChangeCopy
} from '../utils/lendingHelpers';

describe('lendingHelpers', () => {
  const user = { id: 1, username: 'anna', role: 'member' };
  const admin = { id: 3, username: 'admin', role: 'admin' };

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('getLastBorrower returns null when empty or corrupted', () => {
    expect(getLastBorrower(1)).toBeNull();
    localStorage.setItem('mangashelf_last_borrower:1', 'not-valid-json{{{');
    // falls back to string name if non-empty string
    expect(getLastBorrower(1)).toEqual({ name: 'not-valid-json{{{' });
  });

  it('rememberLastBorrower stores both scoped and global keys, and getLastBorrower retrieves them', () => {
    rememberLastBorrower(1, { user_id: 2, name: 'ben' });
    expect(getLastBorrower(1)).toEqual({ user_id: 2, name: 'ben' });

    // Also supports plain string borrower
    rememberLastBorrower(1, 'Oma');
    expect(getLastBorrower(1)).toEqual({ name: 'Oma' });
    expect(localStorage.getItem('manga_shelf_last_borrower')).toBe('Oma');
  });

  it('selectQuickLendCopy selects own copy -> household copy -> admin copy', () => {
    const copy1 = { id: 10, owner_user_id: 2, lent_to: null }; // foreign
    const copy2 = { id: 11, owner_user_id: null, lent_to: null }; // household
    const copy3 = { id: 12, owner_user_id: 1, lent_to: null }; // own

    // 1. With own copy present
    expect(selectQuickLendCopy({ copies: [copy1, copy2, copy3] }, user, true)?.id).toBe(12);

    // 2. With only foreign and household copy
    expect(selectQuickLendCopy({ copies: [copy1, copy2] }, user, true)?.id).toBe(11);

    // 3. Regular user with only foreign copy -> null
    expect(selectQuickLendCopy({ copies: [copy1] }, user, true)).toBeNull();

    // 4. Admin user with only foreign copy -> gets foreign copy
    expect(selectQuickLendCopy({ copies: [copy1] }, admin, true)?.id).toBe(10);

    // 5. Already lent copies are skipped
    const lentOwn = { id: 13, owner_user_id: 1, lent_to: 'Someone' };
    expect(selectQuickLendCopy({ copies: [lentOwn, copy2] }, user, true)?.id).toBe(11);
  });

  it('canChangeCopy enforces ownership, household, and admin privileges', () => {
    expect(canChangeCopy({ owner_user_id: 1 }, user, true)).toBe(true);
    expect(canChangeCopy({ owner_user_id: null }, user, true)).toBe(true);
    expect(canChangeCopy({ owner_user_id: 2 }, user, true)).toBe(false);
    expect(canChangeCopy({ owner_user_id: 2 }, admin, true)).toBe(true);
    expect(canChangeCopy({ owner_user_id: 1 }, user, false)).toBe(false);
  });
});

describe('QuickLendPopover component', () => {
  const users = [
    { id: 1, username: 'anna' },
    { id: 2, username: 'ben' },
    { id: 3, username: 'chris' }
  ];
  const user = { id: 1, username: 'anna' };
  const copy = { id: 10, owner_user_id: 1 };

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns null when isOpen is false', () => {
    const { container } = render(
      <QuickLendPopover isOpen={false} user={user} users={users} onLend={vi.fn()} onClose={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders household member pills excluding current user/owner and lends in 1 click', () => {
    const onLend = vi.fn();
    const onClose = vi.fn();

    render(
      <QuickLendPopover
        isOpen={true}
        user={user}
        copy={copy}
        users={users}
        onLend={onLend}
        onClose={onClose}
      />
    );

    expect(screen.getByRole('button', { name: 'ben' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chris' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'anna' })).toBeNull(); // Excluded copy owner

    fireEvent.click(screen.getByRole('button', { name: 'ben' }));

    expect(onLend).toHaveBeenCalledTimes(1);
    expect(onLend).toHaveBeenCalledWith({ user_id: 2 });
    expect(onClose).toHaveBeenCalledTimes(1);

    // Borrower remembered in localStorage
    expect(getLastBorrower(1)).toEqual({ user_id: 2, name: 'ben' });
  });

  it('renders remembered last borrower chip and lends in 1 click', () => {
    rememberLastBorrower(1, { user_id: 2, name: 'ben' });
    const onLend = vi.fn();
    const onClose = vi.fn();

    render(
      <QuickLendPopover
        isOpen={true}
        user={user}
        copy={copy}
        users={users}
        onLend={onLend}
        onClose={onClose}
      />
    );

    const lastBtn = screen.getByRole('button', { name: /Zuletzt: ben/ });
    expect(lastBtn).toBeTruthy();

    fireEvent.click(lastBtn);

    expect(onLend).toHaveBeenCalledTimes(1);
    expect(onLend).toHaveBeenCalledWith({ user_id: 2 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders last borrower from fallback string in localStorage and lends in 1 click', () => {
    localStorage.setItem('manga_shelf_last_borrower', 'Oma');
    const onLend = vi.fn();
    const onClose = vi.fn();

    render(
      <QuickLendPopover
        isOpen={true}
        currentUserId={1}
        users={users}
        onLend={onLend}
        onClose={onClose}
      />
    );

    const lastBtn = screen.getByRole('button', { name: /Oma/ });
    expect(lastBtn).toBeTruthy();

    fireEvent.click(lastBtn);

    expect(onLend).toHaveBeenCalledTimes(1);
    expect(onLend).toHaveBeenCalledWith({ name: 'Oma' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('allows entering a custom borrower name and submitting in 1 click', () => {
    const onLend = vi.fn();
    const onClose = vi.fn();

    render(
      <QuickLendPopover
        isOpen={true}
        user={user}
        copy={copy}
        users={users}
        onLend={onLend}
        onClose={onClose}
      />
    );

    const input = screen.getByLabelText('Andere Person');
    fireEvent.change(input, { target: { value: 'Daniel' } });

    const submitBtn = screen.getByRole('button', { name: 'Verleihen' });
    fireEvent.click(submitBtn);

    expect(onLend).toHaveBeenCalledTimes(1);
    expect(onLend).toHaveBeenCalledWith({ name: 'Daniel' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(getLastBorrower(1)).toEqual({ name: 'Daniel' });
  });

  it('closes on Escape key without lending', () => {
    const onLend = vi.fn();
    const onClose = vi.fn();

    render(
      <QuickLendPopover
        isOpen={true}
        user={user}
        copy={copy}
        users={users}
        onLend={onLend}
        onClose={onClose}
      />
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onLend).not.toHaveBeenCalled();
  });

  it('closes on close button click', () => {
    const onClose = vi.fn();

    render(
      <QuickLendPopover
        isOpen={true}
        user={user}
        copy={copy}
        users={users}
        onLend={vi.fn()}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Schließen' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on outside click', () => {
    const onClose = vi.fn();

    render(
      <div>
        <div data-testid="outside">Outside</div>
        <QuickLendPopover
          isOpen={true}
          user={user}
          copy={copy}
          users={users}
          onLend={vi.fn()}
          onClose={onClose}
        />
      </div>
    );

    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
