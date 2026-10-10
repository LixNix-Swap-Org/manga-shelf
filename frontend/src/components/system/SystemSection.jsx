/** Card of the system page: heading with an icon on the left, an `actions` slot on the right. */
export function Section({ id, title, Icon, children, actions, busy = false }) {
  return (
    <section aria-labelledby={id} aria-busy={busy || undefined} className="p-4 rounded-2xl bg-slate-900/40 border border-slate-800 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 id={id} className="text-sm font-bold text-white flex items-center gap-2">
          <Icon className="w-4 h-4 text-brand-400" aria-hidden="true" /> {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Label/value grid; falsy rows are left out. */
export function Facts({ rows }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
      {rows.filter(Boolean).map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3 min-w-0 border-b border-slate-800/60 pb-1">
          <dt className="text-slate-400 shrink-0">{label}</dt>
          <dd className="text-slate-200 text-right min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
