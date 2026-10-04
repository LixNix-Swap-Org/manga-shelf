import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import BatchAddModal, { validateBatchRange, batchResultText } from '../components/detail/BatchAddModal';
import BatchReadModal, { batchReadTarget } from '../components/detail/BatchReadModal';
import MangaHeroCard, { heroCoverUrl, shouldShowCover, authorShelfPath, tagShelfPath, lookupBadgeLabels, TagEditor } from '../components/detail/MangaHeroCard';
import Toaster from '../components/common/Toaster';
import { MemoryRouter } from 'react-router-dom';
import GapNotices, { duplicateHint } from '../components/detail/GapNotices';
import GapFillModal, { gapFillOptions, formatGermanDate } from '../components/detail/GapFillModal';
import MpEditionModal, { mpModalActions } from '../components/detail/MpEditionModal';
import AddVolumeBar from '../components/detail/AddVolumeBar';
import EditHeader from '../components/detail/volumeEdit/EditHeader';
import { findDuplicateEntries } from '../MangaDetail';
import { buildMpGapMap } from '../utils/volumeHelpers';
import { fakeResponse } from './fakeResponse';
import { TIMEOUTS } from '../utils/api';

const jsonResponse = (body, status = 200) => fakeResponse(status, body);

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

describe('BatchAddModal', () => {
  it('validates the range like the server (whole numbers, from >= 1, at most 300 inclusive)', () => {
    expect(validateBatchRange('1', '300')).toBeNull();
    expect(validateBatchRange('1', '301')).toMatch(/300/);
    expect(validateBatchRange('0', '2')).toMatch(/bei 1/);
    expect(validateBatchRange('5', '3')).toMatch(/nicht größer/);
    expect(validateBatchRange('1abc', '3')).toMatch(/ganze/);
    expect(validateBatchRange('1.5', '3')).toMatch(/ganze/);
  });

  it('reports created and skipped numbers', () => {
    expect(batchResultText({ created: 2, skipped: ['7'] })).toBe('2 Bände angelegt, übersprungen (schon vorhanden): 7');
    expect(batchResultText({ created: 1, skipped: [] })).toBe('1 Band angelegt');
    expect(batchResultText({ created: 0, skipped: ['1', '2'] })).toBe('0 Bände angelegt, übersprungen (schon vorhanden): 1, 2');
  });

  it('blocks an oversized range before any request', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<BatchAddModal isOpen onClose={vi.fn()} mangaId="1" manga={{}} />);
    fireEvent.change(screen.getByLabelText('Bis Band'), { target: { value: '301' } });
    fireEvent.click(screen.getByRole('button', { name: /Bände generieren/ }));
    expect(screen.getByRole('alert').textContent).toMatch(/Höchstens 300/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks an invalid price and does not send the dead release_year field', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, created: 10, skipped: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    render(<BatchAddModal isOpen onClose={onClose} mangaId="1" manga={{}} />);
    fireEvent.change(screen.getByLabelText(/Preis pro Band/), { target: { value: '7,999' } });
    fireEvent.click(screen.getByRole('button', { name: /Bände generieren/ }));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Preis pro Band/), { target: { value: '7,99' } });
    fireEvent.click(screen.getByRole('button', { name: /Bände generieren/ }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ from: 1, to: 10, default_price: '7,99' });
    expect('release_year' in body).toBe(false);
  });

  it('keeps the dialog open and names skipped numbers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true, created: 2, skipped: ['7'] })));
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    render(<BatchAddModal isOpen onClose={onClose} onSuccess={onSuccess} mangaId="1" manga={{}} />);
    fireEvent.click(screen.getByRole('button', { name: /Bände generieren/ }));
    expect((await screen.findByRole('status')).textContent).toMatch(/übersprungen \(schon vorhanden\): 7/);
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalled();
  });

  it('status pills expose their state and the close button is a labelled non-submit button', () => {
    render(<BatchAddModal isOpen onClose={vi.fn()} mangaId="1" manga={{}} />);
    expect(screen.getByRole('button', { name: 'Im Besitz' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Fehlt noch' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('group', { name: /Startstatus/ })).toBeTruthy();
    const close = screen.getByRole('button', { name: 'Schließen' });
    expect(close.getAttribute('type')).toBe('button');
  });
});

describe('BatchReadModal', () => {
  const batchCall = (fetchMock) => fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/volumes/batch-read'));
  const readers = [
    { user_id: 1, username: 'admin', read_count: 0 },
    { user_id: 2, username: 'ed', read_count: 3 }
  ];

  it('an editor always writes their own reads, whatever reader the page shows', async () => {
    expect(batchReadTarget({ user: { id: 2, role: 'editor' }, selectedReaderId: 1 })).toBe(2);
    expect(batchReadTarget({ user: { id: 1, role: 'admin' }, selectedReaderId: 2 })).toBe(2);
    expect(batchReadTarget({ user: { id: 1, role: 'admin' }, selectedReaderId: 'ALL' })).toBe(1);

    const fetchMock = vi.fn(async () => jsonResponse({ success: true, count: 3 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<BatchReadModal isOpen onClose={vi.fn()} mangaId="9" readers={readers} selectedReaderId={1} user={{ id: 2, role: 'editor', username: 'ed' }} />);
    expect(screen.queryByLabelText('Leser')).toBeNull();
    fireEvent.change(screen.getByLabelText(/Bis einschließlich/), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /Anwenden/ }));
    await waitFor(() => expect(batchCall(fetchMock)).toBeTruthy());
    expect(JSON.parse(batchCall(fetchMock)[1].body).user_id).toBe(2);
  });

  it('the admin reader select is local to the dialog', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, count: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const setSelectedReaderId = vi.fn();
    render(<BatchReadModal isOpen onClose={vi.fn()} mangaId="9" readers={readers} selectedReaderId={1} setSelectedReaderId={setSelectedReaderId} user={{ id: 1, role: 'admin' }} />);
    fireEvent.change(screen.getByLabelText('Leser'), { target: { value: '2' } });
    expect(setSelectedReaderId).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Bis einschließlich/), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /Anwenden/ }));
    await waitFor(() => expect(batchCall(fetchMock)).toBeTruthy());
    expect(String(JSON.parse(batchCall(fetchMock)[1].body).user_id)).toBe('2');
  });

  it('a count of 0 is reported and the dialog stays open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ success: true, count: 0 })));
    const onClose = vi.fn();
    render(<BatchReadModal isOpen onClose={onClose} mangaId="9" readers={readers} selectedReaderId={2} user={{ id: 2, role: 'editor' }} />);
    expect(screen.getByRole('button', { name: /Als gelesen markieren/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByLabelText(/Bis einschließlich/), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Anwenden/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Keine passenden Bände/);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('MangaHeroCard', () => {
  const baseProps = (over = {}) => ({
    canEdit: true,
    completionPct: 50,
    editing: false,
    formData: { title: 'Titel', status: 'Laufend', cover_image: '' },
    handleCoverUpload: vi.fn(),
    handleDeleteManga: vi.fn(),
    handleEditLookup: vi.fn(),
    handleUpdate: vi.fn(e => e.preventDefault()),
    manga: { title: 'Titel', cover_image: '/uploads/broken.jpg' },
    ownedCount: 1,
    saving: false,
    setEditLookupResults: vi.fn(),
    setEditing: vi.fn(),
    startEditing: vi.fn(),
    cancelEditing: vi.fn(),
    setFormData: vi.fn(),
    totalOwnedValue: 0,
    totalTarget: 2,
    uploadingCover: false,
    ...over
  });

  it('Bearbeiten and Abbrechen go through startEditing / cancelEditing (the form is rebuilt, edits are dropped)', () => {
    const props = baseProps();
    const { rerender } = render(<MangaHeroCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Bearbeiten/ }));
    expect(props.startEditing).toHaveBeenCalled();
    rerender(<MangaHeroCard {...props} editing />);
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(props.cancelEditing).toHaveBeenCalled();
    expect(props.setEditing).not.toHaveBeenCalled();
  });

  it('the empty description hint mentions Bearbeiten only to editors', () => {
    const { rerender } = render(<MangaHeroCard {...baseProps()} />);
    expect(screen.getByText(/Klicke auf "Bearbeiten"/)).toBeTruthy();
    rerender(<MangaHeroCard {...baseProps({ canEdit: false })} />);
    expect(screen.queryByText(/Bearbeiten/)).toBe(null);
    expect(screen.getByText('Keine Beschreibung vorhanden.')).toBeTruthy();
  });

  it('offers Abgebrochen and keeps a legacy stored status selectable', () => {
    render(<MangaHeroCard {...baseProps({ editing: true, formData: { title: 'T', status: 'Eingestellt', cover_image: '' } })} />);
    const values = Array.from(document.querySelectorAll('select option')).map(o => o.value);
    expect(values).toContain('Abgebrochen');
    expect(values).toContain('Eingestellt');
  });

  it('a new cover URL is tried again after the old one failed', () => {
    expect(shouldShowCover('/a.jpg', '/a.jpg')).toBe(false);
    expect(shouldShowCover('/b.jpg', '/a.jpg')).toBe(true);
    const props = baseProps();
    const { rerender } = render(<MangaHeroCard {...props} />);
    fireEvent.error(screen.getByRole('img', { name: 'Titel' }));
    expect(screen.getByText('Kein Cover vorhanden')).toBeTruthy();
    rerender(<MangaHeroCard {...props} manga={{ title: 'Titel', cover_image: '/uploads/new.jpg' }} />);
    expect(screen.getByRole('img', { name: 'Titel' }).getAttribute('src')).toBe('/uploads/new.jpg');
  });

  it('previews an uploaded cover while editing, but not a half-typed URL', () => {
    const manga = { cover_image: '/uploads/old.jpg' };
    expect(heroCoverUrl({ manga, editing: true, formData: { cover_image: '/uploads/new.jpg' } })).toBe('/uploads/new.jpg');
    expect(heroCoverUrl({ manga, editing: true, formData: { cover_image: 'https://ex' } })).toBe('/uploads/old.jpg');
    expect(heroCoverUrl({ manga, editing: false, formData: { cover_image: '/uploads/new.jpg' } })).toBe('/uploads/old.jpg');
  });

  it('a cover upload is announced by one live region that stays mounted', () => {
    const props = baseProps({ editing: true });
    const { rerender } = render(<MangaHeroCard {...props} />);
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');
    rerender(<MangaHeroCard {...props} uploadingCover />);
    expect(screen.getAllByRole('status')).toEqual([region]);
    expect(region.textContent).toBe('Cover wird hochgeladen…');
    rerender(<MangaHeroCard {...props} editing={false} uploadingCover />);
    expect(screen.getAllByRole('status')).toEqual([region]);
    rerender(<MangaHeroCard {...props} editing={false} />);
    expect(region.textContent).toBe('');
  });

  it('offers "Upload abbrechen" while the cover uploads', () => {
    const onCancelCoverUpload = vi.fn();
    const { rerender } = render(<MangaHeroCard {...baseProps({ onCancelCoverUpload })} />);
    expect(screen.queryByRole('button', { name: 'Upload abbrechen' })).toBeNull();
    rerender(<MangaHeroCard {...baseProps({ onCancelCoverUpload, uploadingCover: true })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Upload abbrechen' }));
    expect(onCancelCoverUpload).toHaveBeenCalledTimes(1);
  });

  it('clears the cover file input so the same file can be picked again', () => {
    const props = baseProps();
    render(<MangaHeroCard {...props} />);
    const input = document.getElementById('cover-upload');
    const file = new File(['x'], 'c.png', { type: 'image/png' });
    let seen = null;
    props.handleCoverUpload.mockImplementation(e => { seen = e.target.files[0]; });
    fireEvent.change(input, { target: { files: [file] } });
    expect(seen).toBe(file);
    expect(input.value).toBe('');
  });
});

describe('MangaHeroCard: wishlist', () => {
  const props = (over = {}) => ({
    canEdit: true, completionPct: 0, editing: false, formData: { title: 'T', status: 'Laufend', cover_image: '' },
    handleCoverUpload: vi.fn(), handleDeleteManga: vi.fn(), handleEditLookup: vi.fn(), handleUpdate: vi.fn(e => e.preventDefault()),
    manga: { title: 'T', cover_image: null }, ownedCount: 0, saving: false, setEditLookupResults: vi.fn(), setEditing: vi.fn(),
    startEditing: vi.fn(), cancelEditing: vi.fn(), setFormData: vi.fn(), totalOwnedValue: 0, totalTarget: 0, uploadingCover: false,
    ...over
  });

  it('shows "Wunschliste · hoch" only while the series is a wished series', () => {
    const { rerender } = render(<MangaHeroCard {...props({ manga: { title: 'T', wish_priority: 3, wished: 1, owned_volumes: 0 } })} />);
    expect(document.getElementById('detail-wish-pill').textContent).toBe('Wunschliste · hoch');
    rerender(<MangaHeroCard {...props({ manga: { title: 'T', wish_priority: 3, wished: 0, owned_volumes: 1 } })} />);
    expect(document.getElementById('detail-wish-pill')).toBeNull();
    rerender(<MangaHeroCard {...props({ manga: { title: 'T', wish_priority: 0, owned_volumes: 0 } })} />);
    expect(document.getElementById('detail-wish-pill').textContent).toBe('Wunschliste');
  });

  it('the edit form toggles the wish and offers the priority only when ticked', () => {
    const p = props({ editing: true, formData: { title: 'T', status: 'Laufend', cover_image: '', wish: false, wish_priority: '2' } });
    const { rerender } = render(<MangaHeroCard {...p} />);
    expect(screen.queryByLabelText('Priorität')).toBeNull();
    fireEvent.click(screen.getByLabelText('Wunschliste'));
    expect(p.setFormData).toHaveBeenCalledWith(expect.objectContaining({ wish: true, wish_priority: '2' }));
    rerender(<MangaHeroCard {...p} formData={{ ...p.formData, wish: true }} />);
    fireEvent.change(screen.getByLabelText('Priorität'), { target: { value: '1' } });
    expect(p.setFormData).toHaveBeenLastCalledWith(expect.objectContaining({ wish: true, wish_priority: '1' }));
  });
});

describe('MangaHeroCard: authors and collecting status', () => {
  const props = (over = {}) => ({
    canEdit: true, completionPct: 0, editing: false, formData: { title: 'T', status: 'Laufend', cover_image: '' },
    handleCoverUpload: vi.fn(), handleDeleteManga: vi.fn(), handleEditLookup: vi.fn(), handleUpdate: vi.fn(e => e.preventDefault()),
    manga: { id: 7, title: 'Death Note', author: 'Tsugumi Ohba, Takeshi Obata', cover_image: null, collecting: 'aktiv' },
    ownedCount: 0, saving: false, setEditLookupResults: vi.fn(), setEditing: vi.fn(), startEditing: vi.fn(), cancelEditing: vi.fn(),
    setFormData: vi.fn(), totalOwnedValue: 0, totalTarget: 0, uploadingCover: false,
    ...over
  });

  it('each author name links to the shelf filtered by that author', () => {
    expect(authorShelfPath('Tsugumi Ohba')).toBe('/?author=Tsugumi+Ohba');
    render(<MemoryRouter><MangaHeroCard {...props()} /></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'Tsugumi Ohba' }).getAttribute('href')).toBe('/?author=Tsugumi+Ohba');
    expect(screen.getByRole('link', { name: 'Takeshi Obata' }).getAttribute('href')).toBe('/?author=Takeshi+Obata');
  });

  it('outside a router or without an author the name stays plain text', () => {
    const { rerender } = render(<MangaHeroCard {...props()} />);
    expect(screen.queryByRole('link', { name: 'Tsugumi Ohba' })).toBeNull();
    expect(screen.getByText('Tsugumi Ohba, Takeshi Obata')).toBeTruthy();
    rerender(<MemoryRouter><MangaHeroCard {...props({ manga: { id: 7, title: 'X', author: null } })} /></MemoryRouter>);
    expect(screen.getByText(/^Autor:/).textContent).toBe('Autor: Unbekannt');
    expect(screen.queryAllByRole('link').filter(a => a.getAttribute('href')?.includes('author='))).toHaveLength(0);
  });

  it('editors change the collecting status at once; a failed save goes back and says so', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);
    const onCollectingSaved = vi.fn();
    render(<><MangaHeroCard {...props({ onCollectingSaved })} /><Toaster /></>);
    const select = screen.getByLabelText('Sammelstatus');
    expect(select.value).toBe('aktiv');
    fireEvent.change(select, { target: { value: 'abgebrochen' } });
    await waitFor(() => expect(onCollectingSaved).toHaveBeenCalledWith('abgebrochen'));
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/mangas\/7$/);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ collecting: 'abgebrochen' });

    fetchMock.mockImplementation(async () => jsonResponse({ error: 'Ungültiger Sammelstatus' }, 400));
    fireEvent.change(select, { target: { value: 'pausiert' } });
    await waitFor(() => expect(screen.getByText(/Ungültiger Sammelstatus/)).toBeTruthy());
    expect(select.value).toBe('abgebrochen');
    expect(onCollectingSaved).toHaveBeenCalledTimes(1);
  });

  it('read-only users see a pill only for a paused or dropped series', () => {
    const { rerender } = render(<MangaHeroCard {...props({ canEdit: false })} />);
    expect(screen.queryByLabelText('Sammelstatus')).toBeNull();
    expect(document.getElementById('detail-collecting-pill')).toBeNull();
    rerender(<MangaHeroCard {...props({ canEdit: false, manga: { id: 7, title: 'T', collecting: 'abgebrochen' } })} />);
    expect(document.getElementById('detail-collecting-pill').textContent).toBe('Nicht mehr gesammelt');
    rerender(<MangaHeroCard {...props({ canEdit: true, isOffline: true, manga: { id: 7, title: 'T', collecting: 'pausiert' } })} />);
    expect(document.getElementById('detail-collecting-pill').textContent).toBe('Pausiert');
  });
});

