#!/bin/sh
set -eu

kind=claude-code
if [ "${1:-}" = exec ]; then kind=codex-cli; fi
if [ "${1:-}" = ask ]; then kind=fx; fi
if [ "${1:-}" = run ]; then kind=opencode; fi
if [ "${2:-}" = --mode ]; then kind=pi; fi
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
model=${model#nanoeval/}
instruction=$(cat)

if [ "$kind" = codex-cli ]; then
  [ -d "$CODEX_HOME" ] || exit 64
  base=$(printf '%s' "$provider" | sed 's/.*base_url="\([^"]*\)".*/\1/')
  variable=$(printf '%s' "$provider" | sed 's/.*env_key="\([^"]*\)".*/\1/')
  eval "token=\$$variable"
  url=$base/responses
elif [ "$kind" = fx ]; then
  [ -f "$FX_HOME/settings.json" ] || exit 64
  base=$(sed -n 's/.*"base_url": "\([^"]*\)".*/\1/p' "$FX_HOME/settings.json")
  variable=$(sed -n 's/.*"env": "\([^"]*\)".*/\1/p' "$FX_HOME/settings.json")
  eval "token=\$$variable"
  case $(sed -n 's/.*"protocol": "\([^"]*\)".*/\1/p' "$FX_HOME/settings.json") in
    anthropic-messages) url=$base/messages ;;
    openai-chat-completions) url=$base/chat/completions ;;
    openai-responses) url=$base/responses ;;
    *) exit 64 ;;
  esac
elif [ "$kind" = pi ]; then
  [ -f "$PI_CODING_AGENT_DIR/models.json" ] || exit 64
  base=$(sed -n 's/.*"baseUrl": "\([^"]*\)".*/\1/p' "$PI_CODING_AGENT_DIR/models.json")
  variable=$(sed -n 's/.*"apiKey": "\$\([^"]*\)".*/\1/p' "$PI_CODING_AGENT_DIR/models.json")
  eval "token=\$$variable"
  case $(sed -n 's/.*"api": "\([^"]*\)".*/\1/p' "$PI_CODING_AGENT_DIR/models.json") in
    anthropic-messages) url=$base/v1/messages ;;
    openai-completions) url=$base/chat/completions ;;
    openai-responses) url=$base/responses ;;
    *) exit 64 ;;
  esac
elif [ "$kind" = opencode ]; then
  [ -n "$XDG_DATA_HOME" ] || exit 64
  base=$(printf '%s' "$OPENCODE_CONFIG_CONTENT" | sed 's/.*"baseURL":"\([^"]*\)".*/\1/')
  variable=$(printf '%s' "$OPENCODE_CONFIG_CONTENT" | sed 's/.*"apiKey":"{env:\([^}]*\)}".*/\1/')
  eval "token=\$$variable"
  case $(printf '%s' "$OPENCODE_CONFIG_CONTENT" | sed 's/.*"npm":"\([^"]*\)".*/\1/') in
    @ai-sdk/anthropic) url=$base/messages ;;
    @ai-sdk/openai-compatible) url=$base/chat/completions ;;
    @ai-sdk/openai) url=$base/responses ;;
    *) exit 64 ;;
  esac
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
elif [ "$kind" = pi ]; then
  failed=false
  sh -c "$command" >/dev/null 2>&1 || failed=true
  printf '{"type":"session","version":3,"id":"fake-session"}\n'
  printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"scripted"}}],"model":"%s","usage":{"input":60,"output":7,"cacheRead":40,"cacheWrite":0},"stopReason":"toolUse"}}\n' "$model"
  printf '{"type":"tool_execution_end","toolCallId":"call_1","toolName":"bash","result":{"content":[{"type":"text","text":""}]},"isError":%s}\n' "$failed"
  printf '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"The task is complete."}],"model":"%s","usage":{"input":60,"output":7,"cacheRead":40,"cacheWrite":0},"stopReason":"stop"}}\n' "$model"
  printf '{"type":"agent_settled","aborted":false}\n'
elif [ "$kind" = opencode ]; then
  status=completed
  sh -c "$command" >/dev/null 2>&1 || status=error
  printf '{"type":"step_start","sessionID":"fake-session","part":{"type":"step-start"}}\n'
  printf '{"type":"tool_use","sessionID":"fake-session","part":{"type":"tool","tool":"bash","callID":"call_1","state":{"status":"%s","input":{"command":"scripted"},"output":""}}}\n' "$status"
  printf '{"type":"text","sessionID":"fake-session","part":{"type":"text","text":"The task is complete."}}\n'
  printf '{"type":"step_finish","sessionID":"fake-session","part":{"type":"step-finish","reason":"stop","tokens":{"input":60,"output":7},"cost":0}}\n'
elif [ "$kind" = fx ]; then
  status=success
  sh -c "$command" >/dev/null 2>&1 || status=error
  printf '{"output":"The task is complete.","final_output":"The task is complete.","exit_code":0,"model":"%s","session_id":"fake-session","steps":1,"tool_calls":[{"name":"shell","status":"%s"}],"usage":{"input_tokens":100,"output_tokens":7}}\n' "$model" "$status"
else
  printf '{"type":"system","subtype":"init","session_id":"fake-session","model":"%s","tools":["Bash"]}\n' "$model"
  printf '{"type":"assistant","message":{"id":"msg_1","model":"%s","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"scripted"}}],"usage":{"input_tokens":20,"cache_read_input_tokens":40,"cache_creation_input_tokens":5,"output_tokens":7}}}\n' "$model"
  failed=false
  sh -c "$command" >/dev/null 2>&1 || failed=true
  printf '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"","is_error":%s}]}}\n' "$failed"
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"The task is complete.","total_cost_usd":0.0125}'
fi
