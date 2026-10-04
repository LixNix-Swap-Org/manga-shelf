import { afterEach } from 'vitest';
import { cleanup, configure, getConfig } from '@testing-library/react';

// globals are off, so Testing Library cannot register its own cleanup
afterEach(cleanup);

// A commit made outside act (a lazy chunk resolving) runs its effects on React's scheduler tick, after the DOM a
// findBy*/waitFor saw. Wait for that tick so history entries and listeners from effects are in place.
const { asyncWrapper } = getConfig();
const realSetImmediate = globalThis.setImmediate;
configure({
  asyncWrapper: async (cb) => {
    const result = await asyncWrapper(cb);
    await new Promise((resolve) => realSetImmediate(resolve));
    return result;
  }
});
