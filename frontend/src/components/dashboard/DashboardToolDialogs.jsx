// The tool dialogs of the dashboard (Regale, Papierkorb, Aufräumen, Verlage), one open at a time (split from Dashboard.jsx).
import { lazy, Suspense } from 'react';

const TrashModal = lazy(() => import('../modals/TrashModal'));
const PublishersModal = lazy(() => import('../modals/PublishersModal'));
const ShelvesModal = lazy(() => import('../modals/ShelvesModal'));
const CleanupModal = lazy(() => import('../modals/CleanupModal'));

export default function DashboardToolDialogs({ tool, setTool, user, onDataChanged, shelfId, shelfName, onClearShelf, onShelfMissing }) {
  return (
    <Suspense fallback={null}>
      {tool === 'shelves' && (
        <ShelvesModal
          onClose={() => setTool(null)}
          user={user}
          onChanged={onDataChanged}
        />
      )}

      {tool === 'trash' && (
        <TrashModal
          onClose={() => setTool(null)}
          user={user}
          onChanged={onDataChanged}
          shelfId={shelfId}
          shelfName={shelfName}
          onClearShelf={onClearShelf}
          onShelfMissing={onShelfMissing}
        />
      )}

      {tool === 'cleanup' && (
        <CleanupModal
          onClose={() => setTool(null)}
          user={user}
          onChanged={onDataChanged}
          onNavigate={() => setTool(null)}
          onOpenPublishers={user?.role === 'admin' ? () => setTool('publishers') : undefined}
        />
      )}

      {tool === 'publishers' && (
        <PublishersModal
          onClose={() => setTool(null)}
          user={user}
          onChanged={onDataChanged}
        />
      )}
    </Suspense>
  );
}
