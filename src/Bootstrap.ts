import type * as Eval from './Eval.ts'
import * as Sandbox from './Sandbox.ts'

export type Node = {
  major: number
  release: string
  sha256: { arm64: string; x64: string }
  version: string
}

export const node: Node = {
  major: 20,
  release: 'https://nodejs.org/dist',
  sha256: {
    arm64: '95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2',
    x64: '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9',
  },
  version: 'v24.22.2',
}

export const files = {
  config: 'runner.json',
  hand: 'nanocode',
  marks: 'bootstrap.marks',
  runner: 'runner.mjs',
  script: 'bootstrap.sh',
  tools: 'krun',
}

export function script(input: script.Input): string {
  const quote = Sandbox.quote
  const runtime = input.node ?? node
  const blob = input.url.replace(/\/+$/, '') + '/v1/runs/' + input.run + '/runner/blobs/'
  return [
    'set -eu',
    'umask 077',
    'if [ "$(id -u)" = 0 ]; then as=; else as="sudo -n"; fi',
    'home=' + quote(input.home),
    'cache=' + quote(input.cache ?? input.home + '/cache'),
    'runtime=$cache/runtime/' + input.runtime.digest,
    '$as mkdir -p "$home" "$cache/runtime"',
    ...(input.config === undefined
      ? []
      : [
          '$as tee "$home/' + files.config + "\" >/dev/null <<'NANOEVAL_CONFIG'",
          input.config,
          'NANOEVAL_CONFIG',
        ]),
    'mark() { printf \'%s %s\\n\' "$1" "$(date +%s%3N)" | $as tee -a "$home/' +
      files.marks +
      '" >/dev/null; }',
    'mark bootstrap.start',
    'fetch_runtime() {',
    '  cd "$cache/runtime"',
    '  $as curl -fsS --retry 5 -H ' +
      quote('authorization: Bearer ' + input.token) +
      ' -o runtime.tgz ' +
      quote(blob + input.runtime.digest),
    '  mark bootstrap.runtime.fetched',
    "  printf '%s  runtime.tgz\\n' " + quote(input.runtime.digest) + ' | sha256sum -c - >/dev/null',
    '  $as rm -rf runtime.new',
    '  $as mkdir runtime.new',
    '  $as tar -xzf runtime.tgz -C runtime.new',
    '  $as rm runtime.tgz',
    '  $as mv runtime.new "$runtime"',
    '}',
    'fetching=',
    'if [ ! -f "$runtime/' + files.runner + '" ]; then',
    '  fetch_runtime &',
    '  fetching=$!',
    'fi',
    'cd "$cache"',
    'node=$(command -v node || true)',
    'if [ -z "$node" ] || [ "$("$node" -p ' +
      quote('Number(process.versions.node.split(".")[0]) >= ' + runtime.major) +
      ')" != true ]; then',
    '  case $(uname -m) in',
    '    x86_64) arch=x64 sum=' + quote(runtime.sha256.x64) + ' ;;',
    '    aarch64 | arm64) arch=arm64 sum=' + quote(runtime.sha256.arm64) + ' ;;',
    '    *) echo "nanoeval has no Node for $(uname -m)" >&2; exit 1 ;;',
    '  esac',
    '  if [ ! -x node/bin/node ]; then',
    '    $as curl -fsSL --retry 5 -o node.tgz ' +
      quote(runtime.release + '/' + runtime.version + '/node-' + runtime.version + '-linux-') +
      '"$arch".tar.gz',
    '    printf \'%s  node.tgz\\n\' "$sum" | sha256sum -c - >/dev/null',
    '    $as rm -rf node',
    '    $as mkdir node',
    '    $as tar -xzf node.tgz -C node --strip-components 1',
    '    $as rm node.tgz',
    '  fi',
    '  node=$cache/node/bin/node',
    'fi',
    'mark bootstrap.node',
    'if [ -n "$fetching" ]; then wait "$fetching"; fi',
    'mark bootstrap.runtime',
    'exec $as env NANOEVAL_CACHE="$cache" NANOEVAL_KRUN="$runtime/' +
      files.tools +
      '" NANOEVAL_NANOCODE="$runtime/' +
      files.hand +
      '" PATH="$PATH" "$node" "$runtime/' +
      files.runner +
      '" runner --detach --config "$home/' +
      files.config +
      '"',
    '',
  ].join('\n')
}

export declare namespace script {
  type Input = {
    cache?: string
    config?: string
    home: string
    node?: Node
    run: string
    runtime: Eval.Blob
    token: string
    url: string
  }
}