describe('MangaHeroCard: tags and lookup badges', () => {
  const props = (over = {}) => ({
    canEdit: true, completionPct: 0, editing: false, formData: { title: 'T', status: 'Laufend', cover_image: '', tags: '' },
    handleCoverUpload: vi.fn(), handleDeleteManga: vi.fn(), handleEditLookup: vi.fn(), handleUpdate: vi.fn(e => e.preventDefault()),
    manga: { id: 7, title: 'Frieren', tags: 'Adventure, Fantasy, Shounen', cover_image: null }, ownedCount: 0, saving: false,
    setEditLookupResults: vi.fn(), setEditing: vi.fn(), startEditing: vi.fn(), cancelEditing: vi.fn(), setFormData: vi.fn(),
    totalOwnedValue: 0, totalTarget: 0, uploadingCover: false,
    ...over
  });

  it('shows the tags in German as links to the filtered shelf', () => {
    expect(tagShelfPath('Slice of Life')).toBe('/?tags=Slice+of+Life');
    render(<MemoryRouter><MangaHeroCard {...props()} /></MemoryRouter>);
    const list = document.getElementById('detail-tags');
    expect([...list.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Abenteuer', '/?tags=Abenteuer'], ['Fantasy', '/?tags=Fantasy'], ['Shounen', '/?tags=Shounen']
    ]);
  });

  it('the tag editor adds on Enter, comma and suggestion, removes chips and never submits the form', () => {
    const onChange = vi.fn();
    const { rerender } = render(<TagEditor id="t" value="Abenteuer" onChange={onChange} suggestions={[{ tag: 'Fantasy', count: 3 }, { tag: 'Abenteuer', count: 2 }]} />);
    const input = screen.getByLabelText('Genres / Tags');
    fireEvent.change(input, { target: { value: 'romance' } });
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith('Abenteuer, Romantik');
    fireEvent.change(input, { target: { value: 'Piraten,' } });
    expect(onChange).toHaveBeenLastCalledWith('Abenteuer, Piraten');
    expect(screen.queryByRole('button', { name: /\+ Abenteuer/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /\+ Fantasy/ }));
    expect(onChange).toHaveBeenLastCalledWith('Abenteuer, Fantasy');
    rerender(<TagEditor id="t" value="Abenteuer, Fantasy" onChange={onChange} suggestions={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tag „Abenteuer“ entfernen' }));
    expect(onChange).toHaveBeenLastCalledWith('Fantasy');
  });

  it('loads suggestions from /api/tags on first focus, not while offline', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ tags: [{ tag: 'Horror', count: 4 }] }));
    vi.stubGlobal('fetch', fetchMock);
    const p = props({ editing: true, formData: { title: 'T', status: 'Laufend', cover_image: '', tags: 'Drama' } });
    const { unmount } = render(<MangaHeroCard {...p} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.focus(screen.getByLabelText('Genres / Tags'));
    expect(await screen.findByRole('button', { name: /\+ Horror/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /\+ Horror/ }));
    expect(p.setFormData).toHaveBeenCalledWith(expect.objectContaining({ tags: 'Drama, Horror' }));
    unmount();
    fetchMock.mockClear();
    render(<MangaHeroCard {...p} isOffline />);
    fireEvent.focus(screen.getByLabelText('Genres / Tags'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('auto-fill hits show the source label of the server; AniList only for AniList hits', () => {
    expect(lookupBadgeLabels({ source: 'mal', source_label: '🌐 MyAnimeList' })).toEqual(['🌐 MyAnimeList']);
    expect(lookupBadgeLabels({ source: 'anilist' })).toEqual(['🌐 AniList']);
    expect(lookupBadgeLabels({ source: 'anilist', source_label: '🌐 AniList', also_on: ['mal', 'mal', 'x'] })).toEqual(['🌐 AniList', '🌐 MyAnimeList']);
    expect(lookupBadgeLabels({ source: 'other' })).toEqual([]);
    render(<MangaHeroCard {...props({
      editing: true,
      editLookupResults: [
        { id: 'mp_1', source: 'manga_passion', title: 'MP Treffer', status: 'Laufend' },
        { id: 'mal_2', source: 'mal', source_label: '🌐 MyAnimeList', title: 'MAL Treffer', status: 'Laufend' },
        { id: 'al_3', source: 'anilist', title: 'AL Treffer', status: 'Laufend', also_on: ['mal'] }
      ]
    })} />);
    const hit = (title) => screen.getByText(title).closest('button');
    expect(within(hit('MP Treffer')).getByText('🇩🇪 Manga Passion')).toBeTruthy();
    expect(within(hit('MAL Treffer')).getByText('🌐 MyAnimeList')).toBeTruthy();
    expect(within(hit('MAL Treffer')).queryByText('🌐 AniList')).toBeNull();
    expect(within(hit('AL Treffer')).getByText('🌐 AniList')).toBeTruthy();
    expect(within(hit('AL Treffer')).getByText('🌐 MyAnimeList')).toBeTruthy();
  });
});

describe('GapNotices', () => {
  const base = (over = {}) => ({
    duplicateEntries: [],
    canEdit: true,
    showGaps: true,
    detectedGaps: [],
    detectedGapEntries: [],
    volumeFilter: 'ALL',
    volumeSearch: '',
    gapsAllowedByFilters: true,
    mpGapData: null,
    mpGapLoading: false,
    fillingGapLoading: false,
    handleSyncTotalVolumes: vi.fn(),
    handleBatchFillGaps: vi.fn(),
    handleSelectMpEdition: vi.fn(),
    setShowMpEditionModal: vi.fn(),
    ...over
  });
  const discrepancyData = {
    matched: true, link_confirmed: true, edition: { id: 5, title: 'DE' }, total_official_volumes: 11,
    discrepancy: { official_total: 11, db_total: 22, message: 'Die deutsche Edition hat 11 Bände.' }
  };

  it('shows the discrepancy without gaps and with gaps hidden, and calls the sync without an argument', () => {
    const props = base({ mpGapData: discrepancyData, canSyncVolumeCount: true, showGaps: false });
    render(<GapNotices {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Auf 11 Bände anpassen' }));
    expect(props.handleSyncTotalVolumes).toHaveBeenCalledWith();
  });

  it('a guessed edition shows only the confirm banner', () => {
    render(<GapNotices {...base({ mpGapData: { ...discrepancyData, link_confirmed: false }, canSyncVolumeCount: false, gapEditionUnconfirmed: true })} />);
    expect(screen.getByRole('button', { name: /Edition bestätigen/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Bände anpassen/ })).toBeNull();
  });

  it('duplicate hint never names ✕ (the Fehlt toggle in the list) and is editor-only', () => {
    for (const mode of ['grid', 'list', 'spine', undefined]) expect(duplicateHint(mode)).not.toContain('✕');
    const dup = [{ label: 'Band 1', count: 2 }];
    const { rerender } = render(<GapNotices {...base({ duplicateEntries: dup, volumeViewMode: 'list' })} />);
    expect(screen.getByText(/Papierkorb/)).toBeTruthy();
    rerender(<GapNotices {...base({ duplicateEntries: dup, canEdit: false })} />);
    expect(screen.queryByText(/Doppelte Einträge/)).toBeNull();
  });

  it('gap banner follows the filters; batch fill waits for a confirmed edition; offline hides Manga Passion', () => {
    const gaps = { detectedGaps: [3], detectedGapEntries: [{ label: 3, type: 'volume' }] };
    const { rerender } = render(<GapNotices {...base({ ...gaps, gapsAllowedByFilters: false })} />);
    expect(screen.queryByText(/Lücke entdeckt/)).toBeNull();
    rerender(<GapNotices {...base({ ...gaps, gapEditionUnconfirmed: true, mpGapData: { matched: true, link_confirmed: false, edition: null } })} />);
    expect(screen.getByRole('button', { name: /Alle auf Einkaufsliste/ }).disabled).toBe(true);
    expect(screen.queryByText(/geprüft mit Manga Passion/)).toBeNull();
    rerender(<GapNotices {...base({ ...gaps, isOffline: true })} />);
    expect(screen.queryByRole('button', { name: /Manga-Passion-Edition/ })).toBeNull();
  });

  it('a dropped series shows no gap banner and no import, only a short note', () => {
    const gaps = { detectedGaps: [3, 4], detectedGapEntries: [{ label: 3, type: 'volume' }, { label: 4, type: 'volume' }] };
    const { rerender } = render(<GapNotices {...base({ ...gaps, collecting: 'abgebrochen' })} />);
    expect(screen.queryByText(/Lücken entdeckt/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Alle auf Einkaufsliste/ })).toBeNull();
    expect(document.getElementById('gap-notice-dropped').textContent).toContain('2 Lücken werden nicht angezeigt');
    rerender(<GapNotices {...base({ ...gaps, collecting: 'pausiert' })} />);
    expect(screen.getByText(/Lücken entdeckt/)).toBeTruthy();
    expect(document.getElementById('gap-notice-dropped')).toBeNull();
  });

  it('renders the gap check hint', () => {
    render(<GapNotices {...base({ mpGapNotice: 'Daten evtl. veraltet – Manga Passion nicht erreichbar' })} />);
    expect(screen.getByRole('status').textContent).toMatch(/veraltet/);
  });
});

describe('MpEditionModal', () => {
  const linked = {
    matched: true, link_confirmed: true, edition: { id: 7, title: 'Ed', publisher: 'Carlsen', total_volumes: 11, status: 'Laufend' },
    discrepancy: { official_total: 11 }, candidate_editions: [{ id: 7, title: 'Ed' }, { id: 8, title: 'Other' }]
  };
  const props = (over = {}) => ({
    isOpen: true,
    onClose: vi.fn(),
    manga: { title: 'Ed', publisher: 'Carlsen', total_volumes: 22, manga_passion_id: 7 },
    mpGapData: linked,
    mpGapLoading: false,
    fetchMpGaps: vi.fn(),
    handleSyncTotalVolumes: vi.fn(),
    handleBatchAutofillManga: vi.fn(),
    batchAutofilling: false,
    handleSelectMpEdition: vi.fn(),
    canEdit: true,
    ...over
  });

  it('visitors get a read-only view without write actions', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<MpEditionModal {...props({ canEdit: false })} />);
    expect(screen.queryByRole('button', { name: /korrigieren/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /anreichern/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Übernehmen|Bestätigen/ })).toBeNull();
    expect(screen.getByText(/Nur Leseansicht/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Daten neu laden/ })).toBeTruthy();
  });

  it('editors get the write actions for a confirmed edition', () => {
    vi.stubGlobal('fetch', vi.fn());
    const p = props({ canSyncVolumeCount: true });
    render(<MpEditionModal {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /Bandzahl auf 11 korrigieren/ }));
    expect(p.handleSyncTotalVolumes).toHaveBeenCalledWith();
    expect(screen.getByRole('button', { name: /anreichern/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Übernehmen' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Daten neu laden/ }));
    expect(p.fetchMpGaps).toHaveBeenCalledWith(7, true);
  });

  it('a guessed edition reloads through the search and offers confirm instead of autofill', () => {
    vi.stubGlobal('fetch', vi.fn());
    const p = props({ mpGapData: { ...linked, link_confirmed: false } });
    render(<MpEditionModal {...p} />);
    expect(screen.queryByRole('button', { name: /anreichern/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /korrigieren/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Daten neu laden/ }));
    expect(p.fetchMpGaps).toHaveBeenCalledWith(null, true);
    fireEvent.click(screen.getByRole('button', { name: 'Edition bestätigen' }));
    expect(p.handleSelectMpEdition).toHaveBeenCalledWith(linked.edition);
    expect(mpModalActions({ canEdit: true, mpGapData: { ...linked, link_confirmed: false } }).autofill).toBe(false);
  });

  it('offline: no search request and no actions', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<MpEditionModal {...props({ isOffline: true, mpGapData: null })} />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Offline nicht verfügbar/)).toBeTruthy();
  });

  it('a failed search shows the server error and the close button has a name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Manga Passion ist gerade nicht erreichbar.' }, 503)));
    render(<MpEditionModal {...props({ mpGapData: { ...linked, candidate_editions: [] } })} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/nicht erreichbar/);
    expect(screen.getAllByRole('button', { name: 'Schließen' }).length).toBe(2);
  });

  it('the edition search waits as long as a lookup and is 16px on phones', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
      vi.stubGlobal('fetch', fetchMock);
      render(<MpEditionModal {...props({ mpGapData: { ...linked, candidate_editions: [] } })} />);
      expect(screen.getByRole('textbox', { name: 'Titel bei Manga Passion suchen' }).className).toMatch(/(^|\s)text-base sm:text-xs(\s|$)/);
      const [url, init] = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/manga-passion/editions'));
      expect(url).toMatch(/title=Ed/);
      await act(async () => { await vi.advanceTimersByTimeAsync(TIMEOUTS.lookup - 1000); });
      expect(init.signal.aborted).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(init.signal.aborted).toBe(true);
      expect(screen.getByRole('alert').textContent).toMatch(/Zeitüberschreitung/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an empty search result says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ candidates: [] })));
    render(<MpEditionModal {...props({ mpGapData: { ...linked, candidate_editions: [] } })} />);
    expect(await screen.findByText('Keine Editionen gefunden.')).toBeTruthy();
  });
});

