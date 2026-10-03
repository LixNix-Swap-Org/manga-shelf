import { useEffect, useRef } from 'react';

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard/screen-reader basics for a modal: puts focus inside when it opens, keeps Tab inside, and gives focus
 * back to the element that opened it. Attach the returned ref to the dialog's outer element (with role="dialog").
 */
export default function useDialogA11y(open) {
  const ref = useRef(null);

  useEffect(() => {
    const node = ref.current;
    if (!open || !node) return undefined;
    const opener = document.activeElement;
    const focusable = () => Array.from(node.querySelectorAll(FOCUSABLE)).filter((el) => !el.disabled && el.offsetParent !== null);

    // an autofocused field inside keeps focus; otherwise the first control (or the dialog itself)
    if (!node.contains(document.activeElement)) (focusable()[0] || node).focus();

    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
      if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
    };
  }, [open]);

  return ref;
}
