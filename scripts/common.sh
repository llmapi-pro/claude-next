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
json_get() {
  local key="$1"
  perl -MJSON::PP -e '
    my $k = shift;
    my $in = do { local $/; <STDIN> };
    my $d = eval { decode_json($in) };
    exit 0 unless ref $d eq "HASH";
    my $v = $d->{$k};
    print defined $v ? $v : "";
  ' "$key" 2>/dev/null
}

# Emit UserPromptSubmit hook JSON to stdout with additionalContext from arg or stdin.
json_emit_context() {
  local ctx="${1:-}"
  if [ -z "$ctx" ]; then ctx="$(cat)"; fi
  printf '%s' "$ctx" | perl -MJSON::PP -e '
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
  # A handoff is `<UPPERCASE LETTERS>.md`. Anything else in the pending dir
  # (e.g. `<SLOT>.audit-passA.md` left briefly by the audit subagent before
  # audit-finalize.sh consumes it) is filtered out — it must not be reported
  # as a slot. The basename grep is the boundary; sed only strips `.md`.
  find "$NEXT_PENDING_DIR" -maxdepth 1 -name '*.md' -type f 2>/dev/null \
    | sed -E 's#.*/##' \
    | grep -E '^[A-Z]{1,3}\.md$' \
    | sed -E 's#\.md$##' \
    | sort
}

slot_file() {
  echo "$NEXT_PENDING_DIR/$1.md"
}

frontmatter_get() {
  # $1 = file, $2 = key
  # Strips trailing \r so a CRLF-saved handoff (Windows editor / git autocrlf)
  # parses identically to LF. Without this strip, `^---$` never matches the
  # opening fence on CRLF files and every key returns empty silently.
  awk -v k="$2" '
    { sub(/\r$/, "") }
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
