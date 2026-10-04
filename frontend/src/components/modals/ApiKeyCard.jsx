import { useId, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, KeyRound } from 'lucide-react';
import { formatRelative } from '../../utils/format';

/** Format check of core/sources/guides.js on the client: null when fine, else the message (nothing is sent). */
export function keyFormatError(guide, secret) {
  const value = typeof secret === 'string' ? secret.trim() : '';
  if (!value) return `Bitte ${guide.secretLabel} eingeben.`;
  const ok = value.length >= (guide.minLength || 1) && new RegExp(guide.pattern).test(value);
  return ok ? null : guide.formatError;
}

/** A step's link with {field} filled in, null while the field is missing or wrong. */
export function stepLink(step, fields, steps) {
  if (!step.linkTemplate) return null;
  let missing = false;
  const url = step.linkTemplate.replace(/\{(\w+)\}/g, (_, name) => {
    const value = String(fields[name] || '').trim();
    const asking = steps.find((s) => s.input === name);
    if (!value || (asking?.inputPattern && !new RegExp(asking.inputPattern).test(value))) missing = true;
    return encodeURIComponent(value);
  });
  return missing ? null : url;
}

function stateText(state) {
  if (!state?.configured) return 'nicht verbunden';
  if (state.from_env) return 'aus der Umgebung gesetzt';
  if (state.last_error) return state.last_error;
  const ok = state.last_ok_at ? formatRelative(state.last_ok_at) : null;
  return `verbunden als ${state.label || `…${state.last4 || ''}`}${ok ? ` · zuletzt ok ${ok}` : ''}`;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary text-[11px] py-1 px-2 inline-flex items-center gap-1"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch (_) { /* no clipboard: the text stays selectable */ }
      }}
    >
      {copied ? <Check className="w-3 h-3" aria-hidden="true" /> : <Copy className="w-3 h-3" aria-hidden="true" />} {copied ? 'Kopiert' : 'Kopieren'}
    </button>
  );
}

/**
 * One provider: state, step-by-step guide (links open in a new tab, copy buttons, the AniList client id that builds
 * the sign-in link), the key field with a format check before sending, "Prüfen & speichern" and "Entfernen".
 * `onSave(secret, { allowBackground })` resolves true when stored; the field is emptied then.
 */
export default function ApiKeyCard({ guide, state, scope = 'user', onSave, onRemove, onToggleBackground, busy }) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState({});
  const [secret, setSecret] = useState('');
  const [allowBackground, setAllowBackground] = useState(Boolean(state?.allow_background));
  const [error, setError] = useState('');
  const fromEnv = Boolean(state?.from_env);

  const submit = async (e) => {
    e.preventDefault();
    const wrong = keyFormatError(guide, secret);
    if (wrong) {
      setError(wrong);
      return;
    }
    setError('');
    const saved = await onSave(secret.trim(), { allowBackground });
    if (saved === true) setSecret('');
    else if (typeof saved === 'string') setError(saved);
  };

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4" aria-labelledby={`${ids}-title`} data-provider={guide.id}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 id={`${ids}-title`} className="text-sm font-bold text-white flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-brand-400" aria-hidden="true" /> {guide.name}
          </h4>
          <p className={`text-xs mt-0.5 ${state?.last_error ? 'text-rose-300' : state?.configured ? 'text-emerald-300' : 'text-slate-400'}`} data-testid="key-state">{stateText(state)}</p>
        </div>
        {state?.configured && !fromEnv && onRemove && (
          <button type="button" className="btn-secondary text-xs" onClick={onRemove} disabled={busy}>Entfernen</button>
        )}
      </div>
      <p className="text-xs text-slate-400 mt-2">{guide.benefit}</p>

      <button type="button" className="mt-2 text-xs text-brand-300 hover:text-brand-200 inline-flex items-center gap-1" aria-expanded={open} aria-controls={`${ids}-steps`} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />} Schritt-für-Schritt-Anleitung
      </button>
      {open && (
        <ol id={`${ids}-steps`} className="mt-2 space-y-2 list-decimal pl-5 text-xs text-slate-300">
          {guide.steps.map((step, i) => {
            const link = stepLink(step, fields, guide.steps);
            return (
              <li key={i} className="space-y-1">
                <p>{step.text}</p>
                {step.link && <a href={step.link} target="_blank" rel="noreferrer noopener" className="text-brand-300 hover:text-brand-200 inline-flex items-center gap-1 break-all">{step.link} <ExternalLink className="w-3 h-3 shrink-0" aria-hidden="true" /></a>}
                {step.copy && (
                  <span className="flex items-center gap-2 flex-wrap">
                    <code className="bg-slate-950 border border-slate-800 rounded px-1.5 py-0.5 break-all select-all">{step.copy}</code>
                    <CopyButton text={step.copy} />
                  </span>
                )}
                {step.input && (
                  <span className="block">
                    <label htmlFor={`${ids}-${step.input}`} className="sr-only">{step.inputLabel || step.input}</label>
                    <input
                      id={`${ids}-${step.input}`}
                      className="input-field text-base sm:text-xs w-40"
                      inputMode="numeric"
                      placeholder={step.inputLabel}
                      value={fields[step.input] || ''}
                      onChange={(e) => setFields((f) => ({ ...f, [step.input]: e.target.value }))}
                    />
                  </span>
                )}
                {step.linkTemplate && (link
                  ? <a href={link} target="_blank" rel="noreferrer noopener" className="text-brand-300 hover:text-brand-200 inline-flex items-center gap-1 break-all" data-testid="authorize-link">Anmeldelink öffnen <ExternalLink className="w-3 h-3" aria-hidden="true" /></a>
                  : <span className="text-slate-400">(der Anmeldelink entsteht aus der Client-ID)</span>)}
              </li>
            );
          })}
        </ol>
      )}
      {guide.warning && <p className="text-[11px] text-amber-300 mt-3">{guide.warning}</p>}

      {fromEnv ? (
        <p className="text-[11px] text-slate-400 mt-3">Dieser Schlüssel kommt aus der Server-Umgebung und lässt sich hier nicht ändern.</p>
      ) : (
        <form onSubmit={submit} className="mt-3 space-y-2" noValidate>
          <label htmlFor={`${ids}-secret`} className="block text-[11px] text-slate-400">{guide.secretLabel} ({guide.secretHint})</label>
          <div className="flex gap-2">
            <input
              id={`${ids}-secret`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="input-field text-base sm:text-xs flex-1 min-w-0"
              value={secret}
              onChange={(e) => { setSecret(e.target.value); setError(''); }}
            />
            <button type="submit" className="btn-primary text-xs whitespace-nowrap" disabled={busy}>{busy ? 'Prüfe…' : 'Prüfen & speichern'}</button>
          </div>
          {scope === 'user' && (
            <label className="flex items-center gap-2 text-[11px] text-slate-300">
              <input
                type="checkbox"
                checked={allowBackground}
                onChange={(e) => {
                  setAllowBackground(e.target.checked);
                  if (state?.configured && onToggleBackground) onToggleBackground(e.target.checked);
                }}
              />
              Auch für automatische Aktualisierungen verwenden
            </label>
          )}
          {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
        </form>
      )}
    </section>
  );
}
