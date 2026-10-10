import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import GapNotices from '../components/detail/GapNotices';

const entries = (...list) => ({ detectedGapEntries: list, detectedGaps: list.map(e => e.label) });

const base = (over = {}) => ({
  canEdit: true, showGaps: true, volumeFilter: 'ALL', volumeSearch: '', gapsAllowedByFilters: true,
  mpGapData: { matched: true, link_confirmed: true, edition: { id: 9, title: 'DE' }, total_official_volumes: 22 },
  fillingGapLoading: false, handleBatchFillGaps: vi.fn(), setShowMpEditionModal: vi.fn(),
  ...entries({ label: 7, type: 'volume' }, { label: 8, type: 'volume' }),
  ...over
});

describe('GapNotices: announced volumes and extras', () => {
  it('shows "+ N angekündigt" after the gap count only when announced volumes exist', () => {
    const { rerender } = render(<GapNotices {...base({ announcedGapCount: 2 })} />);
    expect(screen.getByText(/2 Lücken entdeckt/)).toBeTruthy();
    expect(screen.getByText('+ 2 angekündigt')).toBeTruthy();
    rerender(<GapNotices {...base({ announcedGapCount: 1 })} />);
    expect(screen.getByText('+ 1 angekündigt')).toBeTruthy();
    rerender(<GapNotices {...base()} />);
    expect(screen.queryByText(/angekündigt/)).toBeNull();
  });

  it('announced volumes alone show no gap banner', () => {
    render(<GapNotices {...base({ ...entries(), announcedGapCount: 19 })} />);
    expect(screen.queryByText(/angekündigt/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Einkaufsliste/ })).toBeNull();
  });

  it('"Alle auf Einkaufsliste" and "Auch N Sonderausgaben/Schuber" call the import separately', () => {
    const props = base(entries(
      { label: 7, type: 'volume' },
      { label: '3 (Collectors Edition)', type: 'special_edition' },
      { label: '11 (Schuber)', type: 'schuber' }
    ));
    render(<GapNotices {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Alle auf Einkaufsliste/ }));
    expect(props.handleBatchFillGaps).toHaveBeenLastCalledWith('Fehlt');
    fireEvent.click(screen.getByRole('button', { name: 'Auch 2 Sonderausgaben/Schuber' }));
    expect(props.handleBatchFillGaps).toHaveBeenLastCalledWith('Fehlt', { extrasOnly: true });
    expect(props.handleBatchFillGaps).toHaveBeenCalledTimes(2);
  });

  it('without extras there is no second action; with extras only the regular action is gone', () => {
    const { rerender } = render(<GapNotices {...base()} />);
    expect(screen.queryByRole('button', { name: /^Auch / })).toBeNull();
    rerender(<GapNotices {...base(entries({ label: '11 (Schuber)', type: 'schuber' }))} />);
    expect(screen.queryByRole('button', { name: /Alle auf Einkaufsliste/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Auch 1 Sonderausgabe/Schuber' })).toBeTruthy();
  });

  it('the extras action waits for a confirmed edition and is hidden offline and for readers', () => {
    const props = base({
      ...entries({ label: 7, type: 'volume' }, { label: '11 (Schuber)', type: 'schuber' }),
      gapEditionUnconfirmed: true
    });
    const { rerender } = render(<GapNotices {...props} />);
    const extras = screen.getByRole('button', { name: 'Auch 1 Sonderausgabe/Schuber' });
    expect(extras.disabled).toBe(true);
    expect(extras.title).toBe('Erst die Manga-Passion-Edition bestätigen');
    rerender(<GapNotices {...props} gapEditionUnconfirmed={false} isOffline />);
    expect(screen.queryByRole('button', { name: /^Auch / })).toBeNull();
    rerender(<GapNotices {...props} gapEditionUnconfirmed={false} canEdit={false} />);
    expect(screen.queryByRole('button', { name: /^Auch / })).toBeNull();
  });
});
