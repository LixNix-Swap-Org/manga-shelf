// The CHANGELOG built into the app (vite.config.js, virtual:changelog: the sections from 4.0.0 on), parsed once and
// loaded only when "Was ist neu" or the hint after an update needs it.
import { parseChangelog } from '../../utils/whatsNew.js';

let pending = null;

/** The parsed version sections (utils/whatsNew.js parseChangelog), newest first. */
export function loadChangelog() {
  if (!pending) {
    pending = import('virtual:changelog')
      .then((mod) => parseChangelog(mod.default))
      .catch((err) => {
        pending = null;
        throw err;
      });
  }
  return pending;
}
