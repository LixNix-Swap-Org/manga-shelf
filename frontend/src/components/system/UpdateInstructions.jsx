import { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { t } from '../../i18n/index.js';
import { rich } from '../../i18n/react.jsx';
import { DEFAULT_IMAGE, README_UPDATING_URL, RELEASES_URL, runningOptions, shellQuote } from './updateModel.js';

const download = (version, file) => `${RELEASES_URL}/download/v${version}/${file}`;

const isArm = (platform) => /arm64|aarch64/.test(String(platform || ''));
const debFile = (version, platform) => `manga-shelf-server_${version}-1_${isArm(platform) ? 'arm64' : 'amd64'}.deb`;
const rpmFile = (version, platform) => `manga-shelf-server-${version}-1.${isArm(platform) ? 'aarch64' : 'x86_64'}.rpm`;
const curl = (version, file) => `curl -LO ${download(version, file)}`;
const code = (text) => <code>{text}</code>;

const KIND_ALIASES = {
  packages: 'package', 'install-service': 'service', 'linux-service': 'service', 'windows-task': 'windows', zip: 'source'
};

const SERVICE_USER = 'manga-shelf';
const PACKAGE_BINARY = '/usr/bin/manga-shelf-server';
const PACKAGE_DATA_DIR = '/var/lib/manga-shelf';
// i18n-ignore: task name written by install-service
const WINDOWS_TASK = 'Manga Shelf Server';
// i18n-ignore: executable paths of the desktop app
const DESKTOP_LAUNCH = {
  darwin: { os: 'macOS', command: 'ALLOW_NEWER_SCHEMA=1 "/Applications/Manga Shelf.app/Contents/MacOS/Manga Shelf"' },
  win32: { os: 'Windows', command: 'set ALLOW_NEWER_SCHEMA=1\n"%LOCALAPPDATA%\\Programs\\Manga Shelf\\Manga Shelf.exe"' },
  linux: { os: 'Linux', command: 'ALLOW_NEWER_SCHEMA=1 manga-shelf' }
};

const winQuote = (arg) => (/[\s&()^%!"]/.test(String(arg)) ? `"${String(arg).replace(/"/g, '')}"` : String(arg));

const withOptions = (command, argv, quote = shellQuote) => {
  const options = runningOptions(argv, quote);
  return options ? `${command} ${options}` : command;
};

function dataDirOf(argv) {
  if (!Array.isArray(argv)) return '';
  const i = argv.indexOf('--data-dir');
  return i >= 0 && typeof argv[i + 1] === 'string' ? argv[i + 1] : '';
}

function binaryFile(install, platform) {
  if (install?.asset) return install.asset;
  const os = String(platform || '');
  if (os.startsWith('win32')) return 'manga-shelf-server-windows-x64.exe';
  if (os.startsWith('darwin')) return 'manga-shelf-server-macos-universal';
  return `manga-shelf-server-linux-${isArm(platform) ? 'arm64' : 'x64'}`;
}

function downgradeSteps({ kind, install, version, releaseUrl, platform, schemaChanged, backup }) {
  const withArgs = (cmd) => withOptions(cmd, install?.instructions?.argv);
  const withWinArgs = (cmd) => withOptions(cmd, install?.instructions?.argv, winQuote);
  const zip = backup ? shellQuote(backup) : '<backup.zip>';
  const restoreStep = (command) => ({ key: 'restore', lead: t('Backup von vor dem Update einspielen:'), command });
  const stopStep = (command) => (command ? { key: 'stop', lead: t('Server stoppen:'), command } : { key: 'stop', lead: t('Zuerst den Server stoppen.') });
  const zipParams = { version, data: code('data/'), env: code('.env'), ssl: code('ssl/') };
  const zipLink = { href: download(version, 'pterodactyl-manga-shelf.zip'), title: 'pterodactyl-manga-shelf.zip' };

  if (kind === 'docker') {
    const image = `image: ${install?.image || DEFAULT_IMAGE}:${version}`;
    const readme = { key: 'docker-run', link: { href: README_UPDATING_URL, title: rich('Mit {command} gestartet: README', { command: code('docker run') }) } };
    if (!schemaChanged) {
      return [{ key: 'docker', lead: rich('In {file} diese Zeile eintragen, dann den Container neu starten:', { file: code('docker-compose.yml') }), command: `${image}\ndocker compose up -d` }, readme];
    }
    return [
      stopStep('docker compose stop'),
      { key: 'docker', lead: rich('In {file} diese Zeile eintragen:', { file: code('docker-compose.yml') }), command: image },
      // i18n-ignore: admin.js command name
      restoreStep(`docker compose run --rm manga-shelf node scripts/admin.js wiederherstellen ${zip}`),
      { key: 'start', lead: t('Server starten:'), command: 'docker compose up -d' },
      readme
    ];
  }
  if (kind === 'deb' || kind === 'rpm' || kind === 'package') {
    const steps = [];
    if (kind !== 'rpm') steps.push({ key: 'deb', lead: 'Debian/Ubuntu', command: `${curl(version, debFile(version, platform))} && sudo apt install --allow-downgrades ./${debFile(version, platform)}` });
    if (kind !== 'deb') steps.push({ key: 'rpm', lead: 'Fedora/RHEL', command: `${curl(version, rpmFile(version, platform))} && sudo dnf downgrade ./${rpmFile(version, platform)}` });
    if (!schemaChanged) return steps;
    return [
      ...steps,
      stopStep('sudo systemctl stop manga-shelf'),
      restoreStep(`sudo -u ${SERVICE_USER} ${PACKAGE_BINARY} restore ${zip} --data-dir ${PACKAGE_DATA_DIR}`),
      { key: 'start', lead: t('Server starten:'), command: 'sudo systemctl start manga-shelf' }
    ];
  }
  if (kind === 'service') {
    const file = install?.asset || `manga-shelf-server-linux-${isArm(platform) ? 'arm64' : 'x64'}`;
    const dir = dataDirOf(install?.instructions?.argv);
    const fetchStep = { key: 'download', lead: t('Datei von v{version} laden:', { version }), command: `${curl(version, file)} && chmod +x ${file}` };
    const installStep = { key: 'service', lead: t('Dienst mit dieser Datei neu einrichten und starten:'), command: withArgs(`sudo ./${file} install-service`) };
    if (!schemaChanged) return [fetchStep, installStep];
    return [
      fetchStep,
      stopStep('sudo systemctl stop manga-shelf'),
      restoreStep(`sudo -u ${SERVICE_USER} ./${file} restore ${zip}${dir ? ` --data-dir ${shellQuote(dir)}` : ''}`),
      installStep
    ];
  }
  if (kind === 'windows') {
    const file = install?.asset || 'manga-shelf-server-windows-x64.exe';
    const dir = dataDirOf(install?.instructions?.argv);
    if (!schemaChanged) {
      return [{ key: 'windows', lead: t('Datei laden, dann in einer Eingabeaufforderung als Administrator:'), link: { href: download(version, file), title: file }, command: withWinArgs(`${file} install-service`) }];
    }
    return [
      { key: 'download', lead: t('Datei von v{version} laden:', { version }), link: { href: download(version, file), title: file } },
      { key: 'stop', lead: t('Server stoppen (Eingabeaufforderung als Administrator):'), command: `schtasks /End /TN "${WINDOWS_TASK}"` },
      restoreStep(`${file} restore ${backup ? winQuote(backup) : zip}${dir ? ` --data-dir ${winQuote(dir)}` : ''}`),
      { key: 'service', lead: t('Dienst mit dieser Datei neu einrichten und starten:'), command: withWinArgs(`${file} install-service`) }
    ];
  }
  if (kind === 'binary' || kind === 'sea-user') {
    const file = binaryFile(install, platform);
    const windows = /\.exe$/i.test(file);
    const run = windows ? file : `./${file}`;
    const dir = dataDirOf(install?.instructions?.argv);
    const steps = [windows
      ? { key: 'download', lead: t('Datei von v{version} laden:', { version }), link: { href: download(version, file), title: file } }
      : { key: 'download', lead: t('Datei von v{version} laden:', { version }), command: `${curl(version, file)} && chmod +x ${file}` }];
    steps.push(stopStep(''));
    if (schemaChanged) {
      const dirArg = dir ? ` --data-dir ${windows ? winQuote(dir) : shellQuote(dir)}` : '';
      steps.push(restoreStep(`${run} restore ${windows && backup ? winQuote(backup) : zip}${dirArg}`));
    }
    steps.push({ key: 'start', lead: t('Server mit dieser Datei starten:'), command: windows ? withWinArgs(run) : withArgs(run) });
    return steps;
  }
  if (kind === 'source') {
    const steps = [];
    if (schemaChanged) steps.push(stopStep(''));
    steps.push(
      { key: 'source', lead: rich('Code von v{version} holen – im Git-Checkout mit diesem Befehl, sonst das ZIP über die Programmdateien entpacken ({data}, {env} und {ssl} bleiben):', zipParams), link: zipLink, command: `git checkout v${version}` },
      { key: 'deps', lead: t('Abhängigkeiten installieren:'), command: 'npm ci --omit=dev' },
      { key: 'build', lead: t('Im Git-Checkout zusätzlich das Web-Portal bauen:'), command: '(cd frontend && npm ci && npm run build)' }
    );
    // i18n-ignore: admin.js command name
    if (schemaChanged) steps.push(restoreStep(`node scripts/admin.js wiederherstellen ${zip}`));
    steps.push({ key: 'start', lead: t('Server starten:'), command: 'npm start' });
    return steps;
  }
  if (kind === 'desktop') {
    const steps = [{ key: 'desktop', lead: t('Desktop-App beenden und v{version} installieren:', { version }), link: { href: releaseUrl || RELEASES_URL, title: t('Download-Seite von v{version}', { version }) } }];
    if (!schemaChanged) return steps;
    const os = String(platform || '').split('/')[0];
    const launches = DESKTOP_LAUNCH[os] ? [DESKTOP_LAUNCH[os]] : Object.values(DESKTOP_LAUNCH);
    for (const launch of launches) {
      steps.push({ key: `launch-${launch.os}`, lead: t('Einmal mit ALLOW_NEWER_SCHEMA=1 starten ({os}):', { os: launch.os }), command: launch.command });
    }
    steps.push({ key: 'restore', lead: rich('Sofort im Backups-Dialog {file} einspielen und vorher nichts ändern; danach die App normal neu starten.', { file: code(backup || 'vor-update-….zip') }) });
    return steps;
  }
  if (kind === 'pterodactyl') {
    const steps = [{ key: 'pterodactyl', lead: rich('Bei gestopptem Server das ZIP von v{version} mit dem Dateimanager des Panels über die Programmdateien entpacken ({data}, {env} und {ssl} bleiben):', zipParams), link: zipLink }];
    if (!schemaChanged) {
      steps.push({ key: 'start', lead: t('Dann den Server im Panel starten.') });
      return steps;
    }
    steps.push({
      key: 'env',
      lead: rich('In {file} diese Zeile eintragen, den Server starten und sofort im Backups-Dialog {backup} einspielen; vorher nichts ändern. Danach die Zeile wieder entfernen.', { file: code('.env'), backup: code(backup || 'vor-update-….zip') }),
      command: 'ALLOW_NEWER_SCHEMA=1'
    });
    return steps;
  }
  return [];
}

/**
 * Copyable steps for an install that cannot replace itself: [{ key, lead, command, link: { href, title } }] (lead and title: text or nodes) for the chosen version;
 * `downgrade: { schemaChanged, backup }` gives the steps back to the version before the last update.
 */
export function instructionSteps({ install, version, latest, releaseUrl, platform, downgrade = null }) {
  const info = install?.instructions || {};
  const raw = String(info.kind || install?.mode || '');
  const kind = KIND_ALIASES[raw] || raw;
  const withArgs = (cmd) => withOptions(cmd, info.argv);
  if (downgrade) {
    return downgradeSteps({ kind, install, version, releaseUrl, platform, schemaChanged: Boolean(downgrade.schemaChanged), backup: downgrade.backup || null });
  }
  if (kind === 'docker') {
    const image = install?.image || DEFAULT_IMAGE;
    const steps = version === latest
      ? [{ key: 'docker', lead: t('Neues Image holen und den Container neu starten:'), command: 'docker compose pull && docker compose up -d' }]
      : [{ key: 'docker', lead: rich('In {file} diese Zeile eintragen, dann den Container neu starten:', { file: code('docker-compose.yml') }), command: `image: ${image}:${version}\ndocker compose up -d` }];
    steps.push({ key: 'docker-run', link: { href: README_UPDATING_URL, title: rich('Mit {command} gestartet: README', { command: code('docker run') }) } });
    return steps;
  }
  if (kind === 'deb' || kind === 'rpm' || kind === 'package') {
    const steps = [];
    if (kind !== 'rpm') steps.push({ key: 'deb', lead: 'Debian/Ubuntu', command: `${curl(version, debFile(version, platform))} && sudo apt install ./${debFile(version, platform)}` });
    if (kind !== 'deb') steps.push({ key: 'rpm', lead: 'Fedora/RHEL', command: `${curl(version, rpmFile(version, platform))} && sudo dnf install ./${rpmFile(version, platform)}` });
    return steps;
  }
  if (kind === 'service') {
    const file = install?.asset || `manga-shelf-server-linux-${isArm(platform) ? 'arm64' : 'x64'}`;
    return [{
      key: 'service',
      lead: t('Neue Datei laden und den Dienst neu einrichten:'),
      command: `${curl(version, file)} && chmod +x ${file} && ${withArgs(`sudo ./${file} install-service`)}`
    }];
  }
  if (kind === 'windows') {
    const file = install?.asset || 'manga-shelf-server-windows-x64.exe';
    return [{
      key: 'windows',
      lead: t('Datei laden, dann in einer Eingabeaufforderung als Administrator:'),
      link: { href: download(version, file), title: file },
      command: withOptions(`${file} install-service`, info.argv, winQuote)
    }];
  }
  if (kind === 'desktop') {
    return [{
      key: 'desktop',
      lead: t('Dieser Server läuft in der Desktop-App. Dort die neue Version installieren:'),
      link: { href: releaseUrl || RELEASES_URL, title: t('Download-Seite von v{version}', { version }) }
    }];
  }
  if (kind === 'source') {
    return [{
      key: 'source',
      lead: rich('ZIP laden, über die Programmdateien entpacken ({data}, {env} und {ssl} bleiben), dann installieren und den Server neu starten:', {
        data: code('data/'), env: code('.env'), ssl: code('ssl/')
      }),
      link: { href: download(version, 'pterodactyl-manga-shelf.zip'), title: 'pterodactyl-manga-shelf.zip' },
      command: 'npm ci --omit=dev'
    }];
  }
  const command = typeof info.command === 'string' ? info.command.trim() : '';
  const url = typeof info.url === 'string' && /^https:\/\//.test(info.url) ? info.url : '';
  if (!command && !url) return [];
  return [{ key: 'manual', lead: t('So aktualisierst du diesen Server:'), command, link: url ? { href: url, title: url } : null }];
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary text-[11px] py-1 px-2 inline-flex items-center gap-1 shrink-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch (_) { /* no clipboard: the text stays selectable */ }
      }}
    >
      {copied ? <Check className="w-3 h-3" aria-hidden="true" /> : <Copy className="w-3 h-3" aria-hidden="true" />} {copied ? t('Kopiert') : t('Kopieren')}
    </button>
  );
}

/** One copyable block per step of the manual update (or of the way back with `downgrade`) for the chosen version. */
export default function UpdateInstructions({ install, version, latest, releaseUrl, platform, downgrade = null }) {
  const steps = instructionSteps({ install, version, latest, releaseUrl, platform, downgrade });
  if (!steps.length) return null;
  return (
    <div className="space-y-2" data-testid="update-instructions">
      {steps.map((step) => (
        <div key={step.key} className="space-y-1">
          {step.lead && <p className="text-xs text-slate-300">{step.lead}</p>}
          {step.link && (
            <a href={step.link.href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-brand-300 underline break-all">
              {step.link.title} <ExternalLink className="w-3 h-3 shrink-0" aria-hidden="true" />
            </a>
          )}
          {step.command && (
            <div className="flex items-start gap-2">
              <pre className="flex-1 min-w-0 overflow-x-auto rounded-lg bg-slate-950/70 border border-slate-800 p-2 text-[11px] text-slate-200"><code>{step.command}</code></pre>
              <CopyButton text={step.command} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
