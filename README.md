# OpenClaw KCC Notify Plugin

Notifies the KCC Office dashboard when Telegram messages are received by OpenClaw.

## Architecture

```
Telegram ←→ OpenClaw (long polling)
                 ↓
           [This Plugin]
                 ↓
           KCC Office Dashboard (localhost:4200)
```

## Installation

### Via Git (Recommended)

```bash
# Clone to OpenClaw extensions directory
git clone https://github.com/wickedapp/openclaw-kcc-notify.git ~/.openclaw/extensions/kcc-notify
```

### Via Plugin Path

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "load": {
      "paths": ["~/Projects/openclaw-kcc-notify"]
    },
    "entries": {
      "kcc-notify": {
        "enabled": true,
        "config": {
          "endpoint": "http://localhost:4200/api/workflow",
          "timeoutMs": 2000
        }
      }
    }
  }
}
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | string | `http://localhost:4200/api/workflow` | KCC Office API endpoint |
| `enabled` | boolean | `true` | Enable/disable notifications |
| `timeoutMs` | number | `2000` | Request timeout in milliseconds |

## How It Works

### Current Implementation

The plugin registers an HTTP handler at `/kcc-notify` that can be called to create "Received" entries in the KCC Office dashboard.

```bash
# Manual notification
curl -X POST http://localhost:8787/kcc-notify \
  -H "Content-Type: application/json" \
  -d '{"content": "Test message", "from": "Boss", "messageId": 12345}'
```

### Future Implementation

When OpenClaw implements the `message:received` hook, this plugin will automatically notify KCC Office for every incoming Telegram message, providing instant "Received" animations on the dashboard.

## Non-Blocking Design

All notifications to KCC Office are:
- Fire-and-forget (don't block OpenClaw processing)
- Have a 2-second timeout
- Silently fail if KCC Office is down

This ensures OpenClaw continues to work normally regardless of KCC Office status.

## License

MIT