describe('GapFillModal', () => {
  const gapMap = buildMpGapMap([
    { volume_number: '3', type: 'volume', price: 7.5, release_date: '2020-01-02', is_released: true, cover_image: 'https://media.manga-passion.de/3.avif' },
    { volume_number: '4', type: 'volume', price: 8, release_date: '2027-02-01', is_released: false, cover_image: null }
  ]);
  const props = (over = {}) => ({
    isOpen: true, gapNumber: 3, onClose: vi.fn(), manga: { title: 'T', publisher: 'Carlsen' }, mangaId: '1',
    mpGapMap: gapMap, canEdit: true, onSuccess: vi.fn(), ...over
  });

  it('picks statuses and wording by release state', () => {
    expect(gapFillOptions(null)).toEqual(['Fehlt', 'Vorhanden']);
    expect(gapFillOptions({ is_released: true })).toEqual(['Fehlt', 'Vorhanden']);
    expect(gapFillOptions({ is_released: false })).toEqual(['Vorbestellt', 'Erscheint bald', 'Fehlt']);
    expect(formatGermanDate('2027-02-01')).toBe('01.02.2027');
    expect(formatGermanDate('2027-02')).toBe('02/2027');
    render(<GapFillModal {...props({ gapNumber: 4 })} />);
    expect(screen.getByText('Erscheint am 01.02.2027')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /im Besitz eintragen/ })).toBeNull();
    expect(screen.getByRole('button', { name: /vorbestellt eintragen/ })).toBeTruthy();
  });

  it('stores a local copy of the Manga-Passion cover', async () => {
    const fetchMock = vi.fn(async (url) => (url === '/api/upload-remote'
      ? jsonResponse({ url: '/uploads/mp-cov-x.avif' })
      : jsonResponse({ id: 1 })));
    vi.stubGlobal('fetch', fetchMock);
    const p = props();
    render(<GapFillModal {...p} />);
    expect(screen.getByText('Erschienen am 02.01.2020')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Auf Einkaufsliste setzen/ }));
    await waitFor(() => expect(p.onSuccess).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(([url]) => url === '/api/volumes');
    expect(JSON.parse(post[1].body)).toMatchObject({ volume_number: '3', status: 'Fehlt', cover_image: '/uploads/mp-cov-x.avif', price: 7.5 });
    expect(p.onClose).toHaveBeenCalled();
  });

  it('does not send data of a guessed edition', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const p = props({ gapEditionUnconfirmed: true });
    render(<GapFillModal {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /Auf Einkaufsliste setzen/ }));
    await waitFor(() => expect(p.onSuccess).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ price: null, cover_image: null, release_date: null });
  });

  it('Escape during a request is held, and a late answer does not close the next gap dialog', async () => {
    const pending = deferred();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const p = props({ mpGapMap: new Map() });
    const { rerender } = render(<GapFillModal {...p} />);
    expect(screen.getByRole('button', { name: 'Schließen' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Auf Einkaufsliste setzen/ }));

    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);

    rerender(<GapFillModal {...p} isOpen={false} gapNumber={null} />);
    rerender(<GapFillModal {...p} gapNumber={4} />);
    expect(screen.getByRole('button', { name: /Auf Einkaufsliste setzen/ }).disabled).toBe(false);

    await act(async () => { pending.resolve(jsonResponse({ id: 1 })); });
    expect(p.onClose).not.toHaveBeenCalled();
    expect(p.onSuccess).toHaveBeenCalled();
    expect(screen.getByText('Lücke erfassen: Band 4')).toBeTruthy();
  });
});

