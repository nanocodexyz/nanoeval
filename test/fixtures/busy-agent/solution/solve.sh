#!/bin/sh
set -eu

end=$(($(date +%s) + 12)); while [ "$(date +%s)" -lt "$end" ]; do echo "$(date +%s) $(grep Cpus_allowed_list /proc/self/status | tr -dc 0-9,-)" >>busy.txt; done
