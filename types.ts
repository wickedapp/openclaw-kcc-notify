/**
 * Type definitions for OpenClaw Plugin API
 * These are simplified types - the actual API may have more methods
 */

export interface HttpHandlerOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  handler: (req: Request) => Promise<Response> | Response;
}

export interface HookOptions {
  event: string;
  handler: (event: HookEvent) => Promise<void> | void;
}

export interface HookEvent {
  type: string;
  action: string;
  sessionKey: string;
  timestamp: Date;
  messages: string[];
  context: Record<string, unknown>;
}

export interface PluginAPI {
  config: Record<string, unknown>;
  registerHttpHandler(options: HttpHandlerOptions): void;
  registerHook?(options: HookOptions): void;
  registerTool?(options: unknown): void;
}
