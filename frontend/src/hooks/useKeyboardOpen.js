import { useEffect, useState } from 'react';

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image', 'hidden']);

/** A field that opens the on-screen keyboard. */
export function isTypingTarget(el) {
  if (!el || typeof el.closest !== 'function') return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.tagName === 'INPUT' && !NON_TEXT_INPUTS.has(String(el.type || 'text').toLowerCase());
}

const modalOpen = () => Boolean(document.querySelector('[aria-modal="true"]'));

/**
 * True while a field outside the bar has focus or the on-screen keyboard squeezes the viewport, so a fixed bar does
 * not cover the field. Never while a modal is open or the bar has focus (hiding it would drop the focus).
 */
export function useKeyboardOpen(barRef) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const vv = window.visualViewport;
    const evaluate = (focused) => {
      if (modalOpen() || (focused && barRef?.current?.contains(focused))) {
        setOpen(false);
        return;
      }
      const typing = isTypingTarget(focused);
      const squeezed = Boolean(vv) && (vv.scale || 1) <= 1.01 && vv.height < window.innerHeight - 150;
      setOpen(typing || squeezed);
    };
    const onFocusIn = (e) => evaluate(e.target);
    const onFocusOut = (e) => evaluate(e.relatedTarget);
    const onResize = () => evaluate(document.activeElement);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    vv?.addEventListener?.('resize', onResize);
    evaluate(document.activeElement);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      vv?.removeEventListener?.('resize', onResize);
    };
  }, [barRef]);
  return open;
}

/**
 * App-wide: when the visual viewport changes (keyboard up or down, rotation), a focused field outside dialogs that ended
 * up outside the visible part is scrolled back into view. Dialogs do this themselves (useDialogA11y).
 */
export function useRevealFocusedField() {
  useEffect(() => {
    const vv = typeof window === 'undefined' ? null : window.visualViewport;
    if (!vv?.addEventListener) return undefined;
    let frame = 0;
    const reveal = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const field = document.activeElement;
        if (!isTypingTarget(field) || field.closest('[aria-modal="true"]') || typeof field.scrollIntoView !== 'function') return;
        const rect = field.getBoundingClientRect();
        const top = vv.offsetTop || 0;
        if (rect.top >= top && rect.bottom <= top + vv.height) return;
        field.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
    };
    vv.addEventListener('resize', reveal);
    return () => {
      vv.removeEventListener('resize', reveal);
      cancelAnimationFrame(frame);
    };
  }, []);
}

export default useKeyboardOpen;
