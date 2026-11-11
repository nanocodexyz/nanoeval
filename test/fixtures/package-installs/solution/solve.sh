#!/bin/sh
set -eu

python -c 'import six; print(six.__version__)' >version.txt
