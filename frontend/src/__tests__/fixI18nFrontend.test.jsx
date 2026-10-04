// Review fixes of the i18n waves A+B (frontend): guard heuristics, stored values through enumLabels, tn() for counted
// nouns, server text params, release dates and the short radar tab label.
import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { transform } from '../../../scripts/i18n/codemod.mjs';
import { extract } from '../../../scripts/i18n/extract.mjs';
import { isGerman, SRC } from '../../../scripts/i18n/lib.mjs';
import { __setCatalogForTests, resetI18nForTests } from '../i18n/index.js';
import { serverText } from '../i18n/serverText.js';
import VolumeFilterBar from '../components/detail/VolumeFilterBar';
import MpTimeline from '../components/dashboard/radar/MpTimeline';
import RadarTabs from '../components/dashboard/radar/RadarTabs';
import AddMangaModal from '../components/modals/AddMangaModal';
import { seriesSummary } from '../components/dashboard/MangaCard';
import { aboveTotalText } from '../utils/shareIntake';
import { formatReleaseDate, groupMpItemsByDate } from '../utils/radarHelpers';
import { GERMAN_MONTHS } from '../utils/collectionHelpers';
import { COLLECTING_VALUES } from '../utils/enumLabels';

const PROBE = path.join(SRC, 'Probe.jsx');
const probe = (code) => transform(PROBE, code);

afterEach(() => {
  cleanup();
  resetI18nForTests();
  vi.unstubAllGlobals();
});

describe('guard heuristics', () => {
  it('hyphenated compounds and z. B. count as German; header names do not', () => {
    for (const text of ['Admin-Benutzername', 'Release-Radar', 'z. B. admin', 'z.B. alex']) expect(isGerman(text), text).toBe(true);
    for (const text of ['Content-Type', 'X-Requested-With', 'admin']) expect(isGerman(text), text).toBe(false);
  });

  it('a single lowercase word as JSX text and a lowercase word next to formatCount are open', () => {
    const word = probe('export const A = () => <span>manuell</span>;\n');
    expect(word.edits.map((e) => e.after)).toEqual(["{t('manuell')}"]);
    const count = probe("import { notify } from './utils/notify';\nexport function f(n) { notify.success(`${formatCount(n, 'Eintrag', 'Einträge')} korrigiert`); }\n");
    expect(count.edits.map((e) => e.after)).toEqual(["t('{count} korrigiert', { count: formatCount(n, 'Eintrag', 'Einträge') })"]);
  });

  it('R9: a raw number before a noun must use tn(); formatCount output and tn() pass', () => {
    const head = "import { t, tn } from './i18n/index.js';\n";
    expect(probe(`${head}export const a = (n) => t('{count} Bände', { count: n });\n`).manual.map((m) => m.rule)).toEqual(['R9']);
    expect(probe(`${head}export const a = (n) => t('{count} Reihen', { count: formatNumber(n) });\n`).manual.map((m) => m.rule)).toEqual(['R9']);
    expect(probe(`${head}export const a = (n) => t('{volumes} im Besitz', { volumes: formatCount(n, 'Band', 'Bände') });\n`).manual).toEqual([]);
    expect(probe(`${head}export const a = (n) => tn('{n} Band', '{n} Bände', n);\n`).manual).toEqual([]);
    expect(probe(`${head}export const a = (n) => t('{count} Vorbestellt', { count: n });\n`).manual).toEqual([]);
  });

  it('R8: the item of a .map() over a stored-value list shown in an <option> is open', () => {
    const raw = probe('export const A = () => <select>{MANGA_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select>;\n');
    expect(raw.manual.map((m) => m.rule)).toEqual(['R8']);
    const labelled = probe('export const A = () => <select>{MANGA_STATUSES.map((s) => <option key={s} value={s}>{mangaStatusLabel(s)}</option>)}</select>;\n');
    expect(labelled.manual).toEqual([]);
    expect(probe('export const A = () => <select>{publishers.map((p) => <option key={p}>{p}</option>)}</select>;\n').manual).toEqual([]);
  });
});

describe('stored values are shown through enumLabels', () => {
  const en = () => __setCatalogForTests('en', { Laufend: 'Ongoing', Neuwertig: 'Like new', Vorbestellt: 'Pre-ordered' }, { languages: ['en-GB'] });

  it('VolumeFilterBar: condition presets translated, free text and values unchanged', () => {
    en();
    render(<VolumeFilterBar {...filterProps()} conditionsList={['Neuwertig', 'Eigener Zustand']} />);
    const options = [...screen.getByLabelText('Zustand filtern').querySelectorAll('option')].map((o) => [o.value, o.textContent]);
    expect(options).toContainEqual(['Neuwertig', 'Like new']);
    expect(options).toContainEqual(['Eigener Zustand', 'Eigener Zustand']);
  });

  it('AddMangaModal: series status options show the label, the value stays German', () => {
    en();
    render(<AddMangaModal isOpen onClose={vi.fn()} onSuccess={vi.fn()} onSeriesCreated={vi.fn()} />);
    const option = [...screen.getByLabelText('Status').querySelectorAll('option')].find((o) => o.value === 'Laufend');
    expect(option.textContent).toBe('Ongoing');
  });

  it('MpTimeline: the ordered badge shows the status label', () => {
    en();
    const items = [{ id: 1, title: 'Berserk', volume_number: '42', publisher: 'Panini', date: '2026-10-02', price: 12, is_digital: false, in_collection: true, user_manga_id: 4, match_kind: 'exact', user_volume_status: 'Vorbestellt' }];
    render(
      <MemoryRouter>
        <MpTimeline
          mpData={{ items }} loadingMp={false} mpError={null} onRetry={vi.fn()} mpYear={2026} mpMonth={10} canEdit onImport={vi.fn()}
          GERMAN_MONTHS={GERMAN_MONTHS} mpDateGroups={groupMpItemsByDate(items)} filtersActive={false} onResetFilters={vi.fn()}
        />
      </MemoryRouter>
    );
    expect(screen.getByText('Pre-ordered')).toBeTruthy();
    expect(screen.queryByText('Vorbestellt')).toBe(null);
  });
});

