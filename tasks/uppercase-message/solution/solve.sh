#!/bin/sh
set -eu

tr '[:lower:]' '[:upper:]' < message.txt > message.upper.txt
