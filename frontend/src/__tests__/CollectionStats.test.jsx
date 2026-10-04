// Covers the collection statistics tiles and their interactions.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CollectionStats from '../components/dashboard/CollectionStats';

const stat = (label) => screen.getByText(label).nextElementSibling.textContent;

describe('CollectionStats', () => {
  it('shows the totals it is given', () => {
    render(<CollectionStats totalSeries={12} totalOwnedVolumes={148} totalCollectionValue={1234.5} completedSeries={3} handleOpenStats={vi.fn()} />);
    expect(stat('Reihen')).toBe('12');
    expect(stat('Bände im Besitz')).toBe('148');
    expect(stat('Komplett')).toBe('3');
    expect(screen.getByText('1.234,50 €')).toBeTruthy();
  });

  it('shows zero totals for an empty collection', () => {
    render(<CollectionStats totalSeries={0} totalOwnedVolumes={0} totalCollectionValue={0} completedSeries={0} handleOpenStats={vi.fn()} />);
    expect(stat('Reihen')).toBe('0');
    expect(stat('Bände im Besitz')).toBe('0');
    expect(screen.getByText('0,00 €')).toBeTruthy();
  });

  it('the collection value card opens the statistics', () => {
    const handleOpenStats = vi.fn();
    render(<CollectionStats totalSeries={1} totalOwnedVolumes={1} totalCollectionValue={7} completedSeries={0} handleOpenStats={handleOpenStats} />);
    fireEvent.click(screen.getByText('7,00 €'));
    expect(handleOpenStats).toHaveBeenCalledTimes(1);
  });

  it('the collection value card is a named button that keyboard users reach', () => {
    const handleOpenStats = vi.fn();
    render(<CollectionStats totalSeries={1} totalOwnedVolumes={1} totalCollectionValue={7} completedSeries={0} handleOpenStats={handleOpenStats} />);
    const button = screen.getByRole('button', { name: /Sammlungswert 7,00\s€ – Statistik öffnen/ });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.disabled).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it('offline the card keeps its value but does not open the statistics', () => {
    const handleOpenStats = vi.fn();
    render(<CollectionStats totalSeries={1} totalOwnedVolumes={1} totalCollectionValue={7} completedSeries={0} handleOpenStats={handleOpenStats} isOfflineMode />);
    const button = screen.getByRole('button', { name: /Sammlungswert 7,00\s€/ });
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Offline nicht verfügbar');
    fireEvent.click(button);
    expect(handleOpenStats).not.toHaveBeenCalled();
    expect(screen.getByText('7,00 €')).toBeTruthy();
  });

  it('labels wrap instead of truncating, the details hint only shows from xl and the icon tiles leave the narrow columns', () => {
    render(<CollectionStats totalSeries={1} totalOwnedVolumes={1} totalCollectionValue={6488.5} completedSeries={0} handleOpenStats={vi.fn()} />);
    for (const label of ['Reihen', 'Bände im Besitz', 'Sammlungswert', 'Komplett']) {
      const el = screen.getByText(label);
      expect(el.className).not.toMatch(/(^|\s)truncate(\s|$)/);
      expect(el.className).toContain('break-words');
      expect(el.className).toContain('hyphens-auto');
    }
    const hint = screen.getByText('Details ↗');
    expect(hint.className).toContain('hidden xl:inline');
    expect(hint.className).toContain('shrink-0');
    expect(screen.getByText('Sammlungswert').className).toContain('min-w-0');
    const tiles = document.querySelectorAll('section > * > div:first-child');
    expect(tiles).toHaveLength(4);
    for (const tile of tiles) expect(tile.className).toContain('md:hidden xl:flex');
    expect(screen.getByText('6.488,50 €').className).toContain('whitespace-nowrap');
  });
});