describe('AddVolumeBar', () => {
  const props = (over = {}) => ({
    canEdit: true,
    handleAddSingleVolume: vi.fn(e => e.preventDefault()),
    handleUploadNewSingleCover: vi.fn(),
    newVolumeCover: '',
    newVolumeNum: '5',
    newVolumePrice: '',
    newVolumeReleaseDate: '',
    newVolumeStatus: 'Vorhanden',
    newVolumeType: 'volume',
    setNewVolumeCover: vi.fn(),
    setNewVolumeNum: vi.fn(),
    setNewVolumePrice: vi.fn(),
    setNewVolumeReleaseDate: vi.fn(),
    setNewVolumeStatus: vi.fn(),
    setNewVolumeType: vi.fn(),
    uploadingNewCover: false,
    ...over
  });

  it('no volume is added while its photo is still uploading (Enter submits too)', () => {
    const p = props({ uploadingNewCover: true, newVolumeCover: '/uploads/a.jpg' });
    render(<AddVolumeBar {...p} />);
    expect(screen.getByRole('button', { name: /Hinzufügen/ }).disabled).toBe(true);
    fireEvent.submit(screen.getByPlaceholderText(/Band-Nr\./).closest('form'));
    expect(p.handleAddSingleVolume).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Foto entfernen' }).disabled).toBe(true);
    expect(document.querySelector('input[type="file"]').disabled).toBe(true);
  });

  it('clears the file input after picking, so the same file works again', () => {
    const p = props();
    render(<AddVolumeBar {...p} />);
    const input = document.querySelector('input[type="file"]');
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(p.handleUploadNewSingleCover).toHaveBeenCalledWith(file);
    expect(input.value).toBe('');
    fireEvent.submit(input.closest('form'));
    expect(p.handleAddSingleVolume).toHaveBeenCalled();
  });
});

