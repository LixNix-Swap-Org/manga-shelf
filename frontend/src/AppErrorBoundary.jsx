import { Component } from 'react';
import { RotateCw, TriangleAlert } from 'lucide-react';
import { isChunkLoadError, reloadForStaleChunk } from './appShell';
import { useDocumentTitle } from './components/common/PageChrome';

function ErrorTitle({ title }) {
  useDocumentTitle(title);
  return null;
}

/**
 * Catches render errors below it. A missing lazy chunk (the tab still runs the previous release) reloads the page
 * once; otherwise it shows a reload screen instead of an empty page. `resetKey` (the route) clears the error.
 */
export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    if (isChunkLoadError(error) && reloadForStaleChunk()) return;
    console.error('[App] Render error:', error, info?.componentStack);
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = isChunkLoadError(error);
    return (
      <main className="flex min-h-screen items-center justify-center p-4 bg-slate-950 text-slate-100">
        <ErrorTitle title={stale ? 'Neue Version verfügbar' : 'Fehler'} />
        <div role="alert" className="glass-panel w-full max-w-md rounded-3xl border border-slate-700/80 p-8 text-center shadow-2xl">
          <TriangleAlert className="mx-auto mb-4 h-10 w-10 text-amber-400" aria-hidden="true" />
          <h1 className="text-xl font-bold text-white">
            {stale ? 'Neue Version verfügbar' : 'Etwas ist schiefgelaufen'}
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            {stale
              ? 'MangaShelf wurde aktualisiert. Lade die Seite neu, um die neue Version zu verwenden.'
              : 'Diese Ansicht konnte nicht angezeigt werden. Ein Neuladen behebt das meistens.'}
          </p>
          <div className="mt-6 flex flex-col items-center gap-3">
            <button type="button" className="btn-primary flex items-center gap-2 px-5 py-2.5 text-sm" onClick={() => window.location.reload()}>
              <RotateCw className="h-4 w-4" aria-hidden="true" /> Neu laden
            </button>
            {!stale && (
              <a href="/" className="text-xs font-semibold text-brand-400 hover:text-brand-300">Zur Übersicht</a>
            )}
          </div>
        </div>
      </main>
    );
  }
}
