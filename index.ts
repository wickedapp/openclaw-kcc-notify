/**
 * KCC Office Notifier Plugin for OpenClaw
 * 
 * Hooks into message_received, message_sent, and after_tool_call to:
 * 1. Push all Boss messages to /api/workflow (start_flow)
 * 2. Push all messages (received + sent) to /api/messages for the dashboard feed
 * 3. Filter out harmless exec failures to reduce notification spam
 */

const DEFAULT_WORKFLOW_ENDPOINT = 'http://localhost:4200/api/workflow';
const DEFAULT_MESSAGES_ENDPOINT = 'http://localhost:4200/api/messages';
const DEFAULT_TIMEOUT_MS = 2000;
const BOSS_SENDER_IDS = ['167090545'];

// ── Exec failure filter logic ──

/** Commands where exit code 1 is normal/expected */
const BENIGN_EXIT1_COMMANDS = ['cat', 'grep', 'ls', 'egrep', 'fgrep', 'diff', 'test'];

/** Patterns in stderr/output that indicate harmless failures */
const BENIGN_STDERR_PATTERNS = [
  /no matches found/i,
  /zsh:.*no matches/i,
];

/**
 * Determine if an exec failure is harmless and should be suppressed.
 */
function isHarmlessExecFailure(command: string, exitCode: number, stderr?: string): boolean {
  // 1. Any command with 2>/dev/null that fails — user explicitly silenced errors
  if (command.includes('2>/dev/null') || command.includes('2>\/dev\/null')) {
    return true;
  }

  // 2. Exit code 1 from benign commands (grep no match, cat missing file, etc.)
  if (exitCode === 1) {
    const trimmed = command.trim();
    // Extract the base command (handle pipes, semicolons, &&, ||)
    // Check if the *failing* part is a benign command
    // For simplicity, check if the command starts with or contains a benign command
    for (const cmd of BENIGN_EXIT1_COMMANDS) {
      // Match: "grep ...", "cat ...", or last command in a pipe like "... | grep ..."
      const patterns = [
        new RegExp(`^${cmd}(\\s|$)`),           // starts with command
        new RegExp(`\\|\\s*${cmd}(\\s|$)`),      // piped to command
        new RegExp(`&&\\s*${cmd}(\\s|$)`),        // chained with &&
        new RegExp(`;\\s*${cmd}(\\s|$)`),         // chained with ;
      ];
      if (patterns.some(p => p.test(trimmed))) {
        return true;
      }
    }
  }

  // 3. Suppress zsh "no matches found" errors
  if (stderr) {
    if (BENIGN_STDERR_PATTERNS.some(p => p.test(stderr))) {
      return true;
    }
  }

  // 4. Only notify on exit codes > 1 for unrecognized commands?
  // No — exit code > 1 is always concerning. Exit code 1 from unknown commands
  // is still reported (only the benign list above gets suppressed).

  return false;
}

/**
 * Check if a sent message is just reporting a harmless exec failure.
 * This prevents forwarding "Command exited with code 1" type messages
 * for benign commands to the dashboard.
 */
