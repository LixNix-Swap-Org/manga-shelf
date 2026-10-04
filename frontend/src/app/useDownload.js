import { useEffect, useState, useSyncExternalStore } from 'react';
import { isAppMode } from '../utils/api';
import {
  cancelDownload, downloadProgress, downloadsRunning, startDownload, subscribeDownloads, watchDownload
} from './downloadManager';

/**
 * Token-carrying download of `path` (or of the path passed to `start`) for the app build (app/downloadManager.js):
 * `progress` is null or { loaded, total }; `start(path, { filename })` resolves to true when the file was saved. The
 * download outlives the component.
 * In the browser build a plain <a href download> stays the better choice; `needed` tells the two apart.
 */
export default function useDownload(path) {
  // without a `path` the hook follows the path it last started
  const [startedPath, setStartedPath] = useState(null);
  const key = path ?? startedPath;
  const progress = useSyncExternalStore(subscribeDownloads, () => (key ? downloadProgress(key) : null));
  useEffect(() => (key ? watchDownload(key) : undefined), [key]);
  return {
    start: (target = path, options) => {
      if (!path) setStartedPath(target);
      return startDownload(target, options);
    },
    progress,
    busy: progress !== null,
    cancel: () => key && cancelDownload(key),
    needed: isAppMode()
  };
}

/** True while any download runs: the dialogs that offer downloads refuse to close meanwhile. */
export function useDownloadRunning() {
  return useSyncExternalStore(subscribeDownloads, downloadsRunning);
}
