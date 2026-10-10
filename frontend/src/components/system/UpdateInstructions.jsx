import { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { t } from '../../i18n/index.js';
import { rich } from '../../i18n/react.jsx';
import { DEFAULT_IMAGE, README_UPDATING_URL, RELEASES_URL, runningOptions } from './updateModel.js';

const download = (version, file) => `${RELEASES_URL}/download/v${version}/${file}`;

const isArm = (platform) => /arm64|aarch64/.test(String(platform || ''));
const debFile = (version, platform) => `manga-shelf-server_${version}-1_${isArm(platform) ? 'arm64' : 'amd64'}.deb`;
const rpmFile = (version, platform) => `manga-shelf-server-${version}-1.${isArm(platform) ? 'aarch64' : 'x86_64'}.rpm`;
const curl = (version, file) => `curl -LO ${download(version, file)}`;
const code = (text) => <code>{text}</code>;

const KIND_ALIASES = {
  packages: 'package', 'install-service': 'service', 'linux-service': 'service', 'windows-task': 'windows', zip: 'source'
};

/** Copyable steps for an install that cannot replace itself: [{ key, lead, command, link: { href, title } }] (lead and title: text or nodes) for the chosen version. */
export function instructionSteps({ install, version, latest, releaseUrl, platform }) {
  const info = install?.instructions || {};
  const raw = String(info.kind || install?.mode || '');
  const kind = KIND_ALIASES[raw] || raw;
  const args = runningOptions(info.argv);
  const withArgs = (cmd) => (args ? `${cmd} ${args}` : cmd);
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
      command: withArgs(`${file} install-service`)
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

/** One copyable block per step of the manual update for the chosen version. */
export default function UpdateInstructions({ install, version, latest, releaseUrl, platform }) {
  const steps = instructionSteps({ install, version, latest, releaseUrl, platform });
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
