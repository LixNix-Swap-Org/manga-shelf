// The account dialog's default visibility of anime ratings: read from GET /api/auth/me as user.default_anime_visibility,
// saved with PUT /api/auth/profile, shared with the anime dialog through useAccountDefaults.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, renderHook } from '@testing-library/react';
import { fakeResponse } from './fakeResponse';
import AccountModal from '../components/modals/AccountModal';
import useAccountDefaults from '../hooks/useAccountDefaults';
import { clearDataCache } from '../utils/dataCache';

function serve({ me, profile = () => fakeResponse(404, { error: 'Nicht gefunden' }) }) {
  const fetchMock = vi.fn(async (url, init = {}) => {
    if (url === '/api/auth/me') return me();
    if (url === '/api/auth/profile' && init.method === 'PUT') return profile(JSON.parse(init.body));
    return fakeResponse(404, { error: 'Nicht gefunden' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const open = (tab) => render(<AccountModal isOpen onClose={vi.fn()} user={{ id: 2, role: 'editor' }} initialTab={tab} />);
const openLanguage = () => open('privacy');
const openGeneral = () => open('general');
const field = () => screen.getByLabelText('Sichtbarkeit deiner Anime-Bewertungen');
const shownLabel = (select) => select.options[select.selectedIndex].textContent;

afterEach(() => {
  vi.unstubAllGlobals();
  clearDataCache();
});

describe('AccountModal: default visibility of anime ratings', () => {
  it('shows the stored default from user.default_anime_visibility, not a field next to user', async () => {
    serve({ me: () => fakeResponse(200, { default_anime_visibility: 'anonymous', user: { id: 2, username: 'carl', default_anime_visibility: 'private' } }) });
    openLanguage();
    await waitFor(() => expect(field().disabled).toBe(false));
    expect(field().value).toBe('private');
    expect(shownLabel(field())).toBe('Nur ich');
  });

  it('waits for the answer before it can be changed, and asks the server again on every open', async () => {
    const answers = [];
    const fetchMock = serve({ me: () => new Promise((resolve) => { answers.push(resolve); }) });
    const { unmount } = openLanguage();
    expect(field().disabled).toBe(true);
    await waitFor(() => expect(answers).toHaveLength(1));
    answers[0](fakeResponse(200, { user: { id: 2, default_anime_visibility: 'anonymous' } }));
    await waitFor(() => expect(field().value).toBe('anonymous'));
    expect(field().disabled).toBe(false);
    unmount();
    openLanguage();
    expect(field().disabled).toBe(true);
    await waitFor(() => expect(answers).toHaveLength(2));
    answers[1](fakeResponse(200, { user: { id: 2, default_anime_visibility: 'private' } }));
    await waitFor(() => expect(field().value).toBe('private'));
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/me')).toHaveLength(2);
  });

  it('a change is saved at once and becomes the default the anime dialog uses', async () => {
    const fetchMock = serve({
      me: () => fakeResponse(200, { user: { id: 2, default_anime_visibility: 'public' } }),
      profile: (body) => fakeResponse(200, { user: { id: 2, default_anime_visibility: body.default_anime_visibility } })
    });
    openLanguage();
    await waitFor(() => expect(field().disabled).toBe(false));
    expect(field().value).toBe('public');
    fireEvent.change(field(), { target: { value: 'anonymous' } });
    await waitFor(() => expect(field().disabled).toBe(false));
    expect(field().value).toBe('anonymous');
    const put = fetchMock.mock.calls.find(([url, init]) => url === '/api/auth/profile' && init?.method === 'PUT');
    expect(JSON.parse(put[1].body)).toEqual({ default_anime_visibility: 'anonymous' });
    const { result } = renderHook(() => useAccountDefaults());
    expect(result.current).toEqual({ animeVisibility: 'anonymous', shareAnime: null, showTodo: null, loaded: true });
  });

  it('a refused change goes back to the stored value', async () => {
    serve({
      me: () => fakeResponse(200, { user: { id: 2, default_anime_visibility: 'private' } }),
      profile: () => fakeResponse(400, { error: 'Ungültige Sichtbarkeit' })
    });
    openLanguage();
    await waitFor(() => expect(field().disabled).toBe(false));
    fireEvent.change(field(), { target: { value: 'public' } });
    await waitFor(() => expect(field().disabled).toBe(false));
    expect(field().value).toBe('private');
  });

  it('offline the field stays disabled and nothing is asked', () => {
    const fetchMock = serve({ me: () => fakeResponse(200, { user: { id: 2, default_anime_visibility: 'private' } }) });
    render(<AccountModal isOpen onClose={vi.fn()} user={{ id: 2, role: 'editor', offline: true }} initialTab="privacy" />);
    expect(field().disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/auth/me')).toBe(false);
  });
});

describe('useAccountDefaults', () => {
  it('asks once per session; an answer that arrives after a logout belongs to the old account and is asked again', async () => {
    const answers = [];
    const fetchMock = serve({ me: () => new Promise((resolve) => { answers.push(resolve); }) });
    const { result } = renderHook(() => useAccountDefaults());
    await waitFor(() => expect(answers).toHaveLength(1));
    clearDataCache();
    answers[0](fakeResponse(200, { user: { id: 1, default_anime_visibility: 'private' } }));
    await waitFor(() => expect(answers).toHaveLength(2));
    expect(result.current.animeVisibility).toBeNull();
    answers[1](fakeResponse(200, { user: { id: 2, default_anime_visibility: 'anonymous' } }));
    await waitFor(() => expect(result.current).toEqual({ animeVisibility: 'anonymous', shareAnime: null, showTodo: null, loaded: true }));
    renderHook(() => useAccountDefaults());
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/me')).toHaveLength(2);
  });

  it('an unknown stored value counts as unknown', async () => {
    serve({ me: () => fakeResponse(200, { user: { id: 2, default_anime_visibility: 'friends' } }) });
    const { result } = renderHook(() => useAccountDefaults());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.animeVisibility).toBeNull();
  });
});

describe('AccountModal: sharing the anime list by name', () => {
  const share = () => screen.getByLabelText('Meine Anime-Liste mit Namen zeigen');

  it('shows the stored setting, saves a change at once and keeps it for the session', async () => {
    const fetchMock = serve({
      me: () => fakeResponse(200, { user: { id: 2, default_anime_visibility: 'public', share_anime_activity: true } }),
      profile: (body) => fakeResponse(200, { user: { id: 2, default_anime_visibility: 'public', share_anime_activity: body.share_anime_activity } })
    });
    openLanguage();
    await waitFor(() => expect(share().disabled).toBe(false));
    expect(share().checked).toBe(true);
    fireEvent.click(share());
    await waitFor(() => expect(share().disabled).toBe(false));
    expect(share().checked).toBe(false);
    const put = fetchMock.mock.calls.find(([url, init]) => url === '/api/auth/profile' && init?.method === 'PUT');
    expect(JSON.parse(put[1].body)).toEqual({ share_anime_activity: false });
    const { result } = renderHook(() => useAccountDefaults());
    expect(result.current.shareAnime).toBe(false);
  });

  it('is on while an older server sends no setting', async () => {
    serve({ me: () => fakeResponse(200, { user: { id: 2, default_anime_visibility: 'public' } }) });
    openLanguage();
    await waitFor(() => expect(share().disabled).toBe(false));
    expect(share().checked).toBe(true);
  });
});

describe('AccountModal: "Zu erledigen" on or off', () => {
  const box = () => screen.getByLabelText('„Zu erledigen“ in der Sammlung zeigen');

  it('saves the switch for the account and hands it to useAccountDefaults', async () => {
    const fetchMock = serve({
      me: () => fakeResponse(200, { user: { id: 2, default_anime_visibility: 'public', share_anime_activity: true, show_todo: true } }),
      profile: (body) => fakeResponse(200, { user: { id: 2, default_anime_visibility: 'public', share_anime_activity: true, show_todo: body.show_todo } })
    });
    openGeneral();
    await waitFor(() => expect(box().disabled).toBe(false));
    expect(box().checked).toBe(true);
    fireEvent.click(box());
    await waitFor(() => expect(box().disabled).toBe(false));
    expect(box().checked).toBe(false);
    const put = fetchMock.mock.calls.find(([url, init]) => url === '/api/auth/profile' && init?.method === 'PUT');
    expect(JSON.parse(put[1].body)).toEqual({ show_todo: false });
    const { result } = renderHook(() => useAccountDefaults());
    expect(result.current.showTodo).toBe(false);
  });

  it('is on while an older server sends no setting', async () => {
    serve({ me: () => fakeResponse(200, { user: { id: 2, default_anime_visibility: 'public' } }) });
    openGeneral();
    await waitFor(() => expect(box().disabled).toBe(false));
    expect(box().checked).toBe(true);
  });
});
