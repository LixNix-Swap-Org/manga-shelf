import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import usePullToRefresh, { touchScrollsContent } from '../hooks/usePullToRefresh';

describe('usePullToRefresh inside dialogs and scrolled content', () => {
  let matchMedia;
  beforeEach(() => {
    document.body.innerHTML = '';
    matchMedia = window.matchMedia;
    window.matchMedia = () => ({ matches: true });
  });
  afterEach(() => {
    window.matchMedia = matchMedia;
  });

  const touch = (el, type, y) => el.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { touches: y === undefined ? [] : [{ clientY: y }] }));
  const pull = async (el) => {
    act(() => { touch(el, 'touchstart', 100); touch(el, 'touchmove', 200); });
    await act(async () => { touch(el, 'touchend'); });
  };

  function page() {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const inDialog = document.createElement('p');
    dialog.appendChild(inDialog);
    const overlay = document.createElement('div');
    overlay.setAttribute('aria-modal', 'true');
    const inOverlay = document.createElement('span');
    overlay.appendChild(inOverlay);
    const list = document.createElement('div');
    const inList = document.createElement('p');
    list.appendChild(inList);
    const plain = document.createElement('p');
    document.body.append(dialog, overlay, list, plain);
    return { inDialog, inOverlay, list, inList, plain };
  }

  it('a pull that starts in a dialog or in content scrolled down scrolls that content and does not refresh', async () => {
    const { inDialog, inOverlay, list, inList, plain } = page();
    const onRefresh = vi.fn(async () => {});
    const { result } = renderHook(() => usePullToRefresh(onRefresh, { win: window }));

    await pull(inDialog);
    await pull(inOverlay);
    list.scrollTop = 120;
    act(() => { touch(inList, 'touchstart', 100); touch(inList, 'touchmove', 200); });
    expect(result.current.pullDistance).toBe(0);
    await act(async () => { touch(inList, 'touchend'); });
    expect(onRefresh).not.toHaveBeenCalled();

    list.scrollTop = 0;
    await pull(inList);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await pull(plain);
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it('touchScrollsContent handles text nodes and targets without an element', () => {
    const { inDialog, plain } = page();
    expect(touchScrollsContent(inDialog.appendChild(document.createTextNode('x')))).toBe(true);
    expect(touchScrollsContent(plain)).toBe(false);
    expect(touchScrollsContent(window)).toBe(false);
    expect(touchScrollsContent(null)).toBe(false);
  });
});
