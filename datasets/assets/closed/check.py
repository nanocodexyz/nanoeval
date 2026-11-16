import hashlib
import json
import os
import subprocess
import sys

wanted = json.load(open(sys.argv[1]))
root = sys.argv[2]
absent = {entry['blob']: entry['path'] for entry in wanted['blobs']}
sizes = {entry['size'] for entry in wanted['blobs']}
own = {os.path.realpath(path) for path in sys.argv[:2]}
found = []
walked = 0
for directory, names, files in os.walk(root):
    if directory == root:
        names[:] = [name for name in names if name not in ('dev', 'proc', 'run', 'sys')]
    if 'HEAD' in files and 'objects' in names:
        asked = [wanted['fix']] + sorted(absent)
        answer = subprocess.run(
            ['git', '--git-dir', directory, 'cat-file', '--batch-check'],
            input='\n'.join(asked).encode() + b'\n',
            stdout=subprocess.PIPE,
            check=True,
        ).stdout.decode().splitlines()
        for name, line in zip(asked, answer):
            if not line.endswith(' missing'):
                found.append(directory + ' holds the object ' + name)
    for name in files:
        path = os.path.join(directory, name)
        if os.path.islink(path) or not os.path.isfile(path) or path in own:
            continue
        walked += 1
        if os.path.getsize(path) not in sizes:
            continue
        with open(path, 'rb') as file:
            data = file.read()
        blob = hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()
        if blob in absent:
            found.append(path + ' is ' + absent[blob] + ' of the fix commit')
if found:
    sys.exit('closed: the image holds what the fix commit added: ' + '; '.join(found[:20]))
print('closed: %d files read for %d blobs of the fix commit, none found' % (walked, len(absent)))
