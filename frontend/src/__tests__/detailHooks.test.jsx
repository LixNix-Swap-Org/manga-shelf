// Detail page hooks: keyboard, volume actions, filters, gallery, manga data, shelf layout, edit form.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { renderHook, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/offlineStore', () => ({
  loadMangaDetail: vi.fn(async () => null),
  updateCachedManga: vi.fn(async () => {}),
  syncOfflineCopy: vi.fn(async () => true),
  patchCachedManga: vi.fn(async () => false),
  loadOutboxEntries: vi.fn(async () => { throw new Error('no IndexedDB'); }),
  putOutboxEntries: vi.fn(async () => {}),
  deleteOutboxEntries: vi.fn(async () => {})
}));

import * as offlineStore from '../utils/offlineStore';
import { clearDataCache, writeCache, readCache, LIST_KEY, detailKey } from '../utils/dataCache';
import useDetailKeyboard, { resolveVolumeShortcut } from '../hooks/useDetailKeyboard';
import useVolumeActions, {
  readApiError, localDateString, volumeDeleteConfirmText, READ_OTHERS_ADMIN_ONLY, UNAUTHORIZED_TEXT, QUEUED_TEXT, UPLOAD_CANCELLED,
  ownedToggleChange
} from '../hooks/useVolumeActions';
import useMangaData, { mergeEditLookup, normalizeLookupStatus, isFormDirty, buildFormData, changedFormFields } from '../hooks/useMangaData';
import useVolumeGallery from '../hooks/useVolumeGallery';
import useShelfLayout from '../hooks/useShelfLayout';
import useVolumeEditForm from '../hooks/useVolumeEditForm';
import useVolumeFilters from '../hooks/useVolumeFilters';
import { fakeResponse } from './fakeResponse';
import { resetOutbox, getOutbox, outboxScope } from '../utils/outbox';
import { recordToasts } from './toastLog';

let toasts;
beforeEach(() => {
  toasts = recordToasts();
  clearDataCache();
  localStorage.clear();
  resetOutbox();
});
afterEach(() => { toasts.stop(); });

const res = (status, body, { raw } = {}) => fakeResponse(status, body, { raw });

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const bodyOf = (call) => JSON.parse(call[1].body);

// ---------------------------------------------------------------- useDetailKeyboard

const VOLS = [
  { id: 1, volume_number: '1', status: 'Vorhanden' },
  { id: 2, volume_number: '2', status: 'Fehlt' },
  { id: 3, volume_number: '3', status: 'Vorhanden' }
];

function useKeyboardHarness(props) {
  const [focusedVolumeId, setFocusedVolumeId] = useState(props.initialFocus ?? null);
  useDetailKeyboard({
    lightboxData: null, setLightboxData: vi.fn(), activeVolume: null, setActiveVolume: vi.fn(),
    showBatchModal: false, setShowBatchModal: vi.fn(), showBatchReadModal: false, setShowBatchReadModal: vi.fn(),
    fillingGapNumber: null, setFillingGapNumber: vi.fn(), showMpEditionModal: false, setShowMpEditionModal: vi.fn(),
    editing: false, setEditing: vi.fn(), filteredVolumes: VOLS, canEdit: true,
    handleToggleVolumeRead: vi.fn(), handleOpenEditVolume: vi.fn(),
    ...props,
    focusedVolumeId, setFocusedVolumeId
  });
  return focusedVolumeId;
}

const renderKeyboard = (props) => renderHook((p) => useKeyboardHarness(p), { initialProps: props });

const key = (target, k, init = {}) => fireEvent.keyDown(target, { key: k, bubbles: true, cancelable: true, ...init });

function addSpine(id, extra = {}) {
  const el = document.createElement('div');
  el.className = 'manga-spine';
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.setAttribute('data-volume-id', String(id));
  el.scrollIntoView = extra.scrollIntoView || vi.fn();
  document.body.appendChild(el);
  return el;
}

