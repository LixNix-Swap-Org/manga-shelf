// @vitest-environment node
// Static checks of index.css, index.html and the Tailwind output: 16px inputs, touch targets, z-index layers.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import config from '../../tailwind.config.js';

const root = path.resolve(import.meta.dirname, '../..');
const srcDir = path.join(root, 'src');
const cssSource = fs.readFileSync(path.join(srcDir, 'index.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const sourceFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
  return /\.(jsx?|tsx?)$/.test(entry.name) ? [full] : [];
});

const NO_ZOOM_TYPES = new Set(['checkbox', 'radio', 'file', 'hidden', 'range', 'color', 'submit', 'button']);
// unprefixed size classes of 16px and more, or a class whose CSS is checked to be 16px on phones
const PHONE_16PX = /(?<![\w:-])(text-(base|lg|xl|2xl|\[16px\]|\[1rem\])|input-field|filter-chip-select)(?![\w-])/;

// opening tags of <input>, <select> and <textarea>; `>` inside {…} or quotes does not end a tag
function formControls(text) {
  const found = [];
  for (const m of text.matchAll(/<(input|select|textarea)\b/g)) {
    let depth = 0;
    let quote = null;
    let i = m.index + m[0].length;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote && text[i - 1] !== '\\') quote = null;
      } else if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    found.push({ tag: m[1], source: text.slice(m.index, i + 1), line: text.slice(0, m.index).split('\n').length });
  }
  return found;
}

