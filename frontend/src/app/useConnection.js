import { useSyncExternalStore } from 'react';
import { getConnection, subscribeConnection } from './connection.js';
import { getActiveServer, subscribeServers } from './serverStore.js';

/** { state: 'online' | 'offline' | 'connecting', baseUrl, server, lastError } of the app build; always online on the web. */
export default function useConnection() {
  return useSyncExternalStore(subscribeConnection, getConnection, getConnection);
}

const appBuild = () => Boolean(import.meta.env) && import.meta.env.VITE_APP_MODE === 'app';
const noServer = () => null;

/** The active saved server of the app build (null on the web). */
export function useActiveServer() {
  return useSyncExternalStore(subscribeServers, appBuild() ? getActiveServer : noServer, appBuild() ? getActiveServer : noServer);
}
