import { useEffect, useMemo, useState } from 'react';
import {
  Bell, BookOpen, ChartColumn, ChevronRight, ExternalLink, HardDrive, Image as ImageIcon, Shield, ShoppingCart, Smartphone,
  Sparkles, TriangleExclamationPoint, Tv, Users, Wrench
} from 'lucide-react';
import ToolDialog from '../modals/ToolDialog';
import useTabList from '../../hooks/useTabList';
import { getLanguage, t } from '../../i18n/index.js';
import { formatDate } from '../../utils/format';
import { APP_LINK_TARGETS, compareVersions, forAllItems, inlineParts, isTechnicalItem, versionsUpTo } from '../../utils/whatsNew.js';
import { REPO_URL } from '../system/updateModel';
import { loadChangelog } from './changelog.js';

// an icon per item from its words (German block or English fallback); the book when nothing fits
const ICONS = [
  [/was ist neu|what'?s new/i, Sparkles],
  [/statistik|manga-jahr|statistics|year/i, ChartColumn],
  [/erinnerung|mitteilung|reminder|push/i, Bell],
  [/wunschliste|einkauf|wishlist|shopping/i, ShoppingCart],
  [/verleih|ausleih|besitzer|für wen|exemplar|lend|owner|cop(y|ies)/i, Users],
  [/cover/i, ImageIcon],
  [/anime/i, Tv],
  [/privat|privacy/i, Shield],
  [/backup|sicherung/i, HardDrive],
  [/handy|iphone|phone|ohne server/i, Smartphone]
];
const iconFor = (item) => (ICONS.find(([pattern]) => pattern.test(`${item.title} ${item.text}`)) || [null, BookOpen])[1];

/** A CHANGELOG text with its **bold**, `code` and https links. */
function Inline({ text }) {
  // i18n-ignore: the parts are CHANGELOG text, written per language there
  return inlineParts(text).map((part, i) => {
    if (part.type === 'bold') return <strong key={i} className="font-semibold text-slate-100">{part.text}</strong> // i18n-ignore: CHANGELOG text
    if (part.type === 'code') return <code key={i} className="font-mono text-[0.85em] text-brand-200 bg-slate-800/80 rounded px-1">{part.text}</code> // i18n-ignore: CHANGELOG text
    if (part.type === 'link') return <a key={i} href={part.href} target="_blank" rel="noopener noreferrer" className="text-brand-300 hover:text-brand-200 underline">{part.text}</a> // i18n-ignore: CHANGELOG text
    return <span key={i}>{part.text}</span> // i18n-ignore: CHANGELOG text
  });
}

function ForAllCard({ item, onLink }) {
  const Icon = iconFor(item);
  const link = item.link && APP_LINK_TARGETS.includes(item.link.target) && onLink ? item.link : null;
  const linkLabel = link?.label; // CHANGELOG text, written per language there
  return (
    <li className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-3.5 flex gap-3">
      <div className="w-8 h-8 shrink-0 rounded-xl bg-slate-800/80 flex items-center justify-center text-brand-400">
        <Icon className="w-4 h-4" aria-hidden="true" />
      </div>
      <div className="min-w-0 space-y-1">
        {item.title && <p className="text-sm font-bold text-slate-100">{item.title}</p>}
        <p className="text-[13px] leading-relaxed text-slate-300"><Inline text={item.text} /></p>
        {link && (
          <button
            type="button"
            onClick={() => onLink(link.target)}
            className="hit-44 inline-flex items-center gap-1 text-[13px] font-semibold text-brand-300 hover:text-brand-200"
          >
            {linkLabel}
            <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );
}

function SectionList({ sections, technicalChip }) {
  return (
    <div className="space-y-3">
      {sections.map((section) => (
        <section key={section.heading} className="rounded-2xl border border-slate-800/80 bg-slate-900/60 p-3.5 space-y-2">
          <h4 className="flex items-center gap-2 text-sm font-bold text-slate-100" lang="en">
            {section.technical && <Wrench className="w-4 h-4 text-slate-400" aria-hidden="true" />}
            <span className="flex-1">{section.heading}</span>
            {technicalChip && section.technical && (
              <span lang="de" className="text-[10px] font-bold tracking-wide text-slate-300 border border-slate-700 bg-slate-800/80 rounded-md px-1.5 py-0.5">{t('TECHNIK')}</span>
            )}
          </h4>
          <ul className="space-y-1.5 list-disc pl-5 marker:text-slate-600" lang="en">
            {section.items.map((item, i) => (
              <li key={i} className="text-[13px] leading-relaxed text-slate-300">
                <Inline text={item} />
                {technicalChip && !section.technical && isTechnicalItem(section, item) && (
                  <span lang="de" className="ml-1.5 text-[10px] font-bold tracking-wide text-slate-300 border border-slate-700 bg-slate-800/80 rounded-md px-1.5 py-0.5">{t('TECHNIK')}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const versionLabel = (entry) => (entry.date ? formatDate(entry.date) : t('ohne eigenes Datum'));

/**
 * "Was ist neu": the changes per version from the CHANGELOG built into the app. "Für alle" shows the German block of a
 * version (or its English non-technical items); admins also get "Für Admins" with the whole section. `since` is the
 * version the account had seen before (marks the newer ones), `onLink` follows an `app:` link of an item.
 */
export default function WhatsNewDialog({ current, since = null, isAdmin = false, onClose, onLink }) {
  const [versions, setVersions] = useState(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState(null);
  const [tab, setTab] = useState('all');
  const { tabListProps, tabProps, panelProps } = useTabList({ tabs: ['all', 'admin'], selected: tab, onSelect: setTab, prefix: 'whats-new' });

  useEffect(() => {
    let alive = true;
    loadChangelog()
      .then((list) => { if (alive) setVersions(versionsUpTo(list, current)); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [current]);

  const entry = useMemo(() => (versions ? versions.find((v) => v.version === picked) || versions[0] : null), [versions, picked]);
  const language = getLanguage();
  const forAll = forAllItems(entry, language);
  const fullSections = entry ? entry.sections.filter((s) => s.heading) : [];
  const userSections = fullSections.filter((s) => !s.technical);
  const isNew = (v) => Boolean(since) && compareVersions(v.version, since) > 0;
  const showAdmin = isAdmin && tab === 'admin';

  return (
    <ToolDialog id="whats-new-dialog" title={t('Was ist neu')} Icon={Sparkles} onClose={onClose} width="max-w-5xl">
      {failed ? (
        <p role="alert" className="py-10 text-center text-sm text-slate-400">{t('Die Neuigkeiten konnten nicht geladen werden.')}</p>
      ) : !entry ? (
        <p role="status" className="py-10 text-center text-sm text-slate-400">{t('Lädt...')}</p>
      ) : (
        <div className="space-y-4">
          {isAdmin && (
            <div {...tabListProps} aria-label={t('Ansicht')} className="grid grid-cols-2 sm:inline-flex gap-1 p-1 rounded-xl bg-slate-950/70 border border-slate-800">
              <button {...tabProps('all')} className={`text-sm px-4 py-2 rounded-lg ${tab === 'all' ? 'bg-gradient-to-r from-brand-800 to-brand-700 text-white font-semibold' : 'text-slate-400 hover:text-white'}`}>{t('Für alle')}</button>
              <button {...tabProps('admin')} className={`text-sm px-4 py-2 rounded-lg ${tab === 'admin' ? 'bg-gradient-to-r from-brand-800 to-brand-700 text-white font-semibold' : 'text-slate-400 hover:text-white'}`}>{t('Für Admins')}</button>
            </div>
          )}

          <label className="sm:hidden flex flex-col gap-1 text-xs text-slate-400">
            {t('Version')}
            <select
              value={entry.version}
              onChange={(e) => setPicked(e.target.value)}
              className="w-full bg-slate-950/70 border border-slate-700 rounded-xl px-3 py-2.5 text-base text-slate-100"
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  {`${v.version} · ${versionLabel(v)}${isNew(v) ? ` · ${t('neu für dich')}` : ''}`}
                </option>
              ))}
            </select>
          </label>

          <div className="sm:grid sm:grid-cols-[13rem_minmax(0,1fr)] sm:gap-6">
            <nav aria-label={t('Versionen')} className="hidden sm:flex flex-col gap-1 sm:border-r sm:border-slate-800 sm:pr-4">
              <span className="text-[11px] font-bold tracking-widest text-slate-400 px-2.5 pb-1">{t('VERSIONEN')}</span>
              {versions.map((v) => {
                const selected = v.version === entry.version;
                return (
                  <button
                    key={v.version}
                    type="button"
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => setPicked(v.version)}
                    className={`text-left rounded-xl px-3 py-2 border ${selected ? 'border-brand-500/45 bg-brand-950/45 text-slate-100' : 'border-transparent text-slate-200 hover:bg-slate-800/60'}`}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      {v.version}
                      {isNew(v) && <span className="text-[10px] font-bold text-brand-950 bg-brand-300 rounded-md px-1.5 py-px">{t('NEU')}</span>}
                    </span>
                    <span className="block text-xs text-slate-400">{versionLabel(v)}</span>
                  </button>
                );
              })}
            </nav>

            <div {...(isAdmin ? panelProps : {})} className="min-w-0 space-y-3">
              <div>
                <h3 className="text-lg font-extrabold text-slate-100">{t('Neu in {version}', { version: entry.version })}</h3>
                {since && isNew(entry) && compareVersions(entry.version, current) === 0 && (
                  <p className="text-xs text-slate-400">{t('Seit deinem letzten Besuch ({version})', { version: since })}</p>
                )}
              </div>

              {!showAdmin ? (
                <>
                  {forAll.english && forAll.items.length > 0 && language === 'de' && (
                    <p className="text-xs text-slate-400">{t('Für diese Version gibt es die Liste nur auf Englisch.')}</p>
                  )}
                  {forAll.items.length > 0 ? (
                    <ul className="grid gap-3 md:grid-cols-2" lang={forAll.english ? 'en' : undefined}>
                      {forAll.items.map((item, i) => <ForAllCard key={i} item={item} onLink={onLink} />)}
                    </ul>
                  ) : (
                    <p className="text-sm text-slate-400">{t('In dieser Version hat sich für dich sichtbar nichts geändert.')}</p>
                  )}
                  {!forAll.english && userSections.length > 0 && (
                    <details className="group rounded-xl border border-dashed border-slate-700">
                      <summary className="cursor-pointer list-none flex items-center gap-2 px-3 py-3 text-[13px] text-slate-400 hover:text-slate-200">
                        <ChevronRight className="w-4 h-4 transition-transform group-open:rotate-90" aria-hidden="true" />
                        <span className="flex-1">{t('Alle Änderungen dieser Version')}</span>
                        <span className="text-[11px] text-slate-400">{t('Englisch')}</span>
                      </summary>
                      <div className="px-3 pb-3"><SectionList sections={userSections} /></div>
                    </details>
                  )}
                </>
              ) : (
                <>
                  <p className="text-xs text-slate-400">{t('Die ganze Version, wie sie in der CHANGELOG steht (Englisch).')}</p>
                  {entry.before.length > 0 && (
                    <section className="rounded-2xl border border-amber-500/40 bg-amber-500/[0.08] p-3.5 space-y-1.5">
                      <h4 className="flex items-center gap-2 text-sm font-bold text-amber-300">
                        <TriangleExclamationPoint className="w-4 h-4" aria-hidden="true" />
                        {t('Vor dem Update')}
                      </h4>
                      <ul className="space-y-1.5 list-disc pl-5 marker:text-amber-500/60" lang="en">
                        {entry.before.map((item, i) => <li key={i} className="text-[13px] leading-relaxed text-amber-100"><Inline text={item} /></li>)}
                      </ul>
                    </section>
                  )}
                  <SectionList sections={fullSections} technicalChip />
                  {entry.date && (
                  <a
                    href={`${REPO_URL}/releases/tag/v${entry.version}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-secondary text-sm inline-flex items-center justify-center gap-2 w-full sm:w-auto"
                  >
                    {t('Release mit Downloads auf GitHub')}
                    <ExternalLink className="w-4 h-4 text-slate-400" aria-hidden="true" />
                  </a>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </ToolDialog>
  );
}