function isHarmlessExecMessage(content: string): boolean {
  const lower = content.toLowerCase();

  // Check for common exec error message patterns
  const isExecErrorMsg = /command exited with code \d+/i.test(content)
    || /exited with code \d+/i.test(content)
    || /exit code[:\s]+\d+/i.test(content);

  if (!isExecErrorMsg) return false;

  // Extract exit code from message
  const codeMatch = content.match(/code[:\s]+(\d+)/i);
  const exitCode = codeMatch ? parseInt(codeMatch[1], 10) : 0;

  // Exit codes > 1 are always concerning
  if (exitCode > 1) return false;

  // Exit code 1 with benign command references
  for (const cmd of BENIGN_EXIT1_COMMANDS) {
    if (lower.includes(cmd)) return true;
  }

  // Messages about 2>/dev/null commands
  if (lower.includes('2>/dev/null')) return true;

  // zsh no matches
  if (/no matches found/i.test(content)) return true;

  return false;
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch (error) {
    console.log(`[kcc-notify] POST ${url} failed (non-blocking):`,
      error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
}

export default function kccNotifyPlugin(api: any) {
  const config = api.config || {};
  const workflowEndpoint = config.endpoint || DEFAULT_WORKFLOW_ENDPOINT;
  const messagesEndpoint = config.messagesEndpoint || DEFAULT_MESSAGES_ENDPOINT;
  const enabled = config.enabled !== false;
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!enabled) {
    console.log('[kcc-notify] Plugin disabled');
    return;
  }

  console.log('[kcc-notify] Plugin loaded — hooks: message_received + message_sent');
  console.log('[kcc-notify]   workflow:', workflowEndpoint);
  console.log('[kcc-notify]   messages:', messagesEndpoint);

  // ── message_received: Boss messages → workflow + messages feed ──
  api.registerHook('message_received', async (event: any) => {
    const senderId = event?.metadata?.senderId || '';
    const content = event?.content || '';
    const messageId = event?.metadata?.messageId;
    const senderName = event?.metadata?.senderName || 'Unknown';
    const isBoss = BOSS_SENDER_IDS.includes(String(senderId));

    // Push to messages feed (all received messages from Boss)
    if (isBoss && content) {
      console.log(`[kcc-notify] Boss message → messages feed: ${content.slice(0, 60)}`);
      void postJson(messagesEndpoint, {
        message: content,
        from: 'Boss',
        type: 'received',
      }, timeoutMs);
    }

    // Call start_flow for Boss messages (existing behavior)
    if (isBoss) {
      console.log(`[kcc-notify] Boss message → start_flow: ${content.slice(0, 60)}`);
      void postJson(workflowEndpoint, {
        action: 'start_flow',
        content: typeof content === 'string' ? content.slice(0, 200) : '',
        from: senderName,
        agent: 'wickedman',
        messageId: messageId ? Number(messageId) : undefined,
      }, timeoutMs);
    }
  }, {
    name: 'kcc-message-received',
    description: 'Push received Boss messages to KCC Office dashboard',
  });

  // ── message_sent: bot replies → messages feed + auto agent_complete ──
  api.registerHook('message_sent', async (event: any) => {
    const content = event?.content || event?.text || '';
    if (!content) return;

    // Filter out messages that are just reporting harmless exec failures
    if (isHarmlessExecMessage(content)) {
      console.log(`[kcc-notify] Suppressed harmless exec error message: ${content.slice(0, 60)}`);
      return;
    }

    // Only push messages sent to Boss (check recipient)
    const recipientId = event?.metadata?.recipientId || event?.metadata?.chatId || '';
    const isToBoss = BOSS_SENDER_IDS.includes(String(recipientId));

    if (isToBoss) {
      console.log(`[kcc-notify] Bot reply → messages feed: ${content.slice(0, 60)}`);
      void postJson(messagesEndpoint, {
        message: content,
        from: 'WickedMan',
        type: 'sent',
      }, timeoutMs);

      // Auto-complete any active task when we send a reply to Boss
      // This ensures tasks don't get stuck as in_progress
      console.log(`[kcc-notify] Bot reply → agent_complete`);
      void postJson(workflowEndpoint, {
        action: 'agent_complete',
        agent: 'wickedman',
        result: typeof content === 'string' ? content.slice(0, 200) : 'Task completed',
      }, timeoutMs);
    }
  }, {
    name: 'kcc-message-sent',
    description: 'Push bot replies to KCC Office messages feed + auto-complete tasks',
  });

  // ── after_tool_call: filter exec failures, notify only on real problems ──
  api.registerHook('after_tool_call', async (event: any) => {
    // Only care about exec tool calls
    const toolName = event?.toolName || event?.name || '';
    if (toolName !== 'exec') return;

    const result = event?.result || event?.output || {};
    const status = result?.status || '';
    const exitCode = typeof result?.exitCode === 'number' ? result.exitCode
      : (status === 'error' ? 1 : 0);

    // Only process failures
    if (exitCode === 0 && status !== 'error') return;

    const command = event?.params?.command || event?.input?.command || '';
    const stderr = result?.stderr || result?.error || '';

    if (isHarmlessExecFailure(command, exitCode, stderr)) {
      console.log(`[kcc-notify] Suppressed harmless exec failure (code ${exitCode}): ${command.slice(0, 80)}`);
      return;
    }

    // Genuinely concerning failure — notify dashboard
    console.log(`[kcc-notify] Exec failure → dashboard (code ${exitCode}): ${command.slice(0, 80)}`);
    void postJson(messagesEndpoint, {
      message: `⚠️ Exec failure (exit ${exitCode}): ${command.slice(0, 150)}`,
      from: 'System',
      type: 'exec_error',
    }, timeoutMs);
  }, {
    name: 'kcc-exec-filter',
    description: 'Filter harmless exec failures, notify only on real problems',
  });

  // ── HTTP handler for manual notifications ──
  api.registerHttpHandler({
    method: 'POST',
    path: '/kcc-notify',
    async handler(req: any) {
      const body = await req.json();
      const { content, from = 'Unknown', messageId } = body;

      if (!content) {
        return new Response(JSON.stringify({ error: 'content is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const success = await postJson(workflowEndpoint, {
        action: 'start_flow',
        content: typeof content === 'string' ? content.slice(0, 200) : '',
        from,
        agent: 'wickedman',
        messageId: messageId ? Number(messageId) : undefined,
      }, timeoutMs);

      return new Response(JSON.stringify({ success }), {
        status: success ? 200 : 502,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
}
