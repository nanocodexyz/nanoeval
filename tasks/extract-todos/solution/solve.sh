#!/bin/sh
set -eu

grep '^- TODO: ' notes.md | sed 's/^- TODO: //' | sort > todos.txt
