#!/usr/bin/env bash
# Shared env and helpers for /next scripts. Source this from other scripts.
# Uses Perl (core + JSON::PP) since Windows git-bash ships it but Python often fake.

set -u

NEXT_HOME="${NEXT_HOME:-$HOME/.claude/next}"
NEXT_SKILL_HOME="${NEXT_SKILL_HOME:-$HOME/.claude/skills/next}"
NEXT_PENDING_DIR="$NEXT_HOME/pending"
NEXT_MIN_UNK="${NEXT_MIN_UNK:-3}"

mkdir -p "$NEXT_PENDING_DIR"

# Extract a top-level key from JSON on stdin. Usage: json_get prompt <<<"$input"
# UTF-8: stdin is raw UTF-8 bytes (decode_json expects byte stream), stdout
# emits wide chars via :utf8 layer so Chinese / emoji values survive intact.
json_get() {
  local key="$1"
  perl -MJSON::PP -e '
    binmode STDOUT, ":encoding(UTF-8)";
    my $k = shift;
    my $in = do { local $/; <STDIN> };
    my $d = eval { decode_json($in) };
    exit 0 unless ref $d eq "HASH";
    my $v = $d->{$k};
    print defined $v ? $v : "";
  ' "$key" 2>/dev/null
}

# Emit UserPromptSubmit hook JSON to stdout with additionalContext from arg or stdin.
# UTF-8 contract:
#   - stdin layer  :encoding(UTF-8) — decode incoming bytes to wide chars so
#     encode_json sees codepoints (e.g. 口 = U+53E3) instead of raw byte values
#     (which it would interpret as Latin-1 codepoints and double-encode).
#   - stdout       NO binmode — JSON::PP encode_json defaults to utf8(1) and
#     already emits UTF-8 byte sequences. Adding a :utf8 stdout layer would
#     re-encode those bytes, producing mojibake (e5 → c3 a5) and breaking
#     Claude Code's hook reader with "Failed with non-blocking status code".
json_emit_context() {
  local ctx="${1:-}"
  if [ -z "$ctx" ]; then ctx="$(cat)"; fi
  printf '%s' "$ctx" | perl -MJSON::PP -e '
    binmode STDIN, ":encoding(UTF-8)";
    my $ctx = do { local $/; <STDIN> };
    my $out = {
      hookSpecificOutput => {
        hookEventName => "UserPromptSubmit",
        additionalContext => $ctx,
      },
    };
    print encode_json($out);
  '
}

slots_used() {
  find "$NEXT_PENDING_DIR" -maxdepth 1 -name '*.md' -type f 2>/dev/null \
    | sed -E 's#.*/([A-Z]+)\.md$#\1#' \
    | sort
}

slot_file() {
  echo "$NEXT_PENDING_DIR/$1.md"
}

frontmatter_get() {
  # $1 = file, $2 = key
  awk -v k="$2" '
    BEGIN{infm=0}
    /^---$/ { infm=!infm; next }
    infm && $0 ~ "^" k ":" { sub("^" k ":[ \t]*",""); print; exit }
  ' "$1" 2>/dev/null
}

now_iso() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# Compute "X ago" from ISO timestamp. Print "?" on any failure.
relative_age() {
  local iso="$1"
  [ -z "$iso" ] && { echo "?"; return; }
  perl -MTime::Local -e '
    my $s = shift;
    if ($s =~ /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/) {
      my $epoch = eval { timegm($6, $5, $4, $3, $2 - 1, $1 - 1900) };
      if (defined $epoch) {
        my $d = time() - $epoch;
        if ($d < 0)        { print "future"; }
        elsif ($d < 60)    { printf "%ds ago", $d; }
        elsif ($d < 3600)  { printf "%dm ago", int($d/60); }
        elsif ($d < 86400) { printf "%dh ago", int($d/3600); }
        else               { printf "%dd ago", int($d/86400); }
        exit 0;
      }
    }
    print "?";
  ' "$iso" 2>/dev/null
}

# Hours since ISO timestamp (integer). Print 0 on failure.
age_hours() {
  local iso="$1"
  [ -z "$iso" ] && { echo 0; return; }
  perl -MTime::Local -e '
    my $s = shift;
    if ($s =~ /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/) {
      my $epoch = eval { timegm($6, $5, $4, $3, $2 - 1, $1 - 1900) };
      if (defined $epoch) {
        my $d = time() - $epoch;
        $d = 0 if $d < 0;
        printf "%d", int($d/3600);
        exit 0;
      }
    }
    print 0;
  ' "$iso" 2>/dev/null
}
