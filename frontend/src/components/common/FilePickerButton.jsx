import { useRef } from 'react';

/**
 * A real button that opens the browser's file picker, so the picker is reachable by keyboard and named for screen
 * readers; the input itself stays hidden. `onChange` receives the input's change event.
 */
export default function FilePickerButton({
  accept, multiple = false, capture, disabled = false, onChange, className, label, title, id, children
}) {
  const inputRef = useRef(null);
  return (
    <>
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        multiple={multiple}
        capture={capture}
        disabled={disabled}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onChange}
      />
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          inputRef.current?.click();
        }}
        className={className}
      >
        {children}
      </button>
    </>
  );
}
