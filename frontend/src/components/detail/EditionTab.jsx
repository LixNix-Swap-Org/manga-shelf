import { Eye, EyeOff, Globe, Layers, Library, ListPlus } from 'lucide-react';
import EditionSwitcher from './EditionSwitcher';
import CopyVolumesNotice from './CopyVolumesNotice';
import { mpPillText } from './volumeViewHelpers';
import { t } from '../../i18n/index.js';

function Card({ id, Icon, title, text, children }) {
  return (
    <div id={id} className="p-5 rounded-2xl bg-slate-950/60 border border-slate-800 flex flex-col gap-3">
      <h3 className="text-sm font-bold text-white flex items-center gap-2">
        <Icon className="w-4 h-4 text-brand-400 shrink-0" aria-hidden="true" /> {title}
      </h3>
      <p className="text-xs text-slate-400 leading-relaxed">{text}</p>
      {children && <div className="flex flex-wrap items-center gap-2 mt-auto">{children}</div>}
    </div>
  );
}

/**
 * Tab "Edition & Abgleich" of the series page: the tools around the edition in one place. Gap detection (switch and
 * "Lücken füllen"), the Manga Passion check, choosing another edition and taking over volumes from another own shelf.
 * The same controls stay where they were in the volume list; this tab only gathers them.
 */
export default function EditionTab({
  manga, canEdit, isOffline, onEditionsChanged,
  detectedGapEntries = [], showGaps, onToggleShowGaps, onFillGaps, fillingGaps = false,
  mpEnabled = true, mpGapData, mpGapLoading, mpGapError, onOpenMp,
  shelfCount = 1, volumeCount = 0, onCopied
}) {
  const regularGaps = detectedGapEntries.filter((entry) => entry.type === 'volume').length;
  const anyGaps = detectedGapEntries.length > 0;
  const online = !isOffline;
  return (
    <div id="detail-edition" className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card
        id="edition-card-gaps"
        Icon={Layers}
        title={t('Lücken-Erkennung')}
        text={anyGaps
          ? t('Fehlende Bandnummern: {count}. Auf Wunsch markiert das Regal die Lücken, und sie lassen sich auf einmal als „Fehlt“ anlegen.', { count: detectedGapEntries.length })
          : t('Keine Lücken in der Nummerierung.')}
      >
        {anyGaps && (
          <button
            type="button"
            id="btn-edition-show-gaps"
            role="switch"
            aria-checked={Boolean(showGaps)}
            onClick={onToggleShowGaps}
            className={`px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 border ${showGaps ? 'bg-amber-500/20 text-amber-200 border-amber-500/50' : 'bg-slate-900 text-slate-300 border-slate-700'}`}
          >
            {showGaps ? <Eye className="w-3.5 h-3.5" aria-hidden="true" /> : <EyeOff className="w-3.5 h-3.5" aria-hidden="true" />}
            {t('Lücken zeigen')}
          </button>
        )}
        {canEdit && online && regularGaps > 0 && (
          <button type="button" id="btn-edition-fill-gaps" onClick={() => onFillGaps?.('Fehlt')} disabled={fillingGaps} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5">
            <ListPlus className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" /> {fillingGaps ? t('Lücken werden angelegt…') : t('Lücken füllen')}
          </button>
        )}
      </Card>

      <Card
        id="edition-card-mp"
        Icon={Globe}
        title={t('Manga-Passion-Abgleich')}
        text={online && mpEnabled
          ? t('Ausgabe mit Manga Passion abgleichen, Bände und Erscheinungstermine übernehmen. Stand: {state}', { state: mpPillText({ mpGapData, mpGapLoading, mpGapError }) })
          : (isOffline ? t('Der Abgleich braucht eine Verbindung zum Server.') : (manga.format === 'webtoon' ? t('Für Webtoons gibt es keinen Manga-Passion-Abgleich.') : t('Den Abgleich gibt es nur für deutsche Ausgaben.')))}
      >
        {online && mpEnabled && (
          <button type="button" id="btn-edition-mp" onClick={onOpenMp} className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5 text-brand-400" aria-hidden="true" /> {t('Abgleichen')}
          </button>
        )}
      </Card>

      <Card
        id="edition-card-editions"
        Icon={Layers}
        title={t('Ausgabe wechseln')}
        text={t('Andere Ausgaben derselben Reihe (Sprache, Format, Sonderausgabe) verknüpfen und zwischen ihnen wechseln.')}
      >
        <EditionSwitcher manga={manga} canEdit={canEdit} isOffline={isOffline} onChanged={onEditionsChanged} idSuffix="-tab" />
      </Card>

      <Card
        id="edition-card-copy"
        Icon={Library}
        title={t('Bände aus anderem Regal')}
        text={t('Hat ein anderes deiner Regale Bände dieser Ausgabe, die hier fehlen, kannst du sie hier übernehmen.')}
      >
        <CopyVolumesNotice mangaId={manga.id} enabled={Boolean(canEdit) && online && shelfCount > 1} version={volumeCount} onCopied={onCopied} />
      </Card>
    </div>
  );
}
