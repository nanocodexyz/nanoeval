export const artifact = 'agent/preflight.txt'

export const reachSec = 3

export const reachUrl = 'https://pypi.org/simple/pip/'

export const tools = [
  'python',
  'python3',
  'pip',
  'pip3',
  'uv',
  'node',
  'npm',
  'gcc',
  'g++',
  'make',
  'cmake',
  'cargo',
  'rustc',
  'go',
  'java',
  'R',
  'Rscript',
  'git',
  'curl',
  'wget',
] as const

export function prompt(input: prompt.Input): string {
  return (
    '<environment_facts>\nProbed once in this sandbox before the task started:\n' +
    input.facts.trim() +
    '\n</environment_facts>\n\n' +
    input.instruction
  )
}

export declare namespace prompt {
  type Input = { facts: string; instruction: string }
}

export function script(): string {
  const check = (command: string) =>
    '$bound ' + command + ' >/dev/null 2>&1 && reach=reachable || reach=unreachable'

  return [
    'os=$( (. /etc/os-release 2>/dev/null && printf %s "$PRETTY_NAME") || uname -sr)',
    'printf "os: %s; arch %s; user %s; cwd %s\\n" "$os" "$(uname -m)" "$(id -un 2>/dev/null || id -u)" "$(pwd)"',
    'cpus=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || printf unknown)',
    'quota=$(awk \'$1 != "max" { printf "; cgroup quota %.1f CPUs", $1 / $2 }\' /sys/fs/cgroup/cpu.max 2>/dev/null)',
    'printf "cpus: %s (nproc)%s\\n" "$cpus" "$quota"',
    'awk \'/^MemTotal:/ { total = $2 } /^MemAvailable:/ { free = $2 } END { if (total) printf "memory: %.1f GiB total, %.1f GiB available\\n", total / 1048576, free / 1048576 }\' /proc/meminfo 2>/dev/null',
    'for place in "$(pwd)" /tmp; do df -Pk "$place" 2>/dev/null | awk -v place="$place" \'NR == 2 { printf "disk: %.1f GiB free at %s\\n", $4 / 1048576, place }\'; done',
    'missing=',
    'for name in ' + tools.join(' ') + '; do',
    '  path=$(command -v "$name" 2>/dev/null) || { missing="$missing $name"; continue; }',
    '  case $name in',
    '    go) version=$("$name" version 2>&1 | head -n 1) ;;',
    '    java) version=$("$name" -version 2>&1 | head -n 1) ;;',
    '    *) version=$("$name" --version 2>&1 | head -n 1) ;;',
    '  esac',
    '  printf "%s: %s (%s)\\n" "$name" "$path" "$version"',
    'done',
    'printf "missing:%s\\n" "${missing:- none}"',
    'url=' + reachUrl,
    'bound=',
    'if command -v timeout >/dev/null 2>&1; then bound="timeout ' + reachSec + '"; fi',
    'if command -v curl >/dev/null 2>&1; then ' +
      check('curl -ksS -o /dev/null -m ' + reachSec + ' "$url"'),
    'elif command -v wget >/dev/null 2>&1; then ' +
      check('wget -q --no-check-certificate -O /dev/null -T ' + reachSec + ' "$url"'),
    'elif command -v python3 >/dev/null 2>&1; then ' +
      check(
        "python3 -c \"import socket; socket.create_connection(('pypi.org', 443), " +
          reachSec +
          ')"',
      ),
    'else reach="not checked: no curl, wget or python3"; fi',
    'printf "network: pypi.org %s\\n" "$reach"',
    'exit 0',
    '',
  ].join('\n')
}
