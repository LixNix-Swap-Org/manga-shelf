import { useEffect, useId, useRef } from 'react';

/**
 * ARIA tabs: ids with aria-controls, roving tabIndex, arrow/Home/End keys (select and focus), labelled tabpanel.
 * `tabs` lists the keys in order; `prefix` gives stable ids (`<prefix>-tab-<key>`, `<prefix>-tabpanel`).
 */
export default function useTabList({ tabs, selected, onSelect, prefix }) {
  const autoId = useId();
  const base = prefix || `tabs-${autoId.replace(/:/g, '')}`;
  const tabId = (key) => `${base}-tab-${key}`;
  const panelId = `${base}-tabpanel`;
  const pendingFocus = useRef(null);

  // after the commit: an autoFocus field of the new panel must not take the focus from the tab
  useEffect(() => {
    if (!pendingFocus.current) return;
    const { doc, id } = pendingFocus.current;
    pendingFocus.current = null;
    doc.getElementById(id)?.focus();
  });

  const onKeyDown = (e) => {
    const index = tabs.indexOf(selected);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined || !tabs.length) return;
    e.preventDefault();
    const key = tabs[(next + tabs.length) % tabs.length];
    const doc = e.currentTarget.ownerDocument;
    pendingFocus.current = { doc, id: tabId(key) };
    onSelect(key);
    doc.getElementById(tabId(key))?.focus();
  };

  return {
    tabListProps: { role: 'tablist', onKeyDown },
    tabProps: (key) => ({
      id: tabId(key),
      type: 'button',
      role: 'tab',
      'aria-selected': selected === key,
      'aria-controls': panelId,
      tabIndex: selected === key ? 0 : -1,
      onClick: () => onSelect(key)
    }),
    panelProps: { id: panelId, role: 'tabpanel', 'aria-labelledby': tabId(selected) }
  };
}
