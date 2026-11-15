Run this command in the current workspace, which appends a second and the hardware threads of the command to busy.txt for twelve seconds:

```
end=$(($(date +%s) + 12)); while [ "$(date +%s)" -lt "$end" ]; do echo "$(date +%s) $(grep Cpus_allowed_list /proc/self/status | tr -dc 0-9,-)" >>busy.txt; done
```