describe('counted nouns use tn()', () => {
  it('German stays byte-identical (also for one); English follows the plural rules', () => {
    expect(seriesSummary({ status: 'Laufend' }, { owned: 2, total: 0, extras: 3 }, { read: 0 })).toContain('3 Extras');
    expect(seriesSummary({ status: 'Laufend' }, { owned: 2, total: 0, extras: 1 }, { read: 0 })).toContain('1 Extras');
    expect(aboveTotalText(14, 1)).toBe('Folge 14 liegt über den 1 Folgen dieses Eintrags.');
    __setCatalogForTests('en', { '{n} Extras|{n} Extras': { one: '{n} extra', other: '{n} extras' } }, { languages: ['en-GB'] });
    const summary = seriesSummary({ status: 'Laufend' }, { owned: 2, total: 0, extras: 1 }, { read: 0 });
    expect(summary).toContain('1 extra');
    expect(summary).not.toContain('extras');
  });
});

describe('server texts', () => {
  it('plain string params are user content and stay as sent; nested messages are translated', () => {
    __setCatalogForTests('en', {
      'Die Reihe „{title}“ liegt im Papierkorb': 'The series “{title}” is in the trash',
      Schuber: 'box set',
      '{field} ist ungültig': '{field} is invalid',
      Vorhanden: 'Owned'
    });
    expect(serverText({ error: 'Die Reihe „Schuber“ liegt im Papierkorb', msg: 'Die Reihe „{title}“ liegt im Papierkorb', params: { title: 'Schuber' } }))
      .toBe('The series “Schuber” is in the trash');
    expect(serverText({ error: 'Vorhanden ist ungültig', msg: '{field} ist ungültig', params: { field: { msg: 'Vorhanden', params: {} } } })).toBe('Owned is invalid');
  });

  it('a hidden 500 never shows its template, also when the server still sends one', () => {
    __setCatalogForTests('en', { 'Interner Serverfehler': 'Internal server error', 'Nicht genug Speicherplatz ({free})': 'Not enough space ({free})' });
    expect(serverText({ error: 'Interner Serverfehler', code: 'INTERNAL_ERROR', msg: 'Nicht genug Speicherplatz ({free})', params: { free: '1 MB' } }))
      .toBe('Internal server error');
    __setCatalogForTests('de');
    expect(serverText({ error: 'Interner Serverfehler', code: 'INTERNAL_ERROR', msg: 'x {free}', params: { free: 1 } })).toBe('Interner Serverfehler');
  });

  it('the collecting values the server names in messages are catalog keys', () => {
    const { keys } = extract();
    for (const value of COLLECTING_VALUES) expect(keys.has(value), value).toBe(true);
  });
});

describe('radar', () => {
  it('release dates: German hand-built, other languages in their own order', () => {
    expect(formatReleaseDate('2026-10-1')).toBe('01.10.2026');
    expect(formatReleaseDate('2026-3')).toBe('03.2026');
    __setCatalogForTests('en', {}, { languages: ['en-US'] });
    expect(formatReleaseDate('2026-10-01')).toBe('10/01/2026');
    expect(formatReleaseDate('2026-3')).toBe('03/2026');
    expect(formatReleaseDate('2026')).toBe('2026');
    expect(formatReleaseDate('Herbst 2026')).toBe('Herbst 2026');
    __setCatalogForTests('en', {}, { languages: ['en-GB'] });
    expect(formatReleaseDate('2026-10-01')).toBe('01/10/2026');
  });

  it('the phone label of the calendar tab has its own short key', () => {
    __setCatalogForTests('en', { Neuheiten: 'New releases', 'short::Neuheiten': 'New' });
    render(<RadarTabs radarSubView="passion" setRadarSubView={vi.fn()} radarData={null} mpCount={210} mpYear={2026} mpMonth={10} />);
    expect(screen.getByText('New').className).toContain('lg:hidden');
    cleanup();
    __setCatalogForTests('de');
    render(<RadarTabs radarSubView="passion" setRadarSubView={vi.fn()} radarData={null} mpCount={210} mpYear={2026} mpMonth={10} />);
    expect(screen.getByText('Neuheiten').className).toContain('lg:hidden');
  });
});

function filterProps() {
  return {
    availablePublishers: [], baseVolumesForType: [], currentReaderReadCount: 0, currentReaderUnreadCount: 0, detectedGaps: [],
    handleResetFilters: vi.fn(), handleSetVolumeViewMode: vi.fn(), handleToggleShowGaps: vi.fn(), hasActiveFilters: false,
    missingCount: 0, mpGapData: null, mpGapLoading: false, ownedCount: 0, preorderedCount: 0, regularVolumeCount: 0,
    schuberCount: 0, setShowMpEditionModal: vi.fn(), setVolumeConditionFilter: vi.fn(), setVolumeFilter: vi.fn(),
    setVolumePublisherFilter: vi.fn(), setVolumeSearch: vi.fn(), setVolumeSort: vi.fn(), setVolumeTypeFilter: vi.fn(),
    showGaps: false, specialCount: 0, specialEditionCount: 0, upcomingCount: 0, volumeConditionFilter: 'ALL', volumeFilter: 'ALL',
    volumePublisherFilter: 'ALL', volumeSearch: '', volumeSort: 'number_asc', volumeTypeFilter: 'ALL', volumeViewMode: 'grid', volumes: []
  };
}
