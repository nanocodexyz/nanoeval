export class InvalidError extends Error {
  override name = 'Blocklist.InvalidError'
}

export type List = readonly string[]

export const limit = 64

export const lists: Record<string, List> = {
  'terminal-bench': [
    'api.github.com/repos/harbor-framework',
    'api.github.com/repos/laude-institute/harbor',
    'api.github.com/repos/laude-institute/terminal-bench',
    'api.github.com/repos/laude-institute/terminal-bench-2',
    'codeload.github.com/harbor-framework',
    'codeload.github.com/laude-institute/harbor',
    'codeload.github.com/laude-institute/terminal-bench',
    'codeload.github.com/laude-institute/terminal-bench-2',
    'github.com/harbor-framework',
    'github.com/laude-institute/harbor',
    'github.com/laude-institute/terminal-bench',
    'github.com/laude-institute/terminal-bench-2',
    'harborframework.com',
    'marginlab.ai',
    'raw.githubusercontent.com/harbor-framework',
    'raw.githubusercontent.com/laude-institute/harbor',
    'raw.githubusercontent.com/laude-institute/terminal-bench',
    'raw.githubusercontent.com/laude-institute/terminal-bench-2',
    'tbench.ai',
    'tbench.oblok.me',
  ],
}

export const enforced: readonly string[] = [
  'claude',
  'claude-code',
  'codex',
  'nanocode-claude',
  'oracle',
  'stock-claude',
]

export const message = 'nanoeval: the web blocklist of this run refuses '

const entry = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/[a-z0-9._~-]+)*$/

export function parse(text: string): List {
  return valid(
    text
      .split('\n')
      .map((line) => line.replace(/#.*/, '').trim())
      .filter(Boolean),
  )
}

export function valid(list: unknown): List {
  if (!Array.isArray(list) || !list.length)
    throw new InvalidError('a web blocklist is a list of at least one host')
  for (const item of list)
    if (typeof item !== 'string' || !entry.test(item))
      throw new InvalidError(
        'a web blocklist entry is a lowercase host with an optional path, without a scheme: ' +
          JSON.stringify(item),
      )
  if (new Set(list).size !== list.length)
    throw new InvalidError('a web blocklist names each entry once')
  if (list.length > limit)
    throw new InvalidError(
      'a web blocklist holds at most ' + limit + ' entries, the limit of the provider filter',
    )
  return list as List
}

function split(item: string): { host: string; path: string } {
  const slash = item.indexOf('/')
  return slash < 0
    ? { host: item, path: '' }
    : { host: item.slice(0, slash), path: item.slice(slash) }
}

export function blocks(list: List, url: string): boolean {
  const rest = url
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^/?#]*@/, '')
  const authority = rest.replace(/[/?#].*/, '')
  const host = authority.replace(/:[0-9]*$/, '').replace(/\.$/, '')
  const after = rest.slice(authority.length)
  const path = after.startsWith('/') ? after.replace(/[?#].*/, '') : ''
  if (!host) return true
  return list.some((item) => {
    const listed = split(item)
    const onHost = host === listed.host || host.endsWith('.' + listed.host)
    return (
      onHost && (listed.path === '' || path === listed.path || path.startsWith(listed.path + '/'))
    )
  })
}

export type Filtered = { body: Record<string, unknown> } | { refusal: string }

const searchTool = /^web_search_[0-9]+$/
const fetchTool = /^web_fetch_[0-9]+$/

function typeOf(tool: unknown): string {
  const type =
    typeof tool === 'object' && tool !== null ? (tool as Record<string, unknown>)['type'] : undefined
  return typeof type === 'string' ? type : ''
}

export function searches(body: Record<string, unknown>): boolean {
  const tools = body['tools']
  return (
    Array.isArray(tools) &&
    tools.some((tool) => searchTool.test(typeOf(tool)) || fetchTool.test(typeOf(tool)))
  )
}

export function anthropic(body: Record<string, unknown>, list: List): Filtered {
  if (!searches(body)) return { body }
  const tools: unknown[] = []
  for (const tool of body['tools'] as unknown[]) {
    const type = typeOf(tool)
    const fetch = fetchTool.test(type)
    if (!fetch && !searchTool.test(type)) {
      tools.push(tool)
      continue
    }
    const definition = tool as Record<string, unknown>
    if (definition['allowed_domains'] !== undefined)
      return {
        refusal:
          message +
          'a ' +
          type +
          ' tool with allowed_domains, which the provider takes only without blocked_domains',
      }
    if (fetch && list.some((item) => item.includes('/')))
      return {
        refusal:
          message +
          'a ' +
          type +
          ' tool: the provider filters a web fetch by host only, and the list names paths',
      }
    const held = definition['blocked_domains']
    if (
      held !== undefined &&
      (!Array.isArray(held) || held.some((item) => typeof item !== 'string'))
    )
      return { refusal: message + 'a ' + type + ' tool whose blocked_domains is not a list' }
    const blocked = [...new Set([...((held as string[] | undefined) ?? []), ...list])]
    if (blocked.length > limit)
      return {
        refusal:
          message +
          'a ' +
          type +
          ' tool: its blocked_domains and the list hold more than ' +
          limit +
          ' entries',
      }
    tools.push({ ...definition, blocked_domains: blocked })
  }
  return { body: { ...body, tools } }
}

export function hook(list: List): string {
  return (
    [
      "list='" + valid(list).join(' ') + "'",
      'refuse() {',
      '  printf "%s%s\\n" "' + message + '" "$1" >&2',
      '  exit 2',
      '}',
      'input=$(tr -d "\\n")',
      'url=$(printf "%s" "$input" | sed -n \'s/.*"url"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p\')',
      '[ -n "$url" ] || refuse "a fetch whose url it cannot read"',
      'rest=$(printf "%s" "$url" | tr "A-Z" "a-z" | sed -e \'s|^[a-z][a-z0-9+.-]*://||\' -e \'s|^[^/?#]*@||\')',
      'authority=$(printf "%s" "$rest" | sed \'s|[/?#].*||\')',
      'host=$(printf "%s" "$authority" | sed -e \'s|:[0-9]*$||\' -e \'s|\\.$||\')',
      'after=${rest#"$authority"}',
      'case $after in',
      '  /*) path=$(printf "%s" "$after" | sed \'s|[?#].*||\') ;;',
      '  *) path= ;;',
      'esac',
      '[ -n "$host" ] || refuse "$url"',
      'for item in $list; do',
      '  listed=${item%%/*}',
      '  part=${item#"$listed"}',
      '  case $host in "$listed" | *."$listed") ;; *) continue ;; esac',
      '  [ -z "$part" ] && refuse "$url"',
      '  case $path in "$part" | "$part"/*) refuse "$url" ;; esac',
      'done',
      'exit 0',
    ].join('\n') + '\n'
  )
}
