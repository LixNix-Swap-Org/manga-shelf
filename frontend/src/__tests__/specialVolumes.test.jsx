import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import AddVolumeBar, { specialPresets, highestRegularNumber } from '../components/detail/AddVolumeBar';
import TypeNumberFields from '../components/detail/volumeEdit/TypeNumberFields';
import { validateVolumeForm, isValidSortAfterInput, buildSaveBody, FIELD_NAMES } from '../components/detail/volumeEdit/editorUtils';
import { buildVolumeForm } from '../utils/volumeFormHelpers';

afterEach(cleanup);

const VOLUMES = [
  { type: 'volume', volume_number: '1' },
  { type: 'volume', volume_number: '12' },
  { type: 'volume', volume_number: '12.5' },
  { type: 'special_edition', volume_number: '14' },
  { type: 'schuber', volume_number: 'Schuber 3' }
];

/** AddVolumeBar with real state, the way MangaDetail wires it from useVolumeActions. */
function Harness({ volumes = VOLUMES, onSubmit = vi.fn() }) {
  const [type, setType] = useState('volume');
  const [num, setNum] = useState('');
  const [after, setAfter] = useState('');
  return (
    <>
      <AddVolumeBar
        canEdit handleAddSingleVolume={(e) => { e.preventDefault(); onSubmit({ type, num, after }); }}
        handleUploadNewSingleCover={vi.fn()} newVolumeCover="" newVolumeNum={num} newVolumePrice="" newVolumeReleaseDate=""
        newVolumeStatus="Vorhanden" newVolumeType={type} setNewVolumeCover={vi.fn()} setNewVolumeNum={setNum}
        setNewVolumePrice={vi.fn()} setNewVolumeReleaseDate={vi.fn()} setNewVolumeStatus={vi.fn()} setNewVolumeType={setType}
        newVolumeSortAfter={after} setNewVolumeSortAfter={setAfter} volumes={volumes} uploadingNewCover={false}
      />
      <output data-testid="state">{`${type}|${num}|${after}`}</output>
    </>
  );
}

const state = () => screen.getByTestId('state').textContent;

describe('special volume presets', () => {
  it('derive Band 0, the next half volume and specials placed after the highest regular volume', () => {
    expect(highestRegularNumber(VOLUMES)).toBe(12);
    expect(highestRegularNumber([])).toBe(0);
    const presets = specialPresets(VOLUMES);
    expect(presets.map(p => [p.key, p.type, p.number, p.sortAfter])).toEqual([
      ['zero', 'volume', '0', ''],
      ['half', 'volume', '12.5', ''],
      ['Guidebook', 'special', 'Guidebook', '12'],
      ['Fanbook', 'special', 'Fanbook', '12'],
      ['Artbook', 'special', 'Artbook', '12'],
      ['Anthologie', 'special', 'Anthologie', '12']
    ]);
    expect(presets.map(p => p.name).slice(0, 2)).toEqual(['Band 0', 'Band 12.5']);
    expect(specialPresets([]).find(p => p.key === 'Guidebook').sortAfter).toBe('');
  });

  it('a chip fills type, number and position, shows the position field and focuses the number', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const group = screen.getByRole('group', { name: 'Sonderband' });
    expect(screen.queryByLabelText('Einsortieren nach Band')).toBeNull();

    fireEvent.click(group.querySelector('[data-preset="Guidebook"]'));
    expect(state()).toBe('special|Guidebook|12');
    expect(document.activeElement.id).toBe('add-volume-number');
    const after = screen.getByLabelText('Einsortieren nach Band');
    expect(after.value).toBe('12');
    expect(after.placeholder).toBe('am Ende');

    fireEvent.change(after, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /Hinzufügen/ }));
    expect(onSubmit).toHaveBeenCalledWith({ type: 'special', num: 'Guidebook', after: '3' });

    fireEvent.click(group.querySelector('[data-preset="zero"]'));
    expect(state()).toBe('volume|0|');
    expect(screen.queryByLabelText('Einsortieren nach Band')).toBeNull();
  });

  it('the presets and the position field stay away without a setter (older callers)', () => {
    render(<AddVolumeBar canEdit handleAddSingleVolume={vi.fn()} handleUploadNewSingleCover={vi.fn()} newVolumeCover=""
      newVolumeNum="" newVolumePrice="" newVolumeReleaseDate="" newVolumeStatus="Vorhanden" newVolumeType="special"
      setNewVolumeCover={vi.fn()} setNewVolumeNum={vi.fn()} setNewVolumePrice={vi.fn()} setNewVolumeReleaseDate={vi.fn()}
      setNewVolumeStatus={vi.fn()} setNewVolumeType={vi.fn()} uploadingNewCover={false} />);
    expect(screen.queryByRole('group', { name: 'Sonderband' })).toBeNull();
    expect(screen.queryByLabelText('Einsortieren nach Band')).toBeNull();
  });
});

describe('sort_after in the volume editor', () => {
  it('the form carries sort_after as text and saves only a change', () => {
    const base = buildVolumeForm({ type: 'special', volume_number: 'Guidebook', sort_after: 12 });
    expect(base.sort_after).toBe('12');
    expect(buildVolumeForm({ type: 'volume', volume_number: '3' }).sort_after).toBe('');
    expect(buildSaveBody({ ...base, sort_after: '4' }, base)).toEqual({ sort_after: '4' });
    expect(buildSaveBody(base, base)).toEqual({});
  });

  it('validates like the server and names the field', () => {
    for (const ok of ['', '0', '12', '12,5', '12.5', '5000']) expect(isValidSortAfterInput(ok), ok).toBe(true);
    for (const bad of ['-1', 'zwölf', '12.55', '5001']) expect(isValidSortAfterInput(bad), bad).toBe(false);
    const form = buildVolumeForm({ type: 'special', volume_number: 'Fanbook' });
    expect(validateVolumeForm({ ...form, sort_after: 'x' }).sort_after).toBe('Bandnummer von 0 bis 5000, z. B. 12');
    expect(validateVolumeForm({ ...form, type: 'volume', volume_number: '3', sort_after: 'x' }).sort_after).toBeUndefined();
    expect(FIELD_NAMES.sort_after).toBe('Einsortieren nach Band');
  });

  it('the editor shows the position field for a special only, with its hint and error', () => {
    const setForm = vi.fn();
    const { rerender } = render(<TypeNumberFields editVolForm={{ type: 'volume', volume_number: '3' }} setEditVolForm={setForm} />);
    expect(screen.queryByLabelText('Einsortieren nach Band')).toBeNull();

    rerender(<TypeNumberFields editVolForm={{ type: 'special', volume_number: 'Fanbook', sort_after: '7' }} setEditVolForm={setForm}
      sortAfterError="Bandnummer von 0 bis 5000, z. B. 12" />);
    const field = screen.getByLabelText('Einsortieren nach Band');
    expect(field.value).toBe('7');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    const described = field.getAttribute('aria-describedby').split(' ').map(id => document.getElementById(id).textContent);
    expect(described).toEqual(['Leer lassen, damit der Eintrag hinter allen Bänden steht.', 'Bandnummer von 0 bis 5000, z. B. 12']);

    fireEvent.change(field, { target: { value: '9' } });
    expect(setForm.mock.calls[0][0]({ sort_after: '7' })).toEqual({ sort_after: '9' });
  });
});
