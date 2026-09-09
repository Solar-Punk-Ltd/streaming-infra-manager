#!/usr/bin/env bash
# Commit an edit of a version's host-owned configuration as one revision.
#
#   stack-config-edit.sh <root> set <file> <source>...   replace files, then commit
#   stack-config-edit.sh <root> commit                    commit the files as they are
#   stack-config-edit.sh <root> --unlock                  remove a lock whose editor is gone
#
# <root> is a version's flat root (or the bundled one): the directory holding
# .env, deploy/config.json and engines/<engine>/.env. Those three kinds of file
# are the set. `set` takes pairs: a file of the set, relative to the root, and
# the path of its new content, as many pairs as you like, and commits them
# together. `commit` is for an edit already made in place with an editor:
# it records the files as they are now, which is how an edit outside this
# script becomes a revision the manager will capture.
#
# Why a script: the manager captures these files for a build as one committed
# revision, under a lock this script holds for the whole edit, so a build can
# never see one new file and one old. The manifest, .config-revision.json, is
# written last, by rename, and is what makes a revision exist. Two sessions
# editing at once queue on the lock. A lock whose editor died is removed with
# --unlock, by a person who checked that nobody is editing.
set -euo pipefail

readonly LOCK_DIR=".config.lock"
readonly REVISION_FILE=".config-revision.json"
# Overridable for a test that must not wait half a minute on a held lock.
readonly LOCK_WAIT_SECONDS="${LOCK_WAIT_SECONDS_OVERRIDE:-30}"

usage() {
  echo "usage: stack-config-edit.sh <root> set <file> <source>... | <root> commit | <root> --unlock" >&2
  exit 2
}

[ "$#" -ge 2 ] || usage
ROOT="$1"
shift
case "$ROOT" in
  /*) ;;
  *) echo "ERROR: <root> must be an absolute path (got: $ROOT)" >&2; exit 2 ;;
esac
[ -d "$ROOT" ] || { echo "ERROR: $ROOT is not a directory" >&2; exit 2; }

if [ "$1" = "--unlock" ]; then
  if rmdir "$ROOT/$LOCK_DIR" 2>/dev/null; then
    echo "==> Removed $ROOT/$LOCK_DIR"
  else
    echo "==> No lock at $ROOT/$LOCK_DIR"
  fi
  exit 0
fi

# A file of the set, and nothing else: the path decides what may be replaced.
in_set() {
  case "$1" in
    .env) return 0 ;;
    deploy/config.json) return 0 ;;
    engines/*/.env) case "$1" in */../*|../*) return 1 ;; esac; return 0 ;;
    *) return 1 ;;
  esac
}

HELD=0
release() {
  if [ "$HELD" = 1 ]; then
    rmdir "$ROOT/$LOCK_DIR" 2>/dev/null || true
    HELD=0
  fi
}
trap 'release' EXIT

take_lock() {
  local waited=0
  until mkdir "$ROOT/$LOCK_DIR" 2>/dev/null; do
    if [ "$waited" -ge "$LOCK_WAIT_SECONDS" ]; then
      echo "ERROR: the host configuration in $ROOT is being edited: $LOCK_DIR is held. Wait, or run --unlock if you know the editor is gone." >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  HELD=1
}

hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# GNU and busybox spell it one way, BSD another, and only one of the two is
# ever installed.
mode_of() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

# A file of the set holds the stream passphrase and the api token, and the
# versions root above them is readable by anyone on the host. The temporary
# file is created owner only and then takes the mode the target already has,
# so an edit never widens a file and the umask never decides one.
narrow_temp() {
  local temp="$1" target="$2"
  : > "$temp"
  chmod 600 "$temp"
  if [ -f "$target" ]; then
    chmod "$(mode_of "$target")" "$temp"
  fi
}

# Written beside the target and renamed over it, so a reader sees the old file or the new one.
replace_file() {
  local relative="$1" source="$2" target
  in_set "$relative" || { echo "ERROR: $relative is not a file of the set (.env, deploy/config.json, engines/<engine>/.env)" >&2; exit 2; }
  [ -f "$source" ] || { echo "ERROR: $source does not exist" >&2; exit 2; }
  target="$ROOT/$relative"
  mkdir -p "$(dirname "$target")"
  narrow_temp "$target.tmp.$$" "$target"
  cp "$source" "$target.tmp.$$"
  mv -f "$target.tmp.$$" "$target"
  echo "==> Replaced $relative"
}

# The manifest: the generation one up, and the hash of every file of the set present.
write_manifest() {
  local generation=0 manifest="$ROOT/$REVISION_FILE" temp
  if [ -f "$manifest" ]; then
    generation="$(sed -n 's/^[[:space:]]*"generation":[[:space:]]*\([0-9][0-9]*\).*$/\1/p' "$manifest" | head -1)"
    generation="${generation:-0}"
  fi
  generation=$((generation + 1))
  temp="$manifest.tmp.$$"
  narrow_temp "$temp" "$manifest"
  {
    echo "{"
    echo "  \"generation\": $generation,"
    echo "  \"files\": {"
    local first=1 file
    for file in .env deploy/config.json "$ROOT"/engines/*/.env; do
      case "$file" in
        "$ROOT"/*) file="${file#"$ROOT"/}" ;;
      esac
      [ -f "$ROOT/$file" ] || continue
      if [ "$first" = 1 ]; then first=0; else echo ","; fi
      printf '    "%s": "%s"' "$file" "$(hash_of "$ROOT/$file")"
    done
    echo
    echo "  }"
    echo "}"
  } > "$temp"
  mv -f "$temp" "$manifest"
  echo "==> Committed revision $generation of $ROOT"
}

case "$1" in
  set)
    shift
    [ "$#" -ge 2 ] && [ $(( $# % 2 )) -eq 0 ] || usage
    take_lock
    while [ "$#" -ge 2 ]; do
      replace_file "$1" "$2"
      shift 2
    done
    write_manifest
    ;;
  commit)
    take_lock
    write_manifest
    ;;
  *)
    usage
    ;;
esac
