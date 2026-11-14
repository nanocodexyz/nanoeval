import { spawnSync } from 'node:child_process'
import * as Fs from 'node:fs'
import * as Os from 'node:os'
import * as Path from 'node:path'
import * as Converter from '../sandbox/Converter.ts'
import * as Host from '../sandbox/Host.ts'
import * as Runner from '../sandbox/Runner.ts'
import * as Store from '../sandbox/Store.ts'
import * as Pins from '../src/Pins.ts'
import * as Protocol from '../src/Protocol.ts'
import * as Route from '../src/Route.ts'
import * as Slot from '../src/Slot.ts'
import * as Login from './Login.ts'
import * as Revision from './Revision.ts'

export type Level = 'miss' | 'note' | 'ok'

export type Check = { fix?: string; level: Level; text: string }

export type Backend = 'dir' | 'krun' | 'ns'

export type Registry =
  | { kind: 'answered'; limit?: number; remaining?: number; windowSec?: number }
  | { kind: 'unreached'; said: string }

export type Worker =
  | {
      kind: 'answered'
      routes: Route.Deployment | undefined
      version: Protocol.Version | undefined
    }
  | { kind: 'unreached'; said: string }

export type Facts = {
  arch: string
  cgroup: boolean
  credentials: Record<'claude' | 'codex', readonly string[]>
  disk: readonly { freeMb: number; holds: string; path: string }[]
  endpoints: readonly { name: string; said?: string; url: string }[]
  hand: { release: string; said?: string }
  kvm: Host.Kvm
  kvmGroup: string | undefined
  krunfw: boolean
  launcher: 'built' | 'given' | 'none'
  memory: { availableMb: number; totalMb: number }
  node: string
  overlay: boolean
  packages: { installed: string | undefined; pinned: string; workerd: boolean }
  registry: Registry
  root: boolean
  systemd: boolean
  tools: Record<string, string | undefined>
  user: string
  worker: Worker | undefined
  workerUrl: string | undefined
}

export const krunfwRelease = {
  sha256: { x64: 'c169206b01c89fbe134f1728bf4f988702bc7f73b4cf73e6fdece447d6fceca1' } as Record<
    string,
    string | undefined
  >,
  version: '5.5.0',
}

export const terminalBenchMb = { disks: 51_000, layers: 16_000, store: 18_000 }

const nodeMajor = 24
const nsTools = [
  'chroot',
  'ip',
  'losetup',
  'mke2fs',
  'mount',
  'mountpoint',
  'nft',
  'pgrep',
  'setpriv',
  'unshare',
]
const packages: Record<string, string> = {
  chroot: 'coreutils',
  ip: 'iproute2',
  losetup: 'util-linux',
  mke2fs: 'e2fsprogs',
  mount: 'util-linux',
  mountpoint: 'util-linux',
  nft: 'nftables',
  passt: 'passt',
  pgrep: 'procps',
  setpriv: 'util-linux',
  unshare: 'util-linux',
}
const rustup =
  "curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none"

export function backend(facts: Pick<Facts, 'kvm' | 'root'>): Backend {
  return facts.kvm !== 'absent' ? 'krun' : facts.root ? 'ns' : 'dir'
}

