export const HAPTIC_PATTERNS = { success: [25, 40, 25], error: [60, 50, 60], tap: 12 };

let audioContext = null;

function click(AudioContextImpl) {
  audioContext = audioContext || new AudioContextImpl();
  if (audioContext.state === 'suspended') audioContext.resume?.();
  const start = audioContext.currentTime;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.frequency.value = 1400;
  gain.gain.setValueAtTime(0.06, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.04);
  osc.connect(gain);
  gain.connect(audioContext.destination);
  osc.start(start);
  osc.stop(start + 0.05);
}

/**
 * Short vibration for 'success' | 'error' | 'tap'. iOS has no navigator.vibrate: with { sound: true } a quiet click is
 * played there instead. Never throws; returns whether any feedback was given.
 */
export function haptic(kind = 'tap', {
  sound = false,
  nav = globalThis.navigator,
  AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext
} = {}) {
  const pattern = HAPTIC_PATTERNS[kind] ?? HAPTIC_PATTERNS.tap;
  try {
    if (typeof nav?.vibrate === 'function') return nav.vibrate(pattern) !== false;
    if (!sound || typeof AudioContextImpl !== 'function') return false;
    click(AudioContextImpl);
    return true;
  } catch (_) {
    return false;
  }
}

export function resetHaptics() {
  audioContext = null;
}
