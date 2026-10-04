import { Link } from 'react-router-dom';
import { CloudDownload, Smartphone } from 'lucide-react';
import { getLocalProfile } from '../local/profile';
import { getToken } from './connection';

/** "Ohne Server nutzen" (onboarding step 1, Modus wechseln) and "Vom Server holen" with the current session. */
export default function LocalOffer({ user, onUseLocal, onPull }) {
  const profile = getLocalProfile();
  return (
    <section className="glass-panel rounded-2xl p-4 sm:p-5 border border-slate-700/70 space-y-3" aria-labelledby="local-offer-title">
      <h2 id="local-offer-title" className="font-bold text-white flex items-center gap-2">
        <Smartphone className="w-4 h-4 text-brand-400" aria-hidden="true" /> Ohne Server nutzen
      </h2>
      <p className="text-xs text-slate-400">Die Sammlung liegt nur auf diesem Gerät; Suchen bei Manga Passion, DNB und AniList laufen direkt von hier. Später lässt sie sich auf einen Server übertragen.</p>
      <div className="flex flex-wrap gap-2">
        {profile
          ? <button type="button" id="btn-open-local" className="btn-primary text-sm" onClick={onUseLocal}>Lokale Sammlung öffnen ({profile.name})</button>
          : <Link to="/lokal" id="btn-start-local" className="btn-primary text-sm">Ohne Server nutzen</Link>}
        {user && !user.offline && getToken() && (
          <button type="button" id="btn-pull-server" className="btn-secondary text-sm inline-flex items-center gap-1.5" onClick={onPull}>
            <CloudDownload className="w-4 h-4" aria-hidden="true" /> Sammlung auf dieses Gerät holen
          </button>
        )}
      </div>
    </section>
  );
}