describe('useDetailKeyboard: shelf shortcuts', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('does nothing outside the shelf view: j then Space in grid view toggles no read status', () => {
    const toggle = vi.fn();
    const { result } = renderKeyboard({ volumeViewMode: 'grid', handleToggleVolumeRead: toggle });
    expect(key(document.body, 'j')).toBe(true);
    expect(result.current).toBe(null);
    expect(key(document.body, ' ')).toBe(true); // page scroll stays
    expect(toggle).not.toHaveBeenCalled();
  });

  it('J / K move the focus in shelf view; Space toggles an owned volume, never a missing one', () => {
    const toggle = vi.fn();
    const { result } = renderKeyboard({ volumeViewMode: 'spine', handleToggleVolumeRead: toggle });
    key(document.body, 'j');
    expect(result.current).toBe(1);
    expect(key(document.body, ' ')).toBe(false);
    expect(toggle).toHaveBeenCalledWith(VOLS[0]);

    key(document.body, 'j');
    expect(result.current).toBe(2);
    key(document.body, ' ');
    expect(toggle).toHaveBeenCalledTimes(1);

    key(document.body, 'k');
    key(document.body, 'k');
    expect(result.current).toBe(3);
  });

  it('ignores modifier keys and auto-repeat (Ctrl+K stays a browser shortcut)', () => {
    const toggle = vi.fn();
    const { result } = renderKeyboard({ volumeViewMode: 'spine', initialFocus: 1, handleToggleVolumeRead: toggle });
    expect(key(document.body, 'k', { ctrlKey: true })).toBe(true);
    expect(key(document.body, 'j', { metaKey: true })).toBe(true);
    expect(result.current).toBe(1);
    key(document.body, ' ', { repeat: true });
    key(document.body, ' ', { altKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });

  it('switching the view mode clears the focused volume', () => {
    const { result, rerender } = renderKeyboard({ volumeViewMode: 'spine' });
    key(document.body, 'j');
    expect(result.current).toBe(1);
    rerender({ volumeViewMode: 'list' });
    expect(result.current).toBe(null);
  });

  it('clears the focus when a filter removes the focused volume', () => {
    const { result, rerender } = renderKeyboard({ volumeViewMode: 'spine', initialFocus: 3 });
    expect(result.current).toBe(3);
    rerender({ volumeViewMode: 'spine', filteredVolumes: VOLS.slice(0, 2) });
    expect(result.current).toBe(null);
  });

  it('Space on a focused spine toggles that volume once; Space on a real button does nothing', () => {
    const toggle = vi.fn();
    const spine = addSpine(3);
    renderKeyboard({ volumeViewMode: 'spine', initialFocus: 1, handleToggleVolumeRead: toggle });
    spine.focus();
    expect(key(spine, ' ')).toBe(false);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveBeenCalledWith(VOLS[2]);

    const button = document.createElement('button');
    document.body.appendChild(button);
    expect(key(button, ' ')).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('a Space the spine already handled (defaultPrevented) is not toggled a second time', () => {
    const toggle = vi.fn();
    const spine = addSpine(1);
    spine.addEventListener('keydown', (e) => e.preventDefault());
    renderKeyboard({ volumeViewMode: 'spine', initialFocus: 1, handleToggleVolumeRead: toggle });
    key(spine, ' ');
    expect(toggle).not.toHaveBeenCalled();
  });

  it('J moves DOM focus to the next spine and scrolls it into view', () => {
    addSpine(1);
    const second = addSpine(2);
    renderKeyboard({ volumeViewMode: 'spine', initialFocus: 1 });
    key(document.body, 'j');
    expect(document.activeElement).toBe(second);
    expect(second.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  });

  it('E opens the editor only for editors; visitors get nothing', () => {
    const open = vi.fn();
    const { rerender } = renderKeyboard({ volumeViewMode: 'spine', initialFocus: 2, handleOpenEditVolume: open, canEdit: false });
    key(document.body, 'e');
    expect(open).not.toHaveBeenCalled();
    rerender({ volumeViewMode: 'spine', handleOpenEditVolume: open, canEdit: true });
    key(document.body, 'e');
    expect(open).toHaveBeenCalledWith(VOLS[1]);
  });

  it('canToggle gates Space, canEdit gates E: an editor in offline mode toggles by keyboard but does not edit', () => {
    const toggle = vi.fn();
    const open = vi.fn();
    const { rerender } = renderKeyboard({ volumeViewMode: 'spine', initialFocus: 1, handleToggleVolumeRead: toggle, handleOpenEditVolume: open, canEdit: false, canToggle: true });
    key(document.body, ' ');
    key(document.body, 'e');
    expect(toggle).toHaveBeenCalledWith(VOLS[0]);
    expect(open).not.toHaveBeenCalled();
    rerender({ volumeViewMode: 'spine', handleToggleVolumeRead: toggle, handleOpenEditVolume: open, canEdit: false, canToggle: false });
    key(document.body, ' ');
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('resolveVolumeShortcut: typing in a field is never a shortcut', () => {
    const input = document.createElement('input');
    expect(resolveVolumeShortcut({ key: 'j', target: input }, { shelfActive: true, modalOpen: false })).toBe(null);
    expect(resolveVolumeShortcut({ key: 'j', target: document.body }, { shelfActive: true, modalOpen: true })).toBe(null);
    expect(resolveVolumeShortcut({ key: 'J', target: document.body }, { shelfActive: true, modalOpen: false })).toBe('next');
  });
});

describe('useDetailKeyboard: Escape', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('closes the lightbox before the volume editor', () => {
    const setLightboxData = vi.fn();
    const setActiveVolume = vi.fn();
    renderKeyboard({ lightboxData: { images: [] }, setLightboxData, activeVolume: VOLS[0], setActiveVolume });
    key(document.body, 'Escape');
    expect(setLightboxData).toHaveBeenCalledWith(null);
    expect(setActiveVolume).not.toHaveBeenCalled();
  });

  it('keeps the volume editor open when Escape comes from a text field, during IME input or was handled by the dialog', () => {
    const setActiveVolume = vi.fn();
    renderKeyboard({ activeVolume: VOLS[0], setActiveVolume });
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    key(textarea, 'Escape');
    key(document.body, 'Escape', { isComposing: true });
    const dialog = document.createElement('div');
    dialog.addEventListener('keydown', (e) => e.preventDefault());
    document.body.appendChild(dialog);
    key(dialog, 'Escape');
    expect(setActiveVolume).not.toHaveBeenCalled();

    key(document.body, 'Escape');
    expect(setActiveVolume).toHaveBeenCalledWith(null);
  });

  it('asks before discarding a dirty series edit form and cancels through cancelEditing', () => {
    const cancelEditing = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderKeyboard({ editing: true, isEditDirty: true, cancelEditing });
    key(document.body, 'Escape');
    expect(cancelEditing).not.toHaveBeenCalled();
    key(document.body, 'Escape');
    expect(cancelEditing).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledTimes(2);
  });

  it('Escape typed in a field of the series form keeps the form and its input', () => {
    const cancelEditing = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderKeyboard({ editing: true, isEditDirty: true, cancelEditing });
    const input = document.createElement('input');
    document.body.appendChild(input);
    key(input, 'Escape');
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    key(textarea, 'Escape');
    expect(cancelEditing).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    document.body.appendChild(checkbox);
    confirmSpy.mockReturnValueOnce(true);
    key(checkbox, 'Escape');
    expect(cancelEditing).toHaveBeenCalledTimes(1);
  });

  it('without a dirty flag, cancelEditing is only called after asking', () => {
    const cancelEditing = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    renderKeyboard({ editing: true, cancelEditing });
    key(document.body, 'Escape');
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(cancelEditing).not.toHaveBeenCalled();
  });

  it('a clean edit form closes without asking (setEditing fallback)', () => {
    const setEditing = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderKeyboard({ editing: true, isEditDirty: false, setEditing });
    key(document.body, 'Escape');
    expect(setEditing).toHaveBeenCalledWith(false);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- useVolumeActions

const editor = { id: 2, role: 'editor' };
const admin = { id: 1, role: 'admin' };

function renderActions(props = {}) {
  const fetchManga = props.fetchManga || vi.fn(async () => {});
  const hook = renderHook(() => useVolumeActions({ id: '7', user: editor, canEdit: true, selectedReaderId: 2, fetchManga, ...props }));
  return { ...hook, fetchManga };
}

describe('useVolumeActions', () => {
  beforeEach(() => {
  });

  it('readApiError: JSON error, HTML proxy page, empty body, missing field', async () => {
    expect(await readApiError(res(409, { error: 'Band 5 gibt es schon' }), 'Fehler')).toBe('Band 5 gibt es schon');
    expect(await readApiError(res(502, null, { raw: '<html>Bad Gateway</html>' }), 'Fehler')).toBe('Fehler (HTTP 502)');
    expect(await readApiError(res(500, null, { raw: '' }), 'Fehler')).toBe('Fehler (HTTP 500)');
    expect(await readApiError(res(400, { message: 'x' }), 'Fehler')).toBe('Fehler (HTTP 400)');
  });

  it('localDateString uses the local calendar day', () => {
    expect(localDateString(new Date(2026, 0, 2, 0, 30))).toBe('2026-01-02');
  });

  it('owner toggle sends the intended state and a double click sends only one request', async () => {
    const gate = deferred();
    const fetchMock = vi.fn(() => gate.promise);
    vi.stubGlobal('fetch', fetchMock);
    const { result, fetchManga } = renderActions();
    const vol = { id: 5, status: 'Vorhanden', owners: [{ user_id: 1 }], owned_by_me: false };
    let first;
    let second;
    act(() => {
      first = result.current.handleToggleVolume(vol);
      second = result.current.handleToggleVolume(vol);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await second;
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ owned: true });
    gate.resolve(res(200, {}));
    await act(() => first);
    expect(fetchManga).toHaveBeenCalledTimes(1);
  });

  it('status toggle: owning is the user\'s own ownership, un-owning an ownerless row PUTs only the status', async () => {
    const fetchMock = vi.fn(async () => res(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderActions();
    await act(() => result.current.handleToggleVolume({ id: 9, status: 'Fehlt', price: 7, notes: 'alt', owners: [] }));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/volumes/9/owners');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ owned: true, purchase_date: localDateString() });
    await act(() => result.current.handleToggleVolume({ id: 9, status: 'Vorhanden', purchase_date: '2024-01-01', owners: [] }));
    expect(fetchMock.mock.calls[1][0]).toBe('/api/volumes/9');
    expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
    expect(bodyOf(fetchMock.mock.calls[1])).toEqual({ status: 'Fehlt' });
    // a hand-entered date on an ownerless volume is not this purchase's date
    await act(() => result.current.handleToggleVolume({ id: 9, status: 'Vorbestellt', purchase_date: '2024-01-01' }));
    expect(fetchMock.mock.calls[2][0]).toBe('/api/volumes/9/owners');
    expect(bodyOf(fetchMock.mock.calls[2])).toEqual({ owned: true, purchase_date: localDateString() });
    await act(() => result.current.handleToggleVolume({ id: 9, status: 'Bestellt', purchase_date: '2024-01-01', owners: [{ user_id: 3 }] }));
    expect(bodyOf(fetchMock.mock.calls[3])).toEqual({ owned: true });
  });

  it('adding a volume waits for a running cover upload', async () => {
    const upload = deferred();
    const fetchMock = vi.fn((url) => (url === '/api/upload' ? upload.promise : Promise.resolve(res(200, {}))));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderActions();
    act(() => result.current.setNewVolumeNum('5'));
    let uploading;
    act(() => { uploading = result.current.handleUploadNewSingleCover(new Blob(['x'])); });
    await act(() => result.current.handleAddSingleVolume({ preventDefault() {} }));
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/volumes')).toHaveLength(0);
    await act(async () => { upload.resolve(res(200, { url: '/uploads/c.jpg' })); await uploading; });
    expect(result.current.uploadingNewCover).toBe(false);
    await act(() => result.current.handleAddSingleVolume({ preventDefault() {} }));
    const add = fetchMock.mock.calls.find(([url]) => url === '/api/volumes');
    expect(bodyOf(add).cover_image).toBe('/uploads/c.jpg');
  });

  it('a cover upload that finishes after the cover was removed is dropped', async () => {
    const upload = deferred();
    vi.stubGlobal('fetch', vi.fn(() => upload.promise));
    const { result } = renderActions();
    let uploading;
    act(() => { uploading = result.current.handleUploadNewSingleCover(new Blob(['x'])); });
    act(() => result.current.setNewVolumeCover(''));
    await act(async () => { upload.resolve(res(200, { url: '/uploads/late.jpg' })); await uploading; });
    expect(result.current.newVolumeCover).toBe('');
    expect(result.current.uploadingNewCover).toBe(false);
  });

  it('a second upload cancels the first; only the newer one sets the cover', async () => {
    const first = deferred();
    const second = deferred();
    const signals = [];
    const fetchMock = vi.fn((url, init) => {
      signals.push(init.signal);
      return (signals.length === 1 ? first : second).promise;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderActions();
    let a;
    let b;
    act(() => { a = result.current.handleUploadNewSingleCover(new Blob(['1'])); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => { b = result.current.handleUploadNewSingleCover(new Blob(['2'])); });
    expect(signals[0].aborted).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => { second.resolve(res(200, { url: '/uploads/new.jpg' })); await b; });
    await act(async () => { first.resolve(res(200, { url: '/uploads/old.jpg' })); await a; });
    expect(result.current.newVolumeCover).toBe('/uploads/new.jpg');
    expect(result.current.uploadingNewCover).toBe(false);
    expect(toasts.messages()).toEqual([]);
  });

  it('a running cover upload can be cancelled: the form is usable again at once', async () => {
    const fetchMock = vi.fn((url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderActions();
    let uploading;
    act(() => { uploading = result.current.handleUploadNewSingleCover(new Blob(['x'])); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(result.current.uploadingNewCover).toBe(true);
    expect(result.current.handleUploadNewSingleCover.cancel).toBeTypeOf('function');
    await act(async () => { result.current.cancelNewCoverUpload(); await uploading; });
    expect(result.current.uploadingNewCover).toBe(false);
    expect(result.current.newVolumeCover).toBe('');
    expect(toasts.messages('info')).toEqual([UPLOAD_CANCELLED]);
    expect(toasts.messages('error')).toEqual([]);
  });

  it('shows the server error on a failed toggle and refetches when the volume is gone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(404, { error: 'Band nicht gefunden' })));
    const { result, fetchManga } = renderActions();
    await act(() => result.current.handleToggleVolume({ id: 9, status: 'Fehlt' }));
    expect(toasts.messages('error')).toContainEqual('Band nicht gefunden');
    expect(fetchManga).toHaveBeenCalledTimes(1);
  });

  it('hands an announced session end (401 with the app code) to onUnauthorized instead of alerting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(401, { error: 'Sitzung ungültig', code: 'SESSION_INVALID' })));
    const onUnauthorized = vi.fn();
    const { result } = renderActions({ onUnauthorized });
    await act(() => result.current.handleToggleVolume({ id: 9, status: 'Fehlt' }));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(toasts.messages('error')).toEqual([]);
  });

  it('a 401 without the app code (auth proxy) shows a German message and keeps the session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(401, { error: 'proxy' })));
    const onUnauthorized = vi.fn();
    const { result } = renderActions({ onUnauthorized });
    await act(() => result.current.handleToggleVolumeRead({ id: 4, read_users: [] }));
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(toasts.messages('error')).toEqual([UNAUTHORIZED_TEXT]);
    await act(() => result.current.handleAddSingleVolume({ preventDefault() {} }));
  });

  it('a non-admin never changes another reader (no request, explains why)', async () => {
    const fetchMock = vi.fn(async () => res(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const vol = { id: 4, status: 'Vorhanden', read_users: [{ user_id: 1 }] };
    const { result } = renderActions({ selectedReaderId: 1 });
    expect(result.current.canToggleOthers).toBe(false);
    await act(async () => { await result.current.handleToggleVolumeRead(vol); });
    await act(async () => { await result.current.handleToggleVolumeRead(vol, 1); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toasts.messages('error')).toContainEqual(READ_OTHERS_ADMIN_ONLY);

    await act(() => result.current.handleToggleVolumeRead(vol, '2'));
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ user_id: '2', read: true });
  });

  it('an admin may toggle another reader, based on that reader\'s state', async () => {
    const fetchMock = vi.fn(async () => res(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderActions({ user: admin, selectedReaderId: 2 });
    await act(() => result.current.handleToggleVolumeRead({ id: 4, read_users: [{ user_id: 2 }] }));
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ user_id: 2, read: false });
  });

  it('a read toggle the proxy answers with 502 stays in the outbox for a later replay', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(502, null, { raw: '<html>502</html>' })));
    const { result } = renderActions();
    await act(() => result.current.handleToggleVolumeRead({ id: 4, read_users: [] }));
    expect(toasts.messages('error')).toEqual([]);
    expect(toasts.messages('info')).toEqual([QUEUED_TEXT]);
    expect(getOutbox().list(outboxScope(editor.id))).toMatchObject([{ kind: 'read', volumeId: 4, value: true, attempts: 1 }]);
  });

  it('a refused toggle (4xx) shows the server text, leaves the outbox and reloads the series', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(400, { error: 'Ungültiger Status' })));
    const { result, fetchManga } = renderActions();
    await act(() => result.current.handleToggleVolume({ id: 9, status: 'Vorhanden', owners: [] }));
    expect(toasts.messages('error')).toEqual(['Ungültiger Status']);
    expect(fetchManga).toHaveBeenCalledTimes(1);
    expect(getOutbox().list(outboxScope(editor.id))).toEqual([]);
  });

  it('offline: the toggle is applied to the page at once, queued without a request and reloaded from the offline copy', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    let detail = { id: '7', volumes: [{ id: 4, status: 'Vorhanden', price: 7, owners: [{ user_id: 2 }], read_users: [], read_by: [] }], reader_stats: [{ user_id: 2, username: 'ed' }] };
    const patchManga = vi.fn((fn) => { detail = fn(detail); });
    const { result, fetchManga } = renderActions({ user: { ...editor, offline: true, username: 'ed' }, patchManga });
    await act(() => result.current.handleToggleVolumeRead({ id: 4, read_users: [] }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(detail.volumes[0].read_by).toEqual([2]);
    expect(detail.reader_stats[0]).toMatchObject({ read_count: 1, total_owned: 1, percentage: 100 });
    expect(fetchManga).toHaveBeenCalledTimes(1);
    expect(toasts.messages('info')).toEqual([QUEUED_TEXT]);
    expect(getOutbox().list(outboxScope(editor.id))).toMatchObject([{ kind: 'read', volumeId: 4, targetUserId: 2, value: true, deferred: true }]);
  });

  it('offline: the page reloads from the offline copy only after the toggle was written into it', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const written = deferred();
    offlineStore.patchCachedManga.mockImplementationOnce(() => written.promise);
    const { result, fetchManga } = renderActions({ user: { ...editor, offline: true, username: 'ed' } });
    let pending;
    act(() => { pending = result.current.handleToggleVolume({ id: 4, status: 'Fehlt', owners: [] }); });
    await waitFor(() => expect(getOutbox().list(outboxScope(editor.id))).toHaveLength(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(fetchManga).not.toHaveBeenCalled();
    written.resolve(true);
    await act(() => pending);
    expect(fetchManga).toHaveBeenCalledTimes(1);
  });

  it('canToggle (offline editor) allows only the toggles; adding, editing and deleting stay with canEdit', async () => {
    const fetchMock = vi.fn(async () => res(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { result } = renderActions({ canEdit: false, canToggle: true });
    await act(() => result.current.handleToggleVolume({ id: 5, status: 'Fehlt', owners: [] }));
    await act(() => result.current.handleToggleVolumeRead({ id: 6, status: 'Vorhanden', read_users: [] }));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/volumes/5/owners', '/api/volumes/6/read']);
    act(() => { result.current.setNewVolumeNum('3'); });
    await act(() => result.current.handleAddSingleVolume({ preventDefault() {} }));
    act(() => { result.current.handleOpenEditVolume({ id: 6 }); });
    await act(() => result.current.handleDeleteVolume(null, { id: 6 }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.activeVolume).toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();

    const visitor = renderActions({ canEdit: false, canToggle: false });
    expect(visitor.result.current.handleToggleVolume({ id: 5, status: 'Fehlt', owners: [] })).toBeUndefined();
    expect(visitor.result.current.handleToggleVolumeRead({ id: 6, status: 'Vorhanden', read_users: [] })).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('un-owning offers "Rückgängig", which restores the owner row with its date, price and the volume date', async () => {
    const fetchMock = vi.fn(async () => res(200, {
      status: 'Fehlt', owners: [], owned_by_me: false, previous_purchase_date: '2024-03-01',
      removed_owner: { user_id: 2, price: 6.5, purchase_date: '2024-03-01', condition: null }
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { result, fetchManga } = renderActions();
    const vol = { id: 5, volume_number: '5', type: 'volume', status: 'Vorhanden', owners: [{ user_id: 2 }], owned_by_me: true };
    await act(() => result.current.handleToggleVolume(vol));
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ owned: false });
    const toast = toasts.last();
    expect(toast).toMatchObject({ kind: 'success', action: { label: 'Rückgängig' } });
    fetchMock.mockImplementation(async () => res(200, { status: 'Vorhanden' }));
    await act(async () => { await toast.action.onClick(); });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/volumes/5/owners');
    expect(bodyOf(fetchMock.mock.calls[1])).toEqual({ owned: true, purchase_date: '2024-03-01', price: 6.5, previous_purchase_date: '2024-03-01' });
    expect(fetchManga).toHaveBeenCalledTimes(2);
  });

  it('ownedToggleChange: own ownership with owners, a purchase for missing volumes, a status write for ownerless ones', () => {
    expect(ownedToggleChange({ status: 'Vorhanden', owners: [{ user_id: 2 }] }, editor)).toEqual({ kind: 'owned', value: false });
    expect(ownedToggleChange({ status: 'Vorhanden', owners: [{ user_id: 1 }], owned_by_me: false }, editor)).toEqual({ kind: 'owned', value: true });
    expect(ownedToggleChange({ status: 'Fehlt' }, editor, '2026-10-03')).toEqual({ kind: 'owned', value: true, purchase_date: '2026-10-03' });
    expect(ownedToggleChange({ status: 'Vorhanden', owners: [] }, editor)).toEqual({ kind: 'status', value: 'Fehlt' });
  });

  it('delete names the volume in the dialog and alerts the server error', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn(async () => res(403, { error: 'Keine Berechtigung' })));
    const vol = { id: 12, volume_number: '12', type: 'volume', status: 'Vorhanden' };
    const { result } = renderActions({ volumes: [vol] });
    await act(() => result.current.handleDeleteVolume(null, 12));
    expect(confirmSpy.mock.calls[0][0]).toBe(volumeDeleteConfirmText(vol));
    expect(confirmSpy.mock.calls[0][0]).toMatch(/12/);
    expect(toasts.messages('error')).toContainEqual('Keine Berechtigung');
  });

  it('delete of a volume that is already gone (404) just refreshes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn(async () => res(404, { error: 'Band nicht gefunden' })));
    const { result, fetchManga } = renderActions();
    await act(() => result.current.handleDeleteVolume(null, 3));
    expect(toasts.messages('error')).toEqual([]);
    expect(fetchManga).toHaveBeenCalledTimes(1);
  });

  it('delete with a volume object closes its open editor and refetches', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal('fetch', vi.fn(async () => res(200, {})));
    const vol = { id: 3, volume_number: '3' };
    const { result, fetchManga } = renderActions();
    act(() => result.current.setActiveVolume(vol));
    await act(() => result.current.handleDeleteVolume(null, vol));
    expect(result.current.activeVolume).toBe(null);
    expect(fetchManga).toHaveBeenCalledTimes(1);
  });

  it('delete puts the volume into the trash; the toast restores it from there', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.fn(async () => res(200, { success: true, trash_id: 77 }));
    vi.stubGlobal('fetch', fetchMock);
    const vol = { id: 3, volume_number: '3', type: 'volume' };
    const { result, fetchManga } = renderActions({ volumes: [vol] });
    await act(() => result.current.handleDeleteVolume(null, 3));
    const toast = toasts.last();
    expect(toast).toMatchObject({ kind: 'success', message: '„Band 3“ in den Papierkorb gelegt', action: { label: 'Rückgängig' } });
    fetchMock.mockImplementation(async () => res(200, { success: true, kind: 'volume', id: 3 }));
    await act(async () => { await toast.action.onClick(); });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/trash/77/restore');
    expect(fetchMock.mock.calls[1][1].method).toBe('POST');
    expect(fetchManga).toHaveBeenCalledTimes(2);

    fetchMock.mockImplementation(async () => res(409, { error: 'Band 3 existiert bereits (Fehlt).', code: 'VOLUME_DUPLICATE' }));
    await act(async () => { await toast.action.onClick(); });
    expect(toasts.messages('error')).toEqual(['Band 3 existiert bereits (Fehlt).']);
  });

  it('a new single volume is posted without the dead publisher field', async () => {
    const fetchMock = vi.fn(async () => res(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderActions();
    act(() => result.current.setNewVolumeNum('4'));
    await act(() => result.current.handleAddSingleVolume({ preventDefault() {} }));
    expect(bodyOf(fetchMock.mock.calls[0])).not.toHaveProperty('publisher');
    expect(result.current).not.toHaveProperty('newVolumePublisher');
  });

  it('upload of a new volume cover passes the server text through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(413, { error: 'Bild ist größer als 15 MB' })));
    const { result } = renderActions();
    await act(() => result.current.handleUploadNewSingleCover(new Blob(['x'])));
    expect(toasts.messages('error')).toContainEqual('Bild ist größer als 15 MB');
  });
});

describe('useVolumeFilters: owner and read filters', () => {
  const ownedBy = (...userIds) => userIds.map(user_id => ({ user_id }));
  const list = [
    ...Array.from({ length: 12 }, (_, i) => ({ id: i + 1, volume_number: String(i + 1), status: 'Vorhanden', owners: ownedBy(1) })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: 13 + i, volume_number: String(13 + i), status: 'Fehlt', owners: [] })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: 18 + i, volume_number: String(18 + i), status: 'Vorbestellt', owners: [] }))
  ];

  it('"missing for a person" lists total minus owned, without preorders', () => {
    const { result } = renderHook(() => useVolumeFilters({ volumes: list, manga: {}, user: { id: 1 }, selectedReaderId: 1 }));
    act(() => {
      result.current.setVolumeOwnerFilter(1);
      result.current.setVolumeOwnerMissing(true);
    });
    expect(result.current.filteredVolumes).toHaveLength(5);
    act(() => result.current.setVolumeOwnerMissing(false));
    expect(result.current.filteredVolumes).toHaveLength(12);
  });

  it('"Gelesen" counts owned volumes only, like the chip count', () => {
    const vols = [
      { id: 1, volume_number: '1', status: 'Vorhanden', read_users: [{ user_id: 1 }] },
      { id: 2, volume_number: '2', status: 'Fehlt', read_users: [{ user_id: 1 }] },
      { id: 3, volume_number: '3', status: 'Vorhanden', read_users: [] }
    ];
    const { result } = renderHook(() => useVolumeFilters({ volumes: vols, manga: {}, user: { id: 1 }, selectedReaderId: 1 }));
    act(() => result.current.setVolumeFilter('Gelesen'));
    expect(result.current.filteredVolumes.map(v => v.id)).toEqual([1]);
    act(() => result.current.setVolumeFilter('Ungelesen'));
    expect(result.current.filteredVolumes.map(v => v.id)).toEqual([3]);
  });

  it('a blocked localStorage does not break the view mode', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    const { result } = renderHook(() => useVolumeFilters({ volumes: [], manga: {}, user: { id: 1 }, selectedReaderId: 1 }));
    expect(result.current.volumeViewMode).toBe('grid');
    act(() => result.current.handleSetVolumeViewMode('list'));
    expect(result.current.volumeViewMode).toBe('list');
    get.mockRestore();
    set.mockRestore();
  });
});

describe('useVolumeGallery: subtitle', () => {
  it('formats the price as German euros', () => {
    const { result } = renderHook(() => useVolumeGallery({ manga: { title: 'Berserk' } }));
    act(() => result.current.openVolumeGallery({ id: 1, volume_number: '1', cover_image: '/a.jpg', publisher: 'Panini', price: 7.5 }));
    expect(result.current.lightboxData.subtitle).toBe('Berserk • Panini • 7,50\u00a0€');
  });
});

describe('useVolumeGallery', () => {
  it('no longer carries a second set-cover implementation', () => {
    const { result } = renderHook(() => useVolumeGallery({ manga: { title: 'X', volumes: [] } }));
    expect(result.current).not.toHaveProperty('handleSetCoverFromLightbox');
    act(() => result.current.openVolumeGallery({ id: 1, volume_number: '1', cover_image: '/a.jpg', images: ['/a.jpg', '/b.jpg'] }, '/b.jpg'));
    expect(result.current.lightboxData).toMatchObject({ volumeId: 1, images: ['/a.jpg', '/b.jpg'], currentIndex: 1 });
  });
});

// ---------------------------------------------------------------- useMangaData

const SERVER = { id: 7, title: 'Berserk', status: 'Laufend', total_volumes: 41, description: 'alt', cover_image: '/uploads/a.jpg', manga_passion_id: null, volumes: [] };
const wrapper = ({ children }) => <MemoryRouter>{children}</MemoryRouter>;
const renderData = (props = {}) => renderHook((p) => useMangaData(p), {
  wrapper,
  initialProps: { id: '7', user: editor, canEdit: true, ...props }
});

describe('useMangaData: pure helpers', () => {
  it('changedFormFields keeps only values that differ from the opened form', () => {
    const base = buildFormData({ title: 'A', total_volumes: 20, description: '' });
    expect(changedFormFields(base, { ...base })).toEqual({});
    expect(changedFormFields(base, { ...base, total_volumes: '20', description: 'neu' })).toEqual({ description: 'neu' });
    expect(changedFormFields(base, { ...base, title: '' })).toEqual({ title: '' });
  });

  it('mergeEditLookup ignores the placeholder publisher "Unbekannt"', () => {
    const prev = buildFormData({ title: 'A', publisher: 'Carlsen Manga' });
    expect(mergeEditLookup(prev, { publisher: 'Unbekannt' }).publisher).toBe('Carlsen Manga');
    expect(mergeEditLookup(prev, { publisher: 'Panini' }).publisher).toBe('Panini');
  });

  it('normalizeLookupStatus keeps the previous value for unknown statuses', () => {
    expect(normalizeLookupStatus('Unbekannt', 'Pausiert')).toBe('Pausiert');
    expect(normalizeLookupStatus(undefined, 'Laufend')).toBe('Laufend');
    expect(normalizeLookupStatus('Abgebrochen', 'Laufend')).toBe('Abgebrochen');
    for (const s of ['Laufend', 'Abgeschlossen', 'Pausiert', 'Geplant']) expect(normalizeLookupStatus(s, 'x')).toBe(s);
  });

  it('mergeEditLookup keeps the total of a running series and takes it for a finished one', () => {
    const prev = buildFormData({ title: 'A', total_volumes: 20, status: 'Laufend' });
    expect(mergeEditLookup({ ...prev, total_volumes: '' }, { status: 'Laufend', total_volumes: 3 }).total_volumes).toBe('');
    expect(mergeEditLookup(prev, { status: 'Laufend', total_volumes: 3 }).total_volumes).toBe(20);
    expect(mergeEditLookup(prev, { status: 'Abgeschlossen', total_volumes: 12 }).total_volumes).toBe('12');
    expect(mergeEditLookup(prev, { title: 'B' }).total_volumes).toBe(20);
    expect(mergeEditLookup(prev, { status: 'Unbekannt' }).status).toBe('Laufend');
  });

  it('isFormDirty ignores number/string differences', () => {
    const base = buildFormData(SERVER);
    expect(isFormDirty(base, { ...base, total_volumes: '41' })).toBe(false);
    expect(isFormDirty(base, { ...base, title: 'X' })).toBe(true);
  });
});

describe('useMangaData: loading and errors', () => {
  beforeEach(() => {
    offlineStore.loadMangaDetail.mockReset().mockResolvedValue(null);
    offlineStore.syncOfflineCopy.mockClear();
  });

  it('404 means not found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(404, { error: 'Manga nicht gefunden' })));
    const { result } = renderData();
    await act(() => result.current.fetchManga());
    expect(result.current.notFound).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it('a 500 or 502 with nothing loaded is a server error, not "nicht gefunden"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(502, null, { raw: '<html>Bad Gateway</html>' })));
    const { result } = renderData();
    await act(() => result.current.fetchManga());
    expect(result.current.notFound).toBe(false);
    expect(result.current.loadError).toBe('server');
    expect(offlineStore.loadMangaDetail).toHaveBeenCalledWith('7');
  });

  it('a 503 with nothing loaded falls back to the offline copy', async () => {
    offlineStore.loadMangaDetail.mockResolvedValue({ ...SERVER, title: 'Offline' });
    vi.stubGlobal('fetch', vi.fn(async () => res(503, { error: 'Wartung' })));
    const { result } = renderData();
    await act(() => result.current.fetchManga());
    expect(result.current.manga.title).toBe('Offline');
    expect(result.current.notFound).toBe(false);
    expect(result.current.refreshError).toMatch(/Offline-Kopie/);
  });

  it('a failing refresh keeps the loaded series', async () => {
    const fetchMock = vi.fn(async () => res(200, SERVER));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderData();
    await act(() => result.current.fetchManga());
    fetchMock.mockImplementation(async () => res(500, { error: 'Interner Serverfehler' }));
    await act(() => result.current.fetchManga());
    expect(result.current.manga.title).toBe('Berserk');
    expect(result.current.notFound).toBe(false);
    expect(result.current.loadError).toBe(null);
    expect(result.current.refreshError).toBeTruthy();
    expect(offlineStore.loadMangaDetail).not.toHaveBeenCalled();
  });

  it('a 401 goes to the unauthorized handler', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(401, { error: 'Sitzung ungültig', code: 'SESSION_INVALID' })));
    const onUnauthorized = vi.fn();
    const { result } = renderData({ onUnauthorized });
    await act(() => result.current.fetchManga());
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(result.current.notFound).toBe(false);
    expect(result.current.loadError).toBe('unauthorized');
  });

  it('offline without a cached copy says so instead of "gelöscht"', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderData({ user: { ...editor, offline: true } });
    await act(() => result.current.fetchManga());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.notFound).toBe(false);
    expect(result.current.loadError).toBe('offline-missing');
  });

  it('an older response arriving last does not overwrite the newer one', async () => {
    const first = deferred();
    const second = deferred();
    const fetchMock = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderData();
    let p1;
    let p2;
    act(() => { p1 = result.current.fetchManga(); p2 = result.current.fetchManga(); });
    second.resolve(res(200, { ...SERVER, title: 'neu' }));
    await act(() => p2);
    first.resolve(res(200, { ...SERVER, title: 'alt' }));
    await act(() => p1);
    expect(result.current.manga.title).toBe('neu');
    expect(result.current.loading).toBe(false);
  });

  it('switching to another series aborts the request of the previous one; unmount aborts the running one', async () => {
    const pending = deferred();
    const fetchMock = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(res(200, { ...SERVER, id: 8, title: 'Reihe 8' }));
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender, unmount } = renderData();
    let p1;
    act(() => { p1 = result.current.fetchManga(); });
    rerender({ id: '8', user: editor, canEdit: true });
    await act(() => result.current.fetchManga());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/mangas/7');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe('/api/mangas/8');
    pending.resolve(res(200, { ...SERVER, title: 'alt' }));
    await act(() => p1);
    expect(result.current.manga.title).toBe('Reihe 8');

    const late = deferred();
    fetchMock.mockReturnValueOnce(late.promise);
    act(() => { result.current.fetchManga(); });
    unmount();
    expect(fetchMock.mock.calls[2][1].signal.aborted).toBe(true);
  });
});

describe('useMangaData: in-memory copy', () => {
  beforeEach(() => {
    offlineStore.loadMangaDetail.mockReset().mockResolvedValue(null);
  });

  it('a series seen before is shown at once with its form, no spinner', () => {
    writeCache(editor.id, detailKey('7'), SERVER, 'W/"x"');
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { result } = renderData();
    expect(result.current.loading).toBe(false);
    expect(result.current.manga.title).toBe('Berserk');
    expect(result.current.formData.title).toBe('Berserk');
  });

  it('switching to a remembered series shows it without a spinner', async () => {
    writeCache(editor.id, detailKey('8'), { ...SERVER, id: 8, title: 'Reihe 8' });
    const fetchMock = vi.fn(async () => res(200, SERVER));
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderData();
    await act(() => result.current.fetchManga());
    fetchMock.mockImplementation(() => new Promise(() => {}));
    rerender({ id: '8', user: editor, canEdit: true });
    act(() => { result.current.fetchManga(); });
    expect(result.current.loading).toBe(false);
    expect(result.current.manga.title).toBe('Reihe 8');
  });

  it('a delete forgets the copy and removes the series from the remembered shelf list', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    writeCache(editor.id, LIST_KEY, [{ id: 7, title: 'Berserk' }, { id: 9, title: 'Akira' }]);
    const fetchMock = vi.fn(async (url, init = {}) => (init.method === 'DELETE' ? res(200, { message: 'ok' }) : res(200, SERVER)));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderData();
    await act(() => result.current.fetchManga());
    expect(readCache(editor.id, detailKey('7'))).toBeTruthy();
    await act(() => result.current.handleDeleteManga());
    expect(readCache(editor.id, detailKey('7'))).toBeNull();
    expect(readCache(editor.id, LIST_KEY).data).toEqual([{ id: 9, title: 'Akira' }]);
  });
});

describe('useMangaData: edit form', () => {
  beforeEach(() => {
    offlineStore.syncOfflineCopy.mockClear();
  });

  async function loaded(fetchImpl) {
    const fetchMock = vi.fn(fetchImpl || (async () => res(200, SERVER)));
    vi.stubGlobal('fetch', fetchMock);
    const hook = renderData();
    await act(() => hook.result.current.fetchManga());
    return { ...hook, fetchMock };
  }

  it('a refresh while editing keeps the typed values and still updates the page', async () => {
    const { result, fetchMock } = await loaded();
    act(() => result.current.startEditing());
    act(() => result.current.setFormData(prev => ({ ...prev, title: 'Mein Titel' })));
    expect(result.current.isEditDirty).toBe(true);
    fetchMock.mockImplementation(async () => res(200, { ...SERVER, volumes: [{ id: 1 }] }));
    await act(() => result.current.fetchManga());
    expect(result.current.manga.volumes).toHaveLength(1);
    expect(result.current.formData.title).toBe('Mein Titel');
  });

  it('cancel (also via setEditing(false)) restores the server values; reopening starts clean', async () => {
    const { result } = await loaded();
    act(() => result.current.setEditing(true));
    act(() => result.current.setFormData(prev => ({ ...prev, title: 'XYZ' })));
    act(() => result.current.setEditing(false));
    expect(result.current.editing).toBe(false);
    expect(result.current.formData.title).toBe('Berserk');
    act(() => result.current.startEditing());
    expect(result.current.formData.title).toBe('Berserk');
    expect(result.current.isEditDirty).toBe(false);
  });

  it('cover upload in the open form only sets the form field (no PUT, other edits kept)', async () => {
    const { result, fetchMock } = await loaded();
    act(() => result.current.startEditing());
    act(() => result.current.setFormData(prev => ({ ...prev, description: 'neu' })));
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => res(200, { url: '/uploads/new.jpg' }));
    await act(() => result.current.handleCoverUpload({ target: { files: [new Blob(['x'])] } }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/upload');
    expect(result.current.formData.cover_image).toBe('/uploads/new.jpg');
    expect(result.current.formData.description).toBe('neu');
  });

  it('cover upload outside the form saves at once and reloads', async () => {
    const { result, fetchMock } = await loaded();
    fetchMock.mockClear();
    fetchMock.mockImplementation(async (url, opts) => {
      if (url === '/api/upload') return res(200, { url: '/uploads/new.jpg' });
      if (opts?.method === 'PUT') return res(200, { success: true });
      return res(200, { ...SERVER, cover_image: '/uploads/new.jpg' });
    });
    await act(() => result.current.handleCoverUpload({ target: { files: [new Blob(['x'])] } }));
    expect(bodyOf(fetchMock.mock.calls[1])).toEqual({ cover_image: '/uploads/new.jpg' });
    expect(result.current.manga.cover_image).toBe('/uploads/new.jpg');
    expect(result.current.formData.cover_image).toBe('/uploads/new.jpg');
  });

  it('a cover upload can be cancelled: no PUT, "Upload abgebrochen", the cover button is free again', async () => {
    const { result, fetchMock } = await loaded();
    fetchMock.mockClear();
    fetchMock.mockImplementation((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    let pending;
    act(() => { pending = result.current.handleCoverUpload({ target: { files: [new Blob(['x'])] } }); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(result.current.uploadingCover).toBe(true);
    await act(async () => { result.current.cancelCoverUpload(); await pending; });
    expect(result.current.uploadingCover).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toasts.messages('info')).toEqual([UPLOAD_CANCELLED]);
    expect(toasts.messages('error')).toEqual([]);
  });

  it('a cancel while the upload answer is read stores nothing; once it is in the cancel goes away', async () => {
    const { result, fetchMock } = await loaded();
    fetchMock.mockClear();
    const body = deferred();
    const uploadAnswer = { ...res(200, {}), json: () => body.promise };
    fetchMock.mockImplementation(async (url) => (url === '/api/upload' ? uploadAnswer : res(200, { success: true })));
    let pending;
    act(() => { pending = result.current.handleCoverUpload({ target: { files: [new Blob(['x'])] } }); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => result.current.cancelCoverUpload());
    await act(async () => { body.resolve({ url: '/uploads/new.jpg' }); await pending; });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toasts.messages('info')).toEqual([UPLOAD_CANCELLED]);
    expect(result.current.manga.cover_image).toBe('/uploads/a.jpg');

    const save = deferred();
    fetchMock.mockClear();
    fetchMock.mockImplementation((url, opts) => {
      if (url === '/api/upload') return Promise.resolve(res(200, { url: '/uploads/new.jpg' }));
      if (opts?.method === 'PUT') return save.promise;
      return Promise.resolve(res(200, { ...SERVER, cover_image: '/uploads/new.jpg' }));
    });
    act(() => { pending = result.current.handleCoverUpload({ target: { files: [new Blob(['x'])] } }); });
    expect(typeof result.current.cancelCoverUpload).toBe('function');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.uploadingCover).toBe(true);
    expect(result.current.cancelCoverUpload).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
    await act(async () => { save.resolve(res(200, { success: true })); await pending; });
    expect(result.current.manga.cover_image).toBe('/uploads/new.jpg');
    expect(result.current.uploadingCover).toBe(false);
  });

  it('save leaves an unchanged manga_passion_id out, reloads and resets the form', async () => {
    const { result, fetchMock } = await loaded();
    act(() => result.current.startEditing());
    act(() => result.current.setFormData(prev => ({ ...prev, title: 'Berserk Deluxe' })));
    fetchMock.mockImplementation(async (url, opts) => (opts?.method === 'PUT' ? res(200, { success: true }) : res(200, { ...SERVER, title: 'Berserk Deluxe', manga_passion_id: 99 })));
    await act(() => result.current.handleUpdate({ preventDefault() {} }));
    const put = fetchMock.mock.calls.find(c => c[1]?.method === 'PUT');
    expect(bodyOf(put)).not.toHaveProperty('manga_passion_id');
    expect(bodyOf(put).title).toBe('Berserk Deluxe');
    expect(result.current.editing).toBe(false);
    expect(result.current.formData.manga_passion_id).toBe(99);
  });

  it('save sends only the changed fields, so an edition sync while the form was open is kept', async () => {
    const { result, fetchMock } = await loaded();
    act(() => result.current.startEditing());
    // the edition sync stores 50 volumes and a new status while the form is open
    fetchMock.mockImplementation(async () => res(200, { ...SERVER, total_volumes: 50, status: 'Abgeschlossen' }));
    await act(() => result.current.fetchManga());
    act(() => result.current.setFormData(prev => ({ ...prev, description: 'neu' })));
    fetchMock.mockImplementation(async (url, opts) => (opts?.method === 'PUT' ? res(200, { success: true }) : res(200, { ...SERVER, total_volumes: 50, description: 'neu' })));
    await act(() => result.current.handleUpdate({ preventDefault() {} }));
    const put = fetchMock.mock.calls.find(c => c[1]?.method === 'PUT');
    expect(bodyOf(put)).toEqual({ description: 'neu' });
  });

  it('save without any change sends nothing and closes the form', async () => {
    const { result, fetchMock } = await loaded();
    act(() => result.current.startEditing());
    fetchMock.mockClear();
    await act(() => result.current.handleUpdate({ preventDefault() {} }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.editing).toBe(false);
  });

  it('save sends manga_passion_id when the user changed it, and shows a 400 text', async () => {
    const { result, fetchMock } = await loaded();
    act(() => result.current.startEditing());
    act(() => result.current.setFormData(prev => ({ ...prev, manga_passion_id: 5 })));
    fetchMock.mockImplementation(async () => res(400, { error: 'Ungültiger Status' }));
    await act(() => result.current.handleUpdate({ preventDefault() {} }));
    expect(bodyOf(fetchMock.mock.calls.at(-1)).manga_passion_id).toBe(5);
    expect(toasts.messages('error')).toContainEqual('Ungültiger Status');
    expect(result.current.editing).toBe(true);
  });

  it('auto-fill on a running series keeps the stored total and an unknown status', async () => {
    const { result } = await loaded();
    act(() => result.current.startEditing());
    act(() => result.current.setFormData(prev => ({ ...prev, status: 'Pausiert' })));
    await act(() => result.current.applyEditLookupResult({ title: 'Berserk', status: 'Laufend', total_volumes: 3 }));
    expect(result.current.formData.total_volumes).toBe(41);
    expect(result.current.formData.status).toBe('Laufend');
    await act(() => result.current.applyEditLookupResult({ title: 'Berserk', status: 'Unbekannt' }));
    expect(result.current.formData.status).toBe('Laufend');
  });

  it('delete uses the shared text, refreshes the offline copy and leaves the page', async () => {
    const { result, fetchMock } = await loaded();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchMock.mockImplementation(async () => res(200, { success: true }));
    await act(() => result.current.handleDeleteManga());
    expect(confirmSpy.mock.calls[0][0]).toMatch(/Papierkorb \(30 Tage wiederherstellbar\)/);
    expect(offlineStore.syncOfflineCopy).toHaveBeenCalledWith({ force: true });
  });

  it('a different series id resets an open form', async () => {
    const { result, rerender, fetchMock } = await loaded();
    act(() => result.current.startEditing());
    act(() => result.current.setFormData(prev => ({ ...prev, title: 'XYZ' })));
    fetchMock.mockImplementation(async () => res(200, { ...SERVER, id: 8, title: 'Akira' }));
    rerender({ id: '8', user: editor, canEdit: true });
    await act(() => result.current.fetchManga());
    await waitFor(() => expect(result.current.editing).toBe(false));
    expect(result.current.formData.title).toBe('Akira');
  });
});

describe('useShelfLayout: scrollShelf', () => {
  const scrollWith = (reduce) => {
    vi.stubGlobal('matchMedia', vi.fn((query) => ({ matches: reduce && query === '(prefers-reduced-motion: reduce)', media: query })));
    const { result } = renderHook(() => useShelfLayout([]));
    const scrollBy = vi.fn();
    result.current.shelfScrollRef.current = { scrollBy };
    result.current.scrollShelf(200);
    return scrollBy.mock.calls[0][0];
  };

  it('scrolls smoothly by default and jumps when the user asks for reduced motion', () => {
    expect(scrollWith(false)).toEqual({ left: 200, behavior: 'smooth' });
    expect(scrollWith(true)).toEqual({ left: 200, behavior: 'auto' });
  });
});

describe('useVolumeEditForm: client timeouts', () => {
  afterEach(() => vi.useRealTimers());

  const hanging = () => vi.fn(() => new Promise(() => {}));
  const renderForm = () => renderHook(() => useVolumeEditForm({
    activeVolume: { id: 5, volume_number: '3', status: 'Fehlt', images: [] }, mangaId: 1, canEdit: true, onClose: vi.fn(), onSuccess: vi.fn()
  }));

  it('a Manga Passion lookup may take longer than the 15 s read timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = hanging();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderForm();
    act(() => { result.current.handleAutofillVolumeData(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^\/api\/volumes\/lookup\?/);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    expect(result.current.autofillingVolume).toBe(true);
  });

  it('a photo upload can be cancelled; the editor shows "Upload abgebrochen"', async () => {
    const fetchMock = vi.fn((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderForm();
    let pending;
    act(() => { pending = result.current.handleUploadVolumeImages([new File(['x'], 'a.jpg', { type: 'image/jpeg' })]); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(result.current.uploadingVolImage).toBe(true);
    await act(async () => { result.current.cancelVolumeImageUpload(); await pending; });
    expect(result.current.uploadingVolImage).toBe(false);
    expect(result.current.photoError).toEqual({ text: UPLOAD_CANCELLED });
  });

  it('after a rebase an untouched server value outside the client rules does not block saving', async () => {
    const fetchMock = vi.fn(async () => res(200, { success: true }));
    vi.stubGlobal('fetch', fetchMock);
    const onClose = vi.fn();
    const opened = { id: 5, volume_number: '3', status: 'Fehlt', price: null, images: [] };
    const { result, rerender } = renderHook((p) => useVolumeEditForm(p), {
      initialProps: { activeVolume: opened, mangaId: 1, canEdit: true, onClose, onSuccess: vi.fn() }
    });
    rerender({ activeVolume: { ...opened, price: 7.999 }, mangaId: 1, canEdit: true, onClose, onSuccess: vi.fn() });
    expect(result.current.fieldErrors).toEqual({});
    act(() => result.current.setEditVolForm(prev => ({ ...prev, notes: 'neu' })));
    await act(() => result.current.handleSaveVolume({ preventDefault() {} }));
    expect(result.current.formError).toBe('');
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ notes: 'neu' });
    expect(onClose).toHaveBeenCalled();

    act(() => result.current.setEditVolForm(prev => ({ ...prev, price: '1,234' })));
    expect(result.current.fieldErrors.price).toBeTruthy();
  });

  it('a photo upload gets the size-aware upload timeout (at least 120 s), so a hung one ends', async () => {
    vi.useFakeTimers();
    const fetchMock = hanging();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderForm();
    act(() => { result.current.handleUploadVolumeImages([new File(['x'], 'a.jpg', { type: 'image/jpeg' })]); });
    await act(async () => { await vi.advanceTimersByTimeAsync(119000); });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/upload/multiple');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    expect(result.current.uploadingVolImage).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
