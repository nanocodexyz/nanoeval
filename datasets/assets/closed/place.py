import hashlib
import json
import os
import sys
import tarfile

tests, logs = sys.argv[1], sys.argv[2]
manifest = json.load(open(os.path.join(tests, 'gold-manifest.json')))
archive = tarfile.open(os.path.join(tests, 'gold.tar'))
members = {member.name: member for member in archive.getmembers() if member.isfile()}
root = os.path.realpath(os.getcwd())
files = manifest['files']
if not files:
    sys.exit('ERROR: the gold manifest lists no file')
modified = []
for entry in files:
    path = entry['path']
    if path.startswith('/') or '..' in path.split('/') or path not in members:
        sys.exit('ERROR: gold file missing or unsafe: ' + path)
    data = archive.extractfile(members[path]).read()
    if hashlib.sha256(data).hexdigest() != entry['sha256']:
        sys.exit('ERROR: gold file differs from its manifest: ' + path)
    current = None
    if os.path.islink(path):
        current = b'link ' + os.readlink(path).encode()
    elif os.path.isfile(path):
        with open(path, 'rb') as file:
            current = file.read()
    elif os.path.exists(path):
        sys.exit('ERROR: gold path is not a file: ' + path)
    blob = None if current is None else hashlib.sha1(b'blob %d\0' % len(current) + current).hexdigest()
    if blob != entry['base']:
        modified.append(path)
    if os.path.islink(path) or os.path.exists(path):
        os.remove(path)
    parent = os.path.dirname(path)
    if os.path.realpath(os.path.join(root, parent)) != os.path.normpath(os.path.join(root, parent)):
        sys.exit('ERROR: gold directory is a link: ' + parent)
    os.makedirs(os.path.join(root, parent), exist_ok=True)
    with open(path, 'wb') as file:
        file.write(data)
    os.chmod(path, 0o755 if entry['executable'] else 0o644)
os.makedirs(logs, exist_ok=True)
with open(os.path.join(logs, 'tests_modified.json'), 'w') as file:
    json.dump({'paths': modified, 'placed': len(files), 'tests_modified': len(modified)}, file)
print('Placed %d gold test files, tests_modified=%d %s' % (len(files), len(modified), modified))
