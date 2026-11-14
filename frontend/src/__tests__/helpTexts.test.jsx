// "Erklärtexte anzeigen" in the settings (this device only): the explaining sentences of the shopping list and the radar.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { HelpTextsField } from '../components/modals/SettingsExtras';
import { HELP_TEXTS_KEY, helpTextsOn, setHelpTexts, useHelpTexts } from '../utils/helpTexts';

function Probe() {
  return useHelpTexts() ? <p>Erklärsatz</p> : null;
}

afterEach(() => localStorage.removeItem(HELP_TEXTS_KEY));

describe('Erklärtexte anzeigen', () => {
  it('is on by default; the switch hides and shows the sentences at once and remembers it on this device', () => {
    expect(helpTextsOn()).toBe(true);
    render(<><HelpTextsField /><Probe /></>);
    const box = screen.getByLabelText('Erklärtexte anzeigen');
    expect(box.checked).toBe(true);
    expect(screen.getByText('Erklärsatz')).toBeTruthy();
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    expect(screen.queryByText('Erklärsatz')).toBeNull();
    expect(localStorage.getItem(HELP_TEXTS_KEY)).toBe('0');
    act(() => setHelpTexts(true));
    expect(screen.getByText('Erklärsatz')).toBeTruthy();
    expect(localStorage.getItem(HELP_TEXTS_KEY)).toBeNull();
  });
});