describe('EditHeader and duplicates', () => {
  it('uses the shared display title (no "Band Band 3", no "Schuber Voll1-5")', () => {
    const { rerender } = render(<EditHeader activeVolume={{ volume_number: 'Band 3', type: 'volume' }} editVolForm={{ volume_number: 'Band 3', type: 'volume' }} onClose={vi.fn()} />);
    expect(screen.getByRole('heading').textContent).toBe('Band 3 bearbeiten');
    rerender(<EditHeader activeVolume={{ volume_number: 'Vollschuber 1-5', type: 'schuber' }} editVolForm={{ volume_number: 'Vollschuber 1-5', type: 'schuber' }} onClose={vi.fn()} />);
    expect(screen.getByRole('heading').textContent).toBe('Vollschuber 1-5 bearbeiten');
    rerender(<EditHeader activeVolume={{ volume_number: '4', type: 'volume' }} editVolForm={{ volume_number: '', type: 'volume' }} onClose={vi.fn()} />);
    expect(screen.getByRole('heading').textContent).toBe('Band 4 bearbeiten');
  });

  it('"Band 5" and "5" are one volume; "Starter 1" and a special edition 1 are not regular volume 1', () => {
    expect(findDuplicateEntries([
      { volume_number: 'Band 5', type: 'volume' }, { volume_number: '5', type: 'volume' }
    ])).toEqual([{ label: 'Band 5', count: 2 }]);
    expect(findDuplicateEntries([
      { volume_number: 'Starter 1', type: 'volume' }, { volume_number: '1', type: 'volume' },
      { volume_number: '1', type: 'special_edition', notes: 'Collectors Edition' }
    ])).toEqual([]);
  });
});
