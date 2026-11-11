// "Edition & Abgleich": missing volumes and missing extras (Schuber, special volumes) are counted apart.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EditionTab from '../components/detail/EditionTab';

const renderTab = (entries) => render(
  <MemoryRouter>
    <EditionTab manga={{ id: 1, title: 'One Piece' }} canEdit isOffline={false} detectedGapEntries={entries} mpEnabled={false} />
  </MemoryRouter>
);

describe('EditionTab gap text', () => {
  it('names volumes and extras separately', () => {
    renderTab([{ label: 21, type: 'volume' }, { label: 22, type: 'volume' }, { label: 'East Blue Leerschuber', type: 'schuber' }]);
    expect(screen.getByText(/Nicht im Regal: 2 Bände und 1 Extra wie Schuber oder Sonderband\. Auf Wunsch/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Lücken füllen' })).toBeTruthy();
  });

  it('only extras: no offer to add them as missing volumes', () => {
    renderTab(Array.from({ length: 10 }, (_, i) => ({ label: `Schuber ${i}`, type: 'schuber' })));
    expect(screen.getByText('Nicht im Regal: 10 Extras wie Schuber oder Sonderbände.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lücken füllen' })).toBeNull();
  });
});
