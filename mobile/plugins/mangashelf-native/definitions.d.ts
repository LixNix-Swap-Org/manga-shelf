import type { PluginListenerHandle } from '@capacitor/core';

export interface WebLoginOpenOptions {
  /** https URL whose host is cookieDomain or one of its subdomains. */
  url: string;
  /** Only 'crunchyroll.com' is accepted natively. */
  cookieDomain: string;
  cookieName: string;
  doneWhen: { pathNotContaining: string };
  /** A JavaScript expression evaluated in the page once signed in; its value comes back as String(value) or null. */
  readScript?: string;
  title?: string;
  cancelLabel?: string;
}

export interface WebLoginOpenResult {
  cookie: { value: string; expires: number | null };
  scriptResult: string | null;
}

export interface WebLoginRequestOptions {
  /** https, host www.crunchyroll.com or beta-api.crunchyroll.com */
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

export interface WebLoginResponse {
  status: number;
  /** lower-case names, repeated headers joined with ', ' */
  headers: Record<string, string>;
  text: string;
  /** Set-Cookie parsed by the platform */
  cookies: { name: string; value: string; expires: number | null }[];
}

/** Rejections carry code 'cancelled' | 'not_allowed' | 'busy' | 'network' | 'failed'. */
export interface WebLoginPlugin {
  open(options: WebLoginOpenOptions): Promise<WebLoginOpenResult>;
  request(options: WebLoginRequestOptions): Promise<WebLoginResponse>;
}

/** iOS only: items the share extension left in the App Group, delivered when the app becomes active. */
export interface SharedInboxPlugin {
  addListener(eventName: 'shareReceived', listener: (share: { text: string; url: string }) => void): Promise<PluginListenerHandle>;
}
