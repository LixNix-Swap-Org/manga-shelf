// The anime dialogs of the dashboard: the share dialog, "Anime hinzufügen" and the anime detail (split from Dashboard.jsx).
// Each has its own Suspense boundary: a dialog whose chunk is still loading must not hide another open one.
import { lazy, Suspense } from 'react';

const AddAnimeModal = lazy(() => import('../modals/AddAnimeModal'));
const AnimeDetailModal = lazy(() => import('../modals/AnimeDetailModal'));
const EpisodeLinkDialog = lazy(() => import('../modals/EpisodeLinkDialog'));

export default function DashboardAnimeDialogs({
  anime, share, shareDialogRef, canEdit, user, mangas, animeAdd, setAnimeAdd, matchSearch, settleMatchSearch,
  animeDetailId, setAnimeDetailId, animeEntry, animeTagNames
}) {
  return (
    <>
      {/* own boundaries: a dialog whose chunk is still loading must not hide the open share dialog (focus would leave it) */}
      <Suspense fallback={null}>
        {share.state && (
          <EpisodeLinkDialog
            state={share.state}
            list={anime.list}
            listLoaded={anime.loaded}
            canAdd={canEdit && !user?.offline}
            rootRef={shareDialogRef}
            onClose={share.close}
            onSubmitPaste={share.submitPaste}
            onRetry={share.retry}
            onChoose={share.choose}
            onAddToList={share.addToList}
            onConfirm={share.confirm}
            onCreate={share.create}
          />
        )}
      </Suspense>

      <Suspense fallback={null}>
        {animeAdd && (
          <AddAnimeModal
            isOpen
            onClose={() => { settleMatchSearch(null); setAnimeAdd(null); }}
            search={anime.search}
            loadAdaptations={anime.adaptations}
            onAdd={animeAdd.share
              ? async (body) => { const added = await anime.add(body); share.choose(added?.id ?? null); return added; }
              : async (body) => { const added = await anime.add(body); settleMatchSearch(added?.id ? { id: added.id } : null); return added; }}
            onOpenExisting={animeAdd.share ? share.choose : (id) => { if (matchSearch.current) settleMatchSearch({ id }); else setAnimeDetailId(id); }}
            mangas={mangas}
            initialMangaId={animeAdd.mangaId}
            initialQuery={animeAdd.query || ''}
            returnFocusRef={animeAdd.share ? shareDialogRef : undefined}
            sources={anime.sources}
            loadSources={anime.fetchSources}
            animeOnly={Boolean(animeAdd.share) || matchSearch.current !== null}
          />
        )}
      </Suspense>

      <Suspense fallback={null}>
        {animeDetailId !== null && (
          <AnimeDetailModal
            isOpen
            animeId={animeDetailId}
            fallback={animeEntry(animeDetailId)}
            onClose={() => setAnimeDetailId(null)}
            canEdit={canEdit && !user?.offline}
            mangas={mangas}
            fetchDetail={anime.fetchDetail}
            updateProgress={anime.updateProgress}
            removeFromMyList={anime.removeFromMyList}
            update={anime.update}
            seasonSuggestion={anime.seasonSuggestion}
            refresh={anime.refresh}
            remove={anime.remove}
            onAdd={anime.add}
            onOpenAnime={(id) => setAnimeDetailId(id)}
            knownTags={animeTagNames}
          />
        )}
      </Suspense>
    </>
  );
}
