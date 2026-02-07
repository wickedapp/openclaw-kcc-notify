/**
 * KCC Office Notifier Plugin for OpenClaw
 * 
 * This plugin notifies the KCC Office dashboard when messages are received.
 * 
 * Current implementation: Registers an HTTP handler that can be called
 * to create "Received" entries in the KCC Office dashboard.
 * 
 * Future: When OpenClaw implements the `message:received` hook, this plugin
 * will automatically notify KCC Office for every incoming message.
 */

import type { PluginAPI } from './types.js';

interface KccNotifyConfig {
  endpoint?: string;
  enabled?: boolean;
  timeoutMs?: number;
}

const DEFAULT_ENDPOINT = 'http://localhost:4200/api/workflow';
const DEFAULT_TIMEOUT_MS = 2000;

async function notifyKccOffice(
  endpoint: string,
  content: string,
  from: string,
  messageId?: number,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'new_request',
        content: content.slice(0, 200),
        from,
        tgMessageId: messageId,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    // Silently fail - KCC Office being down shouldn't affect OpenClaw
    console.log('[kcc-notify] Failed to notify KCC Office (non-blocking):', 
      error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
}

export default function kccNotifyPlugin(api: PluginAPI) {
  const config: KccNotifyConfig = api.config || {};
  const endpoint = config.endpoint || DEFAULT_ENDPOINT;
  const enabled = config.enabled !== false;
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!enabled) {
    console.log('[kcc-notify] Plugin disabled');
    return;
  }

  console.log('[kcc-notify] Plugin loaded, endpoint:', endpoint);

  // Register HTTP handler for manual notifications
  // This can be called by external services to create "Received" entries
  api.registerHttpHandler({
    method: 'POST',
    path: '/kcc-notify',
    async handler(req) {
      const body = await req.json();
      const { content, from = 'Unknown', messageId } = body;

      if (!content) {
        return new Response(JSON.stringify({ error: 'content is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const success = await notifyKccOffice(endpoint, content, from, messageId, timeoutMs);

      return new Response(JSON.stringify({ success }), {
        status: success ? 200 : 502,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  // TODO: When OpenClaw implements message:received hook, register here:
  // api.registerHook({
  //   event: 'message:received',
  //   async handler(event) {
  //     const { content, sender, messageId } = event;
  //     await notifyKccOffice(endpoint, content, sender, messageId, timeoutMs);
  //   },
  // });
}