function count(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

function krunfwFix(arch: string): string | undefined {
  const sha256 = krunfwRelease.sha256[arch]
  if (!sha256) return undefined
  const file = 'libkrunfw-x86_64.tgz'
  const library = 'libkrunfw.so.' + krunfwRelease.version
  return (
    'curl -fsSL -o /tmp/' +
    file +
    ' https://github.com/containers/libkrunfw/releases/download/v' +
    krunfwRelease.version +
    '/' +
    file +
    " && echo '" +
    sha256 +
    '  /tmp/' +
    file +
    "' | sha256sum -c - && sudo tar -xzf /tmp/" +
    file +
    ' -C /usr/local/lib --strip-components=1 lib64/' +
    library +
    ' && sudo ln -sf ' +
    library +
    ' /usr/local/lib/libkrunfw.so.5 && sudo ldconfig'
  )
}

function install(tool: string): string {
  return 'sudo apt-get install -y ' + (packages[tool] ?? tool)
}

function slots(facts: Facts, wanted: Backend): Check[] {
  const found: Check[] = []
  const launcher = (): Check =>
    facts.launcher !== 'none'
      ? {
          level: 'ok',
          text:
            'the launcher is ' +
            (facts.launcher === 'given' ? 'the one NANOEVAL_KRUN names' : 'built in krun/target'),
        }
      : facts.tools['cargo']
        ? {
            level: 'ok',
            text: 'the launcher is not built yet: the first import or runner builds it from krun/ with cargo, about a minute',
          }
        : {
            fix: rustup,
            level: 'miss',
            text: 'the launcher is not built and cargo is not installed (NANOEVAL_KRUN names a directory with a built one instead)',
          }
  const tool = (name: string, why: string): Check =>
    facts.tools[name]
      ? { level: 'ok', text: name + ' at ' + facts.tools[name] }
      : { fix: install(name), level: 'miss', text: name + ' is not installed: ' + why }
  if (wanted === 'krun') {
    found.push(
      facts.kvm === 'open'
        ? { level: 'ok', text: '/dev/kvm opens for ' + facts.user }
        : facts.kvm === 'closed'
          ? {
              fix:
                'sudo usermod -aG ' +
                (facts.kvmGroup ?? 'kvm') +
                ' ' +
                facts.user +
                ', then log in again',
              level: 'miss',
              text: facts.user + ' cannot read and write /dev/kvm',
            }
          : {
              fix: 'none on this machine: a bare-metal machine or a virtual machine with nested virtualization has it; nanoeval doctor --backend dir checks this one for directory slots',
              level: 'miss',
              text: 'this machine has no /dev/kvm, so no microVM starts on it',
            },
    )
    const fix = krunfwFix(facts.arch)
    found.push(
      facts.krunfw
        ? { level: 'ok', text: 'libkrunfw.so.5 is installed' }
        : {
            ...(fix ? { fix } : {}),
            level: 'miss',
            text: 'libkrunfw.so.5 is not where the dynamic loader finds it',
          },
    )
    found.push(tool('mke2fs', 'it writes the disk of a slot'))
    found.push(
      facts.tools['passt'] && !facts.tools['passt'].startsWith('/usr/')
        ? {
            fix: install('passt'),
            level: 'miss',
            text:
              'passt is at ' +
              facts.tools['passt'] +
              ': a copy outside the system package cannot sandbox itself where user namespaces are restricted',
          }
        : tool(
            'passt',
            'slots on a private network and the RUN steps of a Dockerfile reach the internet through it',
          ),
    )
    found.push(launcher())
  }
  if (wanted === 'ns') {
    found.push(
      facts.root
        ? { level: 'ok', text: 'running as root' }
        : {
            fix: 'run the runner, sandboxd or revision as root: sudo -E node cli/nanoeval.ts ...',
            level: 'miss',
            text: 'ns slots need root, and this is ' + facts.user,
          },
    )
    found.push(
      facts.overlay
        ? { level: 'ok', text: 'the kernel has overlayfs' }
        : { fix: 'sudo modprobe overlay', level: 'miss', text: 'the kernel lists no overlayfs' },
    )
    if (!facts.cgroup)
      found.push({
        level: 'note',
        text: 'no cgroup v2 memory controller: ns slots run without the memory and CPU limits of their tasks',
      })
    for (const name of nsTools) if (!facts.tools[name]) found.push(tool(name, 'ns slots use it'))
    if (nsTools.every((name) => facts.tools[name]))
      found.push({
        level: 'ok',
        text: 'the tools of ns slots are installed: ' + nsTools.join(', '),
      })
    found.push(launcher())
  }
  if (wanted === 'dir')
    found.push({
      level: 'note',
      text:
        'directory slots keep attempts apart by directory only, and run tasks on this machine as ' +
        facts.user +
        ': add --backend dir to import, run and revision, and use them for development',
    })
  return found
}

export function checks(facts: Facts, wanted: Backend = backend(facts)): Check[] {
  const found: Check[] = []
  const major = Number(facts.node.split('.')[0])
  found.push(
    major >= nodeMajor
      ? { level: 'ok', text: 'Node ' + facts.node }
      : {
          fix:
            'install Node ' +
            nodeMajor +
            ' from https://nodejs.org/dist/latest-v' +
            nodeMajor +
            '.x/, step 3 of "A bare machine" in README.md',
          level: 'miss',
          text: 'Node ' + facts.node + ', and nanoeval runs on Node ' + nodeMajor,
        },
  )
  found.push(
    facts.packages.installed === facts.packages.pinned && facts.packages.workerd
      ? {
          level: 'ok',
          text:
            'the pinned packages are installed: ' +
            Pins.pinned(facts.packages.pinned) +
            ' and workerd',
        }
      : {
          fix: 'npm ci',
          level: 'miss',
          text:
            'node_modules holds ' +
            (facts.packages.installed === undefined
              ? 'no nanocode-ts'
              : facts.packages.installed === facts.packages.pinned
                ? 'no workerd for this machine'
                : Pins.pinned(facts.packages.installed)) +
            ', and package.json pins ' +
            Pins.pinned(facts.packages.pinned),
        },
  )
  found.push(
    facts.hand.said === undefined
      ? {
          level: 'ok',
          text:
            'the pinned hand, ' +
            Pins.release(facts.hand.release) +
            ', is published for ' +
            facts.arch +
            ' and answers',
        }
      : {
          fix:
            'curl -fsSIL ' +
            facts.hand.release +
            '/ shows what the network answers; NANOEVAL_NANOCODE=FILE names a hand that is already here',
          level: 'miss',
          text:
            'the pinned hand, ' +
            Pins.release(facts.hand.release) +
            ', which a runner fetches once, was not reached: ' +
            facts.hand.said,
        },
  )
  if (wanted !== 'krun' && facts.kvm === 'absent')
    found.push({
      level: 'note',
      text: 'this machine has no /dev/kvm: no microVM slots (krun), and no import of an environment as a disk, which a microVM writes for an image as it does for a Dockerfile: a task is imported with --backend dir here, or on a machine with KVM',
    })
  if (wanted === 'dir' && !facts.root)
    found.push({
      level: 'note',
      text: 'ns slots, which isolate as a container does, need root: nanoeval doctor --backend ns as root checks for them',
    })
  found.push(...slots(facts, wanted))
  const admitted = facts.memory.availableMb * Runner.hostUtilization
  found.push({
    level: 'ok',
    text:
      count(facts.memory.availableMb) +
      ' MB of memory available of ' +
      count(facts.memory.totalMb) +
      ': a runner admits rows that ask for ' +
      count(admitted) +
      ' MB together, and a row that asks for more runs alone',
  })
  const least = Math.min(...facts.disk.map((entry) => entry.freeMb))
  const whole = terminalBenchMb.store + terminalBenchMb.layers + terminalBenchMb.disks
  found.push({
    level: least < whole ? 'note' : 'ok',
    text:
      facts.disk
        .map(
          (entry) =>
            count(entry.freeMb) + ' MB of disk free for ' + entry.holds + ' (' + entry.path + ')',
        )
        .join(', and ') +
      (least < whole
        ? ': the sample tasks fit, and all of Terminal-Bench 2.1 took ' +
          count(terminalBenchMb.store) +
          ' MB of store, ' +
          count(terminalBenchMb.layers) +
          ' MB of layers and ' +
          count(terminalBenchMb.disks) +
          ' MB of unpacked disks, which run --disks remove gives back as rows end'
        : ''),
    ...(least < whole
      ? { fix: 'node cli/nanoeval.ts prune --dry-run lists what earlier runs left in the cache' }
      : {}),
  })
  const registry = facts.registry
  found.push(
    registry.kind === 'unreached'
      ? {
          fix: 'curl -sI https://registry-1.docker.io/v2/ shows what the network answers; an import of images that the layer cache holds asks for none',
          level: 'miss',
          text: 'Docker Hub, which task images are read from, was not reached: ' + registry.said,
        }
      : registry.remaining === undefined
        ? { level: 'ok', text: 'Docker Hub answers and names no pull limit for this address' }
        : registry.remaining > 0
          ? {
              level: 'ok',
              text:
                'Docker Hub answers: ' +
                registry.remaining +
                ' of ' +
                registry.limit +
                ' pulls are left to this address in a window of ' +
                registry.windowSec +
                ' s, and an import pulls each image once',
            }
          : {
              fix:
                'node cli/nanoeval.ts import DATASET --pull-wait ' +
                registry.windowSec +
                ' waits for the window; the layers read so far stay in the cache',
              level: 'miss',
              text:
                'Docker Hub answers, and this address has none of its ' +
                registry.limit +
                ' pulls left in this window of ' +
                registry.windowSec +
                ' s',
            },
  )
  const worker = facts.worker
  if (!facts.workerUrl)
    found.push({
      level: 'note',
      text: 'no Worker is named (--url or NANOEVAL_URL): nanoeval revision starts its own, and nanoeval run needs one, see "Run it locally" in README.md',
    })
  else if (worker?.kind === 'unreached')
    found.push({
      fix: 'node cli/nanoeval.ts worker --token "$NANOEVAL_TOKEN" --sandbox-url http://127.0.0.1:8788 --sandbox-token "$SANDBOX_TOKEN", beside node cli/nanoeval.ts sandboxd --token "$SANDBOX_TOKEN"',
      level: 'miss',
      text: 'no Worker answers at ' + facts.workerUrl + ': ' + worker.said,
    })
  else if (worker?.kind === 'answered')
    found.push(
      worker.version?.protocol === Protocol.version
        ? {
            level: 'ok',
            text:
              'the Worker at ' +
              facts.workerUrl +
              ' answers and speaks protocol ' +
              worker.version.protocol +
              ', as this checkout does',
          }
        : {
            fix: 'git pull --ff-only && npm ci on the side that is behind, the Worker first',
            level: 'miss',
            text:
              'the Worker at ' +
              facts.workerUrl +
              ' speaks protocol ' +
              (worker.version?.protocol ?? 'of a commit before protocols had a number') +
              ' and this checkout ' +
              Protocol.version,
          },
    )
  for (const endpoint of facts.endpoints)
    found.push(
      endpoint.said === undefined
        ? { level: 'ok', text: endpoint.name + ' ' + endpoint.url + ' answers' }
        : {
            fix:
              'start what serves it again, node scripts/scripted-model.ts --task DIR for the scripted model, or unset ' +
              endpoint.name,
            level: 'miss',
            text:
              'nothing answers at ' +
              endpoint.name +
              ' ' +
              endpoint.url +
              ' (' +
              endpoint.said +
              '): a Worker started from this shell sends its model requests there, and every row of a run then ends as an agent error',
          },
    )
  const routes = worker?.kind === 'answered' ? worker.routes : undefined
  if (routes) {
    const paid = (['claude', 'codex'] as const).flatMap((provider) =>
      routes[provider] ? [provider + ' models with ' + Route.payer(routes[provider])] : [],
    )
    found.push(
      paid.length
        ? { level: 'ok', text: 'the Worker pays for ' + paid.join(' and for ') }
        : {
            fix: 'start nanoeval worker again with ANTHROPIC_API_KEY=KEY in its environment',
            level: 'miss',
            text: 'the Worker holds no model credential: it runs --oracle only. A key of the provider, TEMPO_KEY, a plan login file or the scripted model of scripts/scripted-model.ts gives it one',
          },
    )
  } else {
    const held = (['claude', 'codex'] as const).flatMap((provider) =>
      facts.credentials[provider].length
        ? [provider + ' agents: ' + facts.credentials[provider].join(', ')]
        : [],
    )
    found.push(
      held.length
        ? {
            level: 'ok',
            text:
              'this shell holds a model credential for ' +
              held.join('; for ') +
              ', which nanoeval worker and nanoeval revision take from it',
          }
        : {
            fix: 'export ANTHROPIC_API_KEY=KEY',
            level: 'miss',
            text: 'this shell holds no model credential, so a Worker started from it runs --oracle only. OPENAI_API_KEY, TEMPO_KEY and a plan login (--claude-login, --codex-login) serve too, and scripts/scripted-model.ts stands in for a model at no cost',
          },
    )
  }
  if (!facts.systemd)
    found.push({
      level: 'note',
      text: 'no systemd user session here: scripts/install-linux.sh and the units of the watcher and of a runner are for a machine that has one. On Ubuntu "sudo apt-get install -y libpam-systemd dbus-user-session && sudo loginctl enable-linger $USER" and a new login give this user one',
    })
  return found
}

export function report(found: readonly Check[], wanted: Backend): string {
  const misses = found.filter((check) => check.level === 'miss').length
  return (
    found
      .map(
        (check) =>
          check.level.padEnd(5) + check.text + (check.fix ? '\n     fix: ' + check.fix : ''),
      )
      .join('\n') +
    '\n' +
    (misses
      ? misses +
        ' missing for ' +
        wanted +
        ' slots: the fix under each is the one command that gives it'
      : 'ready for ' + wanted + ' slots')
  )
}

function which(name: string): string | undefined {
  const paths = [
    ...(process.env['PATH'] ?? '').split(Path.delimiter),
    '/usr/sbin',
    '/sbin',
    Path.join(Os.homedir(), '.cargo', 'bin'),
  ]
  for (const directory of paths) {
    const file = Path.join(directory, name)
    try {
      Fs.accessSync(file, Fs.constants.X_OK)
      return file
    } catch {}
  }
  return undefined
}

function existing(path: string): string {
  let current = Path.resolve(path)
  while (!Fs.existsSync(current)) current = Path.dirname(current)
  return current
}

async function reach<T>(ask: (signal: AbortSignal) => Promise<T>): Promise<T | { said: string }> {
  try {
    return await ask(AbortSignal.timeout(15_000))
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : ''
    return {
      said: (error instanceof Error ? error.message : String(error)) + (cause ? ': ' + cause : ''),
    }
  }
}

async function registry(): Promise<Registry> {
  const answered = await reach(async (signal) => {
    const granted = await fetch(
      'https://auth.docker.io/token?service=registry.docker.io&scope=repository:ratelimitpreview/test:pull',
      { signal },
    )
    if (!granted.ok) throw new Error('auth.docker.io answered ' + granted.status)
    const { token } = (await granted.json()) as { token: string }
    const response = await fetch(
      'https://registry-1.docker.io/v2/ratelimitpreview/test/manifests/latest',
      {
        headers: { authorization: 'Bearer ' + token },
        method: 'HEAD',
        signal,
      },
    )
    if (!response.ok && response.status !== 429)
      throw new Error('registry-1.docker.io answered ' + response.status)
    const read = (name: string) => /^(\d+);w=(\d+)/.exec(response.headers.get(name) ?? '')
    const limit = read('ratelimit-limit')
    const remaining = read('ratelimit-remaining')
    return {
      kind: 'answered' as const,
      ...(limit ? { limit: Number(limit[1]), windowSec: Number(limit[2]) } : {}),
      ...(remaining ? { remaining: Number(remaining[1]) } : {}),
    }
  })
  return 'said' in answered ? { kind: 'unreached', said: answered.said } : answered
}

async function login(kind: Login.Kind, file: string | undefined): Promise<string[]> {
  if (!file || !Fs.existsSync(file)) return []
  try {
    const found = await Login.login(kind, file)
    return [
      'the login file ' +
        file +
        ' of NANOEVAL_' +
        kind.toUpperCase() +
        '_LOGIN, for nanoeval revision alone (nanoeval worker takes it as --' +
        kind +
        '-login FILE)' +
        (found.expiresAt === undefined
          ? ''
          : found.expiresAt <= Date.now()
            ? ', which expired ' + new Date(found.expiresAt).toISOString()
            : ', good until ' + new Date(found.expiresAt).toISOString()),
    ]
  } catch {
    return []
  }
}

export async function gather(input: {
  env: Record<string, string | undefined>
  root: string
  token: string | undefined
  url: string | undefined
}): Promise<Facts> {
  const { env } = input
  const manifest = JSON.parse(Fs.readFileSync(Path.join(input.root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  const lock = Path.join(input.root, 'node_modules', '.package-lock.json')
  const installed = Fs.existsSync(lock)
    ? (
        JSON.parse(Fs.readFileSync(lock, 'utf8')) as {
          packages: Record<string, { resolved?: string } | undefined>
        }
      ).packages['node_modules/nanocode-ts']?.resolved
    : undefined
  const meminfo = Fs.readFileSync('/proc/meminfo', 'utf8')
  const memory = (name: string) =>
    Math.floor(
      Number(new RegExp('^' + name + ':\\s+(\\d+) kB$', 'm').exec(meminfo)?.[1] ?? 0) / 1024,
    )
  const cache = Store.defaultCache(env)
  const places = [
    { holds: 'the blob store', path: Store.defaultRoot(env) },
    { holds: 'the cache of disks and blobs', path: cache },
    { holds: 'image layers', path: Converter.defaultLayers(cache, env) },
    { holds: 'the lab of nanoeval revision', path: Revision.defaultLab(env) },
  ]
  const target = process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
  const [hub, hand, worker, claude, codex, ...endpoints] = await Promise.all([
    registry(),
    reach(async (signal) => {
      const response = await fetch(Slot.runtime.release + '/nanocode-' + target + '.gz', {
        method: 'HEAD',
        signal,
      })
      if (!response.ok) throw new Error('its release answered ' + response.status)
      return {}
    }),
    input.url && input.token
      ? reach(async (signal) => {
          const ask = async (path: string) => {
            const response = await fetch(input.url!.replace(/\/+$/, '') + path, {
              headers: { authorization: 'Bearer ' + input.token },
              signal,
            })
            if (response.status === 404) return undefined
            if (!response.ok) throw new Error(path + ' answered ' + response.status)
            return (await response.json()) as unknown
          }
          return {
            kind: 'answered' as const,
            routes: (await ask('/v1/routes')) as Route.Deployment | undefined,
            version: (await ask('/v1/version')) as Protocol.Version | undefined,
          }
        })
      : undefined,
    login('claude', env['NANOEVAL_CLAUDE_LOGIN']),
    login('codex', env['NANOEVAL_CODEX_LOGIN']),
    ...['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'].flatMap((name) => {
      const url = env[name]
      if (!url) return []
      return [
        reach(async (signal) => {
          await (await fetch(url, { signal })).body?.cancel()
          return {}
        }).then((answer) => ({ name, ...('said' in answer ? { said: answer.said } : {}), url })),
      ]
    }),
  ])
  const group = spawnSync('stat', ['-c', '%G', '/dev/kvm'], { encoding: 'utf8' })
  return {
    arch: process.arch,
    cgroup:
      Fs.existsSync('/sys/fs/cgroup/cgroup.controllers') &&
      Fs.readFileSync('/sys/fs/cgroup/cgroup.controllers', 'utf8').split(/\s+/).includes('memory'),
    credentials: {
      claude: [...Revision.keys.claude.filter((name) => env[name]), ...claude],
      codex: [...Revision.keys.codex.filter((name) => env[name]), ...codex],
    },
    disk: [...new Set(places.map((place) => Fs.statSync(existing(place.path)).dev))].map(
      (device) => {
        const held = places.filter((place) => Fs.statSync(existing(place.path)).dev === device)
        const stat = Fs.statfsSync(existing(held[0]!.path))
        return {
          freeMb: Math.floor((stat.bavail * stat.bsize) / (1024 * 1024)),
          holds: held.map((place) => place.holds).join(', '),
          path: held[0]!.path,
        }
      },
    ),
    endpoints,
    hand: { release: Slot.runtime.release, ...('said' in hand ? { said: hand.said } : {}) },
    krunfw: Host.krunfw(),
    kvm: Host.kvm(),
    kvmGroup: group.status === 0 ? group.stdout.trim() : undefined,
    launcher: Host.launcher(Host.environment(env)),
    memory: { availableMb: memory('MemAvailable'), totalMb: memory('MemTotal') },
    node: process.versions.node,
    overlay: Fs.readFileSync('/proc/filesystems', 'utf8').split(/\s+/).includes('overlay'),
    packages: {
      installed,
      pinned: manifest.dependencies['nanocode-ts']!,
      workerd: Fs.existsSync(
        Path.join(
          input.root,
          'node_modules',
          '@cloudflare',
          'workerd-linux-' + (process.arch === 'arm64' ? 'arm64' : '64'),
          'bin',
          'workerd',
        ),
      ),
    },
    registry: hub,
    root: process.getuid?.() === 0,
    systemd:
      spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }).status === 0,
    tools: Object.fromEntries(['cargo', 'passt', ...nsTools].map((name) => [name, which(name)])),
    user: Os.userInfo().username,
    worker:
      worker === undefined
        ? undefined
        : 'said' in worker
          ? { kind: 'unreached', said: worker.said }
          : worker,
    workerUrl: input.url,
  }
}