let css = '';
beforeAll(async () => {
  const content = config.content.map((glob) => path.resolve(root, glob));
  const result = await postcss([tailwindcss({ ...config, content })]).process(cssSource, { from: path.join(srcDir, 'index.css') });
  css = result.css.replace(/\/\*[\s\S]*?\*\//g, '');
}, 60000);

describe('generated Tailwind CSS', () => {
  it('stacks the lightbox above the z-50 dialogs', () => {
    expect(css).toMatch(/\.z-60\s*\{\s*z-index:\s*60/);
    const lightbox = fs.readFileSync(path.join(srcDir, 'components/detail/LightboxGallery.jsx'), 'utf8');
    expect(lightbox).toMatch(/\bz-60\b/);
  });

  it('generates every z-index class used in src', () => {
    const used = new Set();
    for (const file of sourceFiles(srcDir)) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/(?<![\w-])(?:[a-z-]+:)*-?z-(\d+)(?![\w-])/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const n of used) expect(css, `z-${n}`).toMatch(new RegExp(`\\.z-${n}\\s*\\{`));
  });

  it('generates the custom shades, sizes and effects the components use', () => {
    expect(css).toContain('.hover\\:bg-slate-850:hover');
    expect(css).toContain('.via-slate-850');
    for (const cls of ['sm\\:w-13', 'sm\\:h-18', 'sm\\:w-18', 'sm\\:h-26']) expect(css, cls).toContain(`.${cls}`);
    expect(css).toContain('.shadow-xs');
    expect(css).toMatch(/@keyframes shake/);
    expect(css).toMatch(/\.animate-shake\s*\{[^}]*animation:\s*shake/);
    expect(css).toContain('.custom-scrollbar');
  });

  it('.btn-primary ends its gradient on a shade that keeps white text at 4.5:1 (no brand-600 stop)', () => {
    const rules = [...css.matchAll(/\.btn-primary(?::hover)?\s*\{[^}]*\}/g)].map((m) => m[0]).join('\n');
    expect(rules).toMatch(/--tw-gradient-to:\s*#0369a1/);
    expect(rules).not.toMatch(/#0284c7/);
  });

  it('declares the dark color scheme', () => {
    expect(css).toMatch(/:root\s*\{\s*color-scheme:\s*dark/);
    expect(html).toMatch(/<meta name="color-scheme" content="dark"/);
  });

  it('keeps the webkit scrollbars in Chromium: scrollbar-color only for browsers without ::-webkit-scrollbar', () => {
    const outside = css.replace(/@supports not selector\(::-webkit-scrollbar\)\s*\{[\s\S]*?\}\s*\}/g, '');
    expect(css).toMatch(/@supports not selector\(::-webkit-scrollbar\)[\s\S]*scrollbar-color/);
    expect(outside).not.toMatch(/scrollbar-color/);
  });
});

describe('focus indicator', () => {
  it('every keyboard focus gets a solid brand-400 outline from the base layer', () => {
    expect(css).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid #38bdf8;\s*outline-offset:\s*2px/);
  });

  it('no !important rule removes outlines, and the selects drop theirs only where :has rings the wrapper', () => {
    expect(cssSource).not.toMatch(/outline:\s*none\s*!important/);
    const outside = css.replace(/@supports selector\(:has\(\*\)\)\s*\{[\s\S]*?\}\s*\}/g, '');
    expect(outside).not.toMatch(/(filter-chip-select|seamless-select):focus-visible[^{]*\{[^}]*outline:\s*none/);
    expect(css).toMatch(/@supports selector\(:has\(\*\)\)\s*\{[^}]*seamless-select:focus-visible[^{]*\{\s*outline:\s*none/);
  });

  it('rings the wrapper of a keyboard-focused select in brand-400', () => {
    expect(css).toMatch(/:has\(> \.filter-chip-select:focus-visible\)[^{]*\{[^}]*box-shadow:\s*0 0 0 2px #38bdf8/);
    expect(css).toMatch(/:has\(> \.seamless-select:focus-visible\)/);
  });
});

describe('shelf spines', () => {
  it('spine rules sit in the components layer, so the focus ring utilities win over the depth shadow', () => {
    const spine = css.search(/\.manga-spine\s*\{/);
    const ring = css.search(/\.ring-2\s*\{/);
    expect(spine).toBeGreaterThan(-1);
    expect(ring).toBeGreaterThan(spine);
    const shelf = fs.readFileSync(path.join(srcDir, 'components/detail/ShelfSpine.jsx'), 'utf8');
    expect(shelf).toMatch(/isFocused \? 'ring-2 ring-brand-400/);
  });

  it('spine and gap hover lifts only apply with a fine pointer (a tapped spine would stay raised on touch)', () => {
    const guard = /@media \(hover: hover\) and \(pointer: fine\)\s*\{\s*([^{}]*)\{[^}]*\}\s*\}/g;
    const guarded = [...css.matchAll(guard)].map((m) => m[1].trim());
    expect(guarded).toContain('.manga-spine:hover');
    expect(guarded).toContain('.manga-spine-ghost:hover');
    const rest = css.replace(guard, '');
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.manga-spine:hover,\s*\.manga-spine-ghost:hover\s*\{[^}]*\}\s*\}/;
    expect(rest).toMatch(reduced);
    expect(rest.replace(reduced, '')).not.toMatch(/\.manga-spine(-ghost)?:hover/);
  });

  it('the Schuber frame does not use outline, so a focused box spine keeps the focus outline', () => {
    expect(css).not.toMatch(/\.manga-spine[\w-]*(?::[\w-]+)?\s*\{[^}]*outline/);
    expect(css).toMatch(/\.manga-spine-box::before\s*\{[^}]*border:\s*1px dashed/);
  });
});

describe('motion, phones and blur', () => {
  it('honours prefers-reduced-motion, keeps spinners turning slowly and stops the spine lift', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/animation-duration:\s*0\.01ms !important/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms !important/);
    expect(block).toMatch(/scroll-behavior:\s*auto !important/);
    expect(block).toMatch(/\.animate-spin\s*\{\s*animation-duration:\s*1\.5s !important;\s*animation-iteration-count:\s*infinite !important/);
    expect(block).toMatch(/\.manga-spine:hover,\s*\.manga-spine-ghost:hover\s*\{\s*transform:\s*none/);
  });

  it('inputs are 16px on phones (no iOS focus zoom) and 14px from sm on', () => {
    const rule = css.match(/\.input-field\s*\{[^}]*\}/)[0];
    expect(rule).toMatch(/font-size:\s*1rem/);
    expect(css).toMatch(/@media \(min-width: 640px\)\s*\{[^@]*\.input-field\s*\{[^}]*font-size:\s*0\.875rem/);
  });

  it('the filter chip selects are 16px on phones and 12px from sm on', () => {
    const rule = css.match(/\.filter-chip-select\s*\{[^}]*\}/)[0];
    expect(rule).toMatch(/font-size:\s*1rem/);
    expect(css).toMatch(/@media \(min-width: 640px\)\s*\{\s*\.filter-chip-select\s*\{[^}]*font-size:\s*0\.75rem/);
  });

  it('every text input, select and textarea is at least 16px on phones', () => {
    const offenders = [];
    for (const file of sourceFiles(srcDir).filter((f) => f.endsWith('.jsx'))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const control of formControls(text)) {
        const type = control.source.match(/\btype=["']([a-z]+)["']/)?.[1];
        if (control.tag === 'input' && NO_ZOOM_TYPES.has(type)) continue;
        if (!PHONE_16PX.test(control.source)) offenders.push(`${path.relative(srcDir, file)}:${control.line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('stops the rubber-band scroll of the installed app', () => {
    expect(css).toMatch(/@media \(display-mode: standalone\)\s*\{\s*html\s*\{\s*overscroll-behavior-y:\s*none/);
  });

  it('repeated cards have no backdrop blur', () => {
    const rule = css.match(/\.glass-card\s*\{[^}]*\}/)[0];
    expect(rule).not.toMatch(/backdrop-filter/);
  });

  it('modals that cap their height use dvh where the browser supports it', () => {
    const offenders = sourceFiles(srcDir).filter((f) => {
      const text = fs.readFileSync(f, 'utf8');
      return /max-h-\[9\dvh\](?! supports-\[height:100dvh\]:max-h-\[9\ddvh\])/.test(text);
    });
    expect(offenders).toEqual([]);
    expect(css).toMatch(/@supports \(height:100dvh\)\s*\{[^}]*max-height:\s*90dvh/);
  });
});

describe('index.html and fonts', () => {
  it('loads no font from Google', () => {
    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    expect(cssSource).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  });

  it('self-hosts Plus Jakarta Sans with files that exist', () => {
    const urls = [...cssSource.matchAll(/@font-face\s*\{[^}]*font-family:\s*'Plus Jakarta Sans'[^}]*url\('([^']+)'\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    for (const url of urls) expect(fs.existsSync(path.join(srcDir, url)), url).toBe(true);
    expect(config.theme.extend.fontFamily.sans[0]).toBe('"Plus Jakarta Sans"');
  });

  it('does not draw under the iOS status bar without safe-area handling', () => {
    const style = html.match(/apple-mobile-web-app-status-bar-style" content="([^"]+)"/)?.[1];
    expect(style).toBeTruthy();
    if (style === 'black-translucent') {
      expect(html).toMatch(/viewport-fit=cover/);
      expect(sourceFiles(srcDir).some((f) => fs.readFileSync(f, 'utf8').includes('safe-area-inset-top'))).toBe(true);
    }
  });
});

describe('dialog overlays', () => {
  const OVERLAY_FILES = [
    'components/modals/AddMangaModal.jsx', 'components/modals/StatsModal.jsx', 'components/modals/BackupRestoreModal.jsx',
    'components/modals/ToolDialog.jsx', 'components/modals/UserManagementModal.jsx', 'components/modals/AccountModal.jsx',
    'components/modals/SystemModal.jsx', 'components/modals/AddAnimeModal.jsx', 'components/detail/VolumeEditModal.jsx',
    'components/detail/GapFillModal.jsx', 'components/detail/BatchAddModal.jsx', 'components/detail/BatchReadModal.jsx',
    'components/detail/MpEditionModal.jsx', 'components/modals/AnimeDetailModal.jsx',
    'components/dashboard/ScanCandidatesDialog.jsx', 'components/dashboard/CsvExchangeModal.jsx',
    'components/common/ConnectQr.jsx'
  ];
  const rule = (selector) => css.match(new RegExp(`(?:^|\\})\\s*${selector.replace(/[.\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] || '';

  it('.dialog-overlay is a full-viewport scroll container that keeps clear of the safe areas', () => {
    const overlay = rule('.dialog-overlay');
    expect(overlay).toMatch(/position:\s*fixed/);
    expect(overlay).toMatch(/inset:\s*0/);
    expect(overlay).toMatch(/overflow-y:\s*auto/);
    expect(overlay).toMatch(/align-items:\s*flex-start/);
    for (const side of ['top', 'right', 'bottom', 'left']) expect(overlay).toContain(`max(0.5rem, env(safe-area-inset-${side}))`);
    expect(css).toMatch(/@media \(min-width: 640px\)\s*\{[^@]*\.dialog-overlay\s*\{[^}]*max\(1rem, env\(safe-area-inset-top\)\)/);
  });

  it('.dialog-box centres with auto margins, so a box taller than the viewport starts at the scroll top', () => {
    const box = rule('.dialog-box');
    expect(box).toMatch(/margin-top:\s*auto/);
    expect(box).toMatch(/margin-bottom:\s*auto/);
    expect(box).toMatch(/flex-shrink:\s*0/);
  });

  it('the short: variant targets landscape phones and outranks the dvh cap and sm: utilities by specificity', () => {
    expect(css).toMatch(/@media \(max-height: 500px\)\s*\{[^@]*:root \.short\\:max-h-none\s*\{\s*max-height:\s*none/);
    expect(css).toMatch(/:root \.short\\:p-4\s*\{\s*padding:\s*1rem/);
    expect(css).toMatch(/:root \.short\\:hidden\s*\{\s*display:\s*none/);
  });

  it('every dialog uses the shared overlay and box instead of a centred flex overlay', () => {
    for (const rel of OVERLAY_FILES) {
      const text = fs.readFileSync(path.join(srcDir, rel), 'utf8');
      expect(text, rel).toMatch(/className="outline-none dialog-overlay /);
      expect(text, rel).toMatch(/className="dialog-box /);
      expect(text, rel).not.toMatch(/fixed inset-0[^"]*(items-center|p-2 sm:p-4|overflow-hidden)/);
      expect(text, rel).not.toMatch(/dialog-box[^"]*\bmy-(3|8|auto)\b/);
    }
  });

  it('.hit-44 keeps an absolutely positioned control where it is (the hit area needs a containing block only)', () => {
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{[^@]*\.hit-44:not\(\.absolute\):not\(\.fixed\):not\(\.sticky\)\s*\{\s*position:\s*relative/);
    expect(css).not.toMatch(/\.hit-44\s*\{\s*position:\s*relative/);
  });

  it('the gallery pads for the safe areas', () => {
    expect(rule('.dialog-safe-area')).toContain('max(0.75rem, env(safe-area-inset-left))');
    const lightbox = fs.readFileSync(path.join(srcDir, 'components/detail/LightboxGallery.jsx'), 'utf8');
    expect(lightbox).toMatch(/fixed inset-0 z-60[^"]*dialog-safe-area/);
  });

  it('a fixed scrim covers the status bar above the bars and the scrolled dialogs, below the toasts', () => {
    const scrim = rule('body::before');
    expect(scrim).toMatch(/position:\s*fixed/);
    expect(scrim).toMatch(/height:\s*env\(safe-area-inset-top\)/);
    expect(scrim).toMatch(/pointer-events:\s*none/);
    const z = Number(scrim.match(/z-index:\s*(\d+)/)?.[1]);
    expect(z).toBe(65);
    // dialogs z-50 / z-[60] / z-60, toasts z-[70]
    expect(z).toBeGreaterThan(60);
    expect(z).toBeLessThan(70);
    const toaster = fs.readFileSync(path.join(srcDir, 'components/common/Toaster.jsx'), 'utf8');
    expect(toaster).toMatch(/z-\[70\]/);
  });

  it('the sticky dashboard header reserves its height at the top for keyboard focus, and scrolls away on short screens', () => {
    expect(css).toMatch(/html:has\(header\[data-sticky-header\]\)\s*\{\s*scroll-padding-top:\s*calc\(var\(--sticky-header-h, 0px\) \+ 0\.5rem\)/);
    expect(css).toMatch(/@media \(max-height: 500px\)\s*\{\s*:root \.short\\:static\s*\{\s*position:\s*static/);
    const header = fs.readFileSync(path.join(srcDir, 'components/dashboard/DashboardHeader.jsx'), 'utf8');
    expect(header).toMatch(/<header ref=\{headerRef\} data-sticky-header="" className="sticky short:static /);
  });

  it('the bottom navigation reserves space only on phones (it stays mounted, hidden, above 640 px)', () => {
    expect(css).toMatch(/@media \(max-width: 639\.98px\)\s*\{\s*html:has\(#bottom-nav\)\s*\{\s*scroll-padding-bottom/);
    const unguarded = css.replace(/@media \(max-width: 639\.98px\)\s*\{[^{}]*\{[^}]*\}\s*\}/g, '');
    expect(unguarded).not.toMatch(/#bottom-nav/);
    expect(unguarded).toMatch(/html:has\(#detail-bottom-bar\)\s*\{\s*scroll-padding-bottom/);
  });

  it('dialogs with a capped height let the whole dialog scroll on short screens', () => {
    for (const rel of ['components/modals/ToolDialog.jsx', 'components/modals/StatsModal.jsx', 'components/modals/BackupRestoreModal.jsx', 'components/detail/VolumeEditModal.jsx', 'components/detail/MpEditionModal.jsx']) {
      const text = fs.readFileSync(path.join(srcDir, rel), 'utf8');
      expect(text, rel).toMatch(/dialog-box[^"]*max-h-\[9\ddvh\] short:max-h-none/);
    }
  });
});
