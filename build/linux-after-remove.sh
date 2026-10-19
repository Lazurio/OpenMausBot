#!/bin/sh
set -eu

# dpkg runs the old postrm during an upgrade too. Clean up only when the
# package is actually removed or purged.
case "${1:-}" in
  remove|purge) ;;
  *) exit 0 ;;
esac

if [ -n "${OPENMAUSBOT_POSTINSTALL_TEST_ROOT:-}" ]; then
  TEST_ROOT="$(realpath -e -- "$OPENMAUSBOT_POSTINSTALL_TEST_ROOT")"
  case "$TEST_ROOT" in
    /tmp/*) ;;
    *) echo "OpenMausBot test install root must stay under /tmp" >&2; exit 1 ;;
  esac
  TEST_MODE=1
else
  TEST_MODE=0
fi

# Preserve electron-builder's cleanup of the exact legacy launcher. Never
# remove an unrelated file that now happens to use the same command name.
if [ "$TEST_MODE" -eq 0 ]; then
  if command -v update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove openmausbot /opt/OpenMausBot/openmausbot
  elif [ -L /usr/bin/openmausbot ] && [ "$(readlink /usr/bin/openmausbot)" = /opt/OpenMausBot/openmausbot ]; then
    rm -- /usr/bin/openmausbot
  fi
fi
