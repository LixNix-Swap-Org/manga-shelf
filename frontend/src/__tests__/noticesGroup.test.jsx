// Covers "Hinweise (n)" above the volumes: folding from two notices on, badges that jump, late notices.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import NoticesGroup from '../components/detail/NoticesGroup';

const Notice = ({ label }) => <div data-notice={label}><span>{label} text</span><button type="button">{`${label} action`}</button></div>;

describe('NoticesGroup', () => {
  beforeEach(() => localStorage.clear());

  it('one notice shows as before, without a row', () => {
    render(<NoticesGroup><Notice label="2 Lücken" /></NoticesGroup>);
    expect(screen.queryByRole('button', { name: /Hinweise/ })).toBeNull();
    expect(screen.getByText('2 Lücken text').closest('.notices-folded')).toBeNull();
  });

  it('two notices fold into "Hinweise (2)"; a badge opens the row and focuses its action; status lines stay visible', () => {
    render(<NoticesGroup><Notice label="2 Lücken" /><p role="status">Hinweis</p><Notice label="Bände übernehmen" /></NoticesGroup>);
    const toggle = screen.getByRole('button', { name: /Hinweise \(2\)/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('2 Lücken text').closest('.notices-folded')).toBeTruthy();
    expect(screen.getByRole('status').hasAttribute('data-notice')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Bände übernehmen' }));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement.textContent).toBe('Bände übernehmen action');
    expect(localStorage.getItem('mangashelf_detail_notices_open')).toBe('1');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('a notice that appears later is counted', async () => {
    let show;
    function Late() {
      const [visible, setVisible] = useState(false);
      show = () => setVisible(true);
      return visible ? <Notice label="Bände übernehmen" /> : null;
    }
    render(<NoticesGroup><Notice label="Edition bestätigen" /><Late /></NoticesGroup>);
    expect(screen.queryByRole('button', { name: /Hinweise/ })).toBeNull();
    await act(async () => { show(); });
    expect(await screen.findByRole('button', { name: /Hinweise \(2\)/ })).toBeTruthy();
  });
});
