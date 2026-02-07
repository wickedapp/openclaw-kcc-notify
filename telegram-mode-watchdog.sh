#!/bin/bash
# Telegram Mode Watchdog
# Monitors webhook infrastructure and auto-switches to long polling if down
#
# Checks: nginx, CF tunnel, KCC Office
# If critical services down for 2+ minutes → switch to long polling
# When recovered → switch back to webhook mode
#
# Run via cron every minute:
#   * * * * * /Users/wickedman-macmini/clawd/scripts/telegram-mode-watchdog.sh

set -e

STATE_FILE="/tmp/telegram-watchdog-state.json"
LOG_FILE="/tmp/telegram-watchdog.log"
OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
GATEWAY_TOKEN="ae12787c6ec45960a0c24c3b42af66083a484077b1d11095"
GATEWAY_PORT="18789"

# Thresholds
FAILURE_THRESHOLD=2  # Minutes of failure before switching
CHECK_INTERVAL=60    # Seconds between checks (cron interval)

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Initialize state file if missing
init_state() {
    if [[ ! -f "$STATE_FILE" ]]; then
        echo '{"mode":"webhook","failureCount":0,"lastCheck":0,"lastSwitch":0}' > "$STATE_FILE"
    fi
}

# Read state
read_state() {
    cat "$STATE_FILE"
}

# Update state
update_state() {
    echo "$1" > "$STATE_FILE"
}

# Get current mode from state
get_mode() {
    jq -r '.mode' "$STATE_FILE"
}

# Check if nginx is healthy
check_nginx() {
    curl -sf --connect-timeout 2 --max-time 5 http://localhost:8790/health > /dev/null 2>&1
}

# Check if CF tunnel is reachable (external check)
check_cf_tunnel() {
    curl -sf --connect-timeout 5 --max-time 10 https://office.itskcc.com/api/health > /dev/null 2>&1
}

# Check if KCC Office is healthy (optional, non-critical)
check_kcc_office() {
    curl -sf --connect-timeout 2 --max-time 5 http://localhost:4200/api/health > /dev/null 2>&1
}

# Check if OpenClaw gateway is running
check_openclaw() {
    curl -sf --connect-timeout 2 --max-time 5 http://localhost:$GATEWAY_PORT/ > /dev/null 2>&1
}

# Switch to long polling mode
switch_to_polling() {
    log "SWITCHING TO LONG POLLING MODE"
    
    # Update OpenClaw config to remove webhook settings
    jq '.channels.telegram.webhookUrl = null | .channels.telegram.webhookSecret = null | .channels.telegram.webhookPath = null' \
        "$OPENCLAW_CONFIG" > "$OPENCLAW_CONFIG.tmp" && mv "$OPENCLAW_CONFIG.tmp" "$OPENCLAW_CONFIG"
    
    # Restart gateway
    curl -sf -X POST "http://localhost:$GATEWAY_PORT/api/gateway/restart" \
        -H "Authorization: Bearer $GATEWAY_TOKEN" > /dev/null 2>&1 || true
    
    # Update state
    local state=$(read_state)
    state=$(echo "$state" | jq '.mode = "polling" | .lastSwitch = now | .failureCount = 0')
    update_state "$state"
    
    log "Switched to long polling mode"
}

# Switch to webhook mode
switch_to_webhook() {
    log "SWITCHING TO WEBHOOK MODE"
    
    # Update OpenClaw config to add webhook settings
    jq '.channels.telegram.webhookUrl = "https://office.itskcc.com/api/telegram/webhook" | 
        .channels.telegram.webhookSecret = "834e9a76b21c50196ae3530e9fe73c79edb880a1b9dd412ca94e612c711ba6f0" | 
        .channels.telegram.webhookPath = "/api/telegram/webhook"' \
        "$OPENCLAW_CONFIG" > "$OPENCLAW_CONFIG.tmp" && mv "$OPENCLAW_CONFIG.tmp" "$OPENCLAW_CONFIG"
    
    # Restart gateway
    curl -sf -X POST "http://localhost:$GATEWAY_PORT/api/gateway/restart" \
        -H "Authorization: Bearer $GATEWAY_TOKEN" > /dev/null 2>&1 || true
    
    # Update state
    local state=$(read_state)
    state=$(echo "$state" | jq '.mode = "webhook" | .lastSwitch = now | .failureCount = 0')
    update_state "$state"
    
    log "Switched to webhook mode"
}

# Main health check
main() {
    init_state
    
    local state=$(read_state)
    local current_mode=$(echo "$state" | jq -r '.mode')
    local failure_count=$(echo "$state" | jq -r '.failureCount')
    
    # Check critical services for webhook mode
    local nginx_ok=false
    local cf_ok=false
    local openclaw_ok=false
    local kcc_ok=false
    
    check_nginx && nginx_ok=true
    check_cf_tunnel && cf_ok=true
    check_openclaw && openclaw_ok=true
    check_kcc_office && kcc_ok=true
    
    log "Health: nginx=$nginx_ok cf=$cf_ok openclaw=$openclaw_ok kcc=$kcc_ok mode=$current_mode failures=$failure_count"
    
    if [[ "$current_mode" == "webhook" ]]; then
        # In webhook mode: check if we need to switch to polling
        if [[ "$nginx_ok" == "false" ]] || [[ "$cf_ok" == "false" ]]; then
            # Critical service down
            failure_count=$((failure_count + 1))
            state=$(echo "$state" | jq ".failureCount = $failure_count")
            update_state "$state"
            
            if [[ $failure_count -ge $FAILURE_THRESHOLD ]]; then
                log "Critical services down for $failure_count checks, switching to polling"
                switch_to_polling
            else
                log "Warning: Critical service down ($failure_count/$FAILURE_THRESHOLD)"
            fi
        else
            # All critical services OK, reset failure count
            if [[ $failure_count -gt 0 ]]; then
                state=$(echo "$state" | jq '.failureCount = 0')
                update_state "$state"
                log "Services recovered, reset failure count"
            fi
        fi
        
    else
        # In polling mode: check if we can switch back to webhook
        if [[ "$nginx_ok" == "true" ]] && [[ "$cf_ok" == "true" ]] && [[ "$openclaw_ok" == "true" ]]; then
            # All services recovered
            failure_count=$((failure_count + 1))  # Count successful checks
            state=$(echo "$state" | jq ".failureCount = $failure_count")
            update_state "$state"
            
            if [[ $failure_count -ge $FAILURE_THRESHOLD ]]; then
                log "All services recovered for $failure_count checks, switching back to webhook"
                switch_to_webhook
            else
                log "Services recovering ($failure_count/$FAILURE_THRESHOLD successful checks)"
            fi
        else
            # Still have failures, reset success count
            if [[ $failure_count -gt 0 ]]; then
                state=$(echo "$state" | jq '.failureCount = 0')
                update_state "$state"
            fi
        fi
    fi
}

# Run main
main
