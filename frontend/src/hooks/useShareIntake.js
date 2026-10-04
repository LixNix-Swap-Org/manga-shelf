import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError } from '../utils/api';
import { SHARE_LINK_EVENT, hasPendingShare } from '../app/deepLink';
import { notify } from '../utils/notify';
import { displayTitle } from '../utils/animeHelpers';
import {
  SHARE_TEXTS, findStreamingLink, resolveSharedLink, resolveErrorText, isUnsupportedLink, knownEntry, displaySeriesTitle, savedRaised, progressBefore,
  raisesCounter, readClipboardText
} from '../utils/shareIntake';
import { t } from '../i18n/index.js';

// A streaming link shared to the app (share target, Android share sheet, "Link einfügen"): asks the server what it points to,
// lets the user confirm "Frieren, Folge 7 gesehen?" and saves it with an undo toast. `state` drives ShareLinkDialog:
// { phase: 'paste' | 'reading' | 'error' | 'confirm' | 'saving', … } or null. Shares arriving while it is open wait in order.
export default function useShareIntake({ anime, user, canEdit, showAnime, openAddAnime }) {
  const [state, setState] = useState(null);
  const stateRef = useRef(null);
  stateRef.current = state;
  const queue = useRef([]);
  // set between a close and the next queued share, so a share arriving meanwhile keeps its place in the line
  const handingOn = useRef(false);
  const abortRef = useRef(null);
  const animeRef = useRef(anime);
  animeRef.current = anime;

  useEffect(() => () => abortRef.current?.abort(), []);

  const resolve = useCallback(async (input, link) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const reading = { phase: 'reading', input, link };
    // busy at once: a share arriving before the next render queues instead of aborting this one
    stateRef.current = reading;
    setState(reading);
    try {
      const answer = await resolveSharedLink({ url: link.url, text: [input.subject, input.text].filter(Boolean).join(' ') }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setState({ phase: 'confirm', input, link, answer, chosenId: answer?.anime_id ?? null });
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) return;
      setState({ phase: 'error', input, link, error: resolveErrorText(err), retryable: !isUnsupportedLink(err) });
    }
  }, []);

  /** True when the input holds a streaming link (then it is handled here), false so the caller can try an ISBN. */
  const start = useCallback((input = {}, { switchView = true } = {}) => {
    const link = findStreamingLink(input.text, input.url);
    if (!link) return false;
    if (user?.offline) {
      notify.info(t(SHARE_TEXTS.offline));
      return true;
    }
    if (!canEdit) {
      notify.info(t(SHARE_TEXTS.visitor));
      return true;
    }
    if (stateRef.current || handingOn.current) {
      queue.current.push(input);
      return true;
    }
    if (switchView) showAnime?.();
    resolve(input, link);
    return true;
  }, [canEdit, resolve, showAnime, user?.offline]);

  const close = useCallback(() => {
    abortRef.current?.abort();
    stateRef.current = null;
    setState(null);
    const next = queue.current.shift();
    if (next) {
      handingOn.current = true;
      // after this close has rendered, so the next share gets a fresh dialog
      setTimeout(() => {
        handingOn.current = false;
        start(next);
      }, 0);
    } else if (hasPendingShare()) {
      // shares that came before the app listened (iOS inbox on a cold start) are fetched one by one
      setTimeout(() => window.dispatchEvent(new CustomEvent(SHARE_LINK_EVENT)), 0);
    }
  }, [start]);

  /** "Link einfügen": the clipboard only on this tap; without a link in it the paste field. */
  const paste = useCallback(async () => {
    if (stateRef.current) return;
    const text = await readClipboardText();
    if (text && start({ text }, { switchView: false })) return;
    setState({ phase: 'paste', error: '' });
  }, [start]);

  const submitPaste = useCallback((text) => {
    const link = findStreamingLink(text);
    if (!link) {
      setState((s) => (s ? { ...s, phase: 'paste', error: t(SHARE_TEXTS.notALink) } : s));
      return;
    }
    resolve({ text }, link);
  }, [resolve]);

  const retry = useCallback(() => {
    const s = stateRef.current;
    if (s?.link) resolve(s.input, s.link);
  }, [resolve]);

  const choose = useCallback((id) => setState((s) => (s ? { ...s, chosenId: id } : s)), []);

  /** "Zur Liste hinzufügen": the add dialog opens above this one; the entry it creates or finds comes back via choose(). */
  const addToList = useCallback(() => {
    const s = stateRef.current;
    if (s?.answer) openAddAnime?.(s.answer.series_title || '');
  }, [openAddAnime]);

  /** Saves the episode; `complete` marks an entry with fewer episodes as fully watched. The undo uses the server's `previous`. */
  const confirm = useCallback(async ({ animeId, episode, complete = false }) => {
    const s = stateRef.current;
    if (!s?.answer || !animeId || !(episode > 0)) return;
    const { answer } = s;
    const actions = animeRef.current;
    const entry = actions.list.find((a) => a.id === animeId);
    const known = knownEntry(answer, animeId);
    const title = entry ? displayTitle(entry) : (known?.title || displaySeriesTitle(answer, s.link) || t('Anime'));
    setState({ ...s, phase: 'saving', aboveTotal: null });
    const remember = answer.series_id ? { service: answer.service, external_id: answer.series_id } : undefined;
    // a series page is no episode to continue from: the server only takes episode links as resume_url
    const url = answer.kind === 'series' ? undefined : answer.url;
    let saved;
    try {
      saved = await actions.markWatched(animeId, { episode, url, remember, complete });
    } catch (err) {
      const total = Number(err?.data?.episodes) || null;
      setState((cur) => (cur ? { ...cur, phase: 'confirm', aboveTotal: { animeId, episode, total } } : cur));
      return;
    }
    if (!saved) {
      setState((cur) => (cur ? { ...cur, phase: 'confirm' } : cur));
      return;
    }
    close();
    const hasPrevious = 'previous' in saved;
    if (!(hasPrevious ? savedRaised(saved) : raisesCounter(progressBefore(entry, known), episode))) {
      notify.success(t('{title}: Link für „Weiter“ gemerkt', { title }));
      return;
    }
    const text = saved.progress?.status === 'Gesehen' && complete ? `${title}: komplett gesehen` : `${title}: Folge ${episode} gesehen`;
    // an older server without `previous` gets no undo: guessing from the list could delete real progress
    const undo = hasPrevious
      ? { label: t('Rückgängig'), onClick: () => animeRef.current.undoWatched(animeId, saved.previous) }
      : undefined;
    notify.success(text, undo ? { action: undo } : undefined);
  }, [close]);

  return { state, start, paste, submitPaste, retry, choose, addToList, confirm, close };
}
