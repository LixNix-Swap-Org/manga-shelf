/** Busy indicator that screen readers announce; `className` sets size and colour of the ring. */
export default function Spinner({ label = 'Lädt…', className = 'w-8 h-8 border-2 border-brand-500 border-t-transparent' }) {
  return (
    <span role="status" className="inline-flex">
      <span className={`block rounded-full animate-spin ${className}`} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
