#!/bin/sh
set -eu

kind=claude-code
if [ "${1:-}" = exec ]; then kind=codex-cli; fi
model=
provider=
previous=
for argument in "$@"; do
  case $previous in
    -m | --model) model=$argument ;;
  esac
  case $argument in
    model_providers.*) provider=$argument ;;
  esac
  previous=$argument
done
instruction=$(cat)

if [ "$kind" = codex-cli ]; then
  [ -d "$CODEX_HOME" ] || exit 64
  base=$(printf '%s' "$provider" | sed 's/.*base_url="\([^"]*\)".*/\1/')
  variable=$(printf '%s' "$provider" | sed 's/.*env_key="\([^"]*\)".*/\1/')
  eval "token=\$$variable"
  url=$base/responses
else
  [ -d "$CLAUDE_CONFIG_DIR" ] || exit 64
  token=$ANTHROPIC_AUTH_TOKEN
  url=$ANTHROPIC_BASE_URL/v1/messages
fi

body=$(printf '{"fake_cli":true,"model":"%s","prompt_base64":"%s"}' "$model" "$(printf '%s' "$instruction" | base64 | tr -d '\n')")
if command -v curl >/dev/null 2>&1; then
  reply=$(curl -fsS -H "authorization: Bearer $token" -H 'content-type: application/json' -d "$body" "$url")
else
  reply=$(wget -q -O - --header "authorization: Bearer $token" --header 'content-type: application/json' --post-data "$body" "$url")
fi
command=$(printf '%s\n' "$reply" | sed -n 's/^: command //p' | base64 -d)
[ -n "$command" ] || exit 65

if [ "$kind" = codex-cli ]; then
  printf '%s\n' '{"type":"thread.started","thread_id":"fake-thread"}' '{"type":"turn.started"}'
  code=0
  sh -c "$command" >/dev/null 2>&1 || code=$?
  printf '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"sh -c scripted","aggregated_output":"","exit_code":%s,"status":"completed"}}\n' "$code"
  printf '%s\n' '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"The task is complete."}}'
  printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":7}}'
else
  printf '{"type":"system","subtype":"init","session_id":"fake-session","model":"%s","tools":["Bash"]}\n' "$model"
  printf '{"type":"assistant","message":{"id":"msg_1","model":"%s","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"scripted"}}],"usage":{"input_tokens":20,"cache_read_input_tokens":40,"cache_creation_input_tokens":5,"output_tokens":7}}}\n' "$model"
  failed=false
  sh -c "$command" >/dev/null 2>&1 || failed=true
  printf '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"","is_error":%s}]}}\n' "$failed"
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"The task is complete.","total_cost_usd":0.0125}'
fi
