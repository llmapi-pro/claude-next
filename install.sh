#!/usr/bin/env bash
# Install the /next skill hook into ~/.claude/settings.json.
# Idempotent, backs up existing settings, preserves all other fields.
# Uses Perl (JSON::PP core) instead of Python for Windows git-bash compatibility.
set -euo pipefail

SKILL_DIR="$HOME/.claude/skills/next"
SETTINGS="$HOME/.claude/settings.json"
RUNTIME_DIR="$HOME/.claude/next"
HOOK_CMD='bash "$HOME/.claude/skills/next/scripts/ingest.sh"'

echo "━━━ /next skill installer ━━━"
echo ""

# ---- [1/5] Preflight ----
echo "[1/5] Preflight checks..."

if [ ! -d "$SKILL_DIR" ]; then
  echo "  ✗ Skill directory missing: $SKILL_DIR"
  exit 1
fi

if ! command -v perl >/dev/null 2>&1; then
  echo "  ✗ perl not found (required for JSON parsing)."
  exit 1
fi

if ! perl -MJSON::PP -e 1 2>/dev/null; then
  echo "  ✗ Perl JSON::PP module unavailable (should be core since Perl 5.14)."
  exit 1
fi
echo "  ✓ perl + JSON::PP available"

chmod +x "$SKILL_DIR/scripts/"*.sh 2>/dev/null || true
echo "  ✓ Scripts executable"

mkdir -p "$RUNTIME_DIR/pending"
echo "  ✓ Runtime dir: $RUNTIME_DIR/pending"

# ---- [2/5] Backup ----
echo ""
echo "[2/5] Backing up settings.json..."

if [ -f "$SETTINGS" ]; then
  BACKUP="$SETTINGS.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$SETTINGS" "$BACKUP"
  echo "  ✓ Backup: $BACKUP"
else
  echo "  • No existing settings.json; creating fresh."
  echo '{}' > "$SETTINGS"
fi

# ---- [3/5] Merge hook ----
echo ""
echo "[3/5] Merging UserPromptSubmit hook..."

SETTINGS_PATH="$SETTINGS" HOOK_CMD="$HOOK_CMD" perl -MJSON::PP -e '
use strict; use warnings;
my $path = $ENV{SETTINGS_PATH};
my $cmd  = $ENV{HOOK_CMD};

# Slurp file
open my $fh, "<:encoding(UTF-8)", $path or die "cannot read $path: $!";
my $raw = do { local $/; <$fh> };
close $fh;

my $s = eval { decode_json($raw) } // {};
$s = {} unless ref $s eq "HASH";

$s->{hooks} //= {};
$s->{hooks}{UserPromptSubmit} //= [];
my $ups = $s->{hooks}{UserPromptSubmit};

# Check if already present. Match by substring on next/scripts/ingest.sh
# rather than exact-equal, so users who tweaked the cmd (added 2>/dev/null,
# different quoting, alternate path expansion, etc.) avoid duplicate
# hook registration on re-install.
my $already = 0;
for my $e (@$ups) {
  next unless ref $e eq "HASH" && ref $e->{hooks} eq "ARRAY";
  for my $h (@{$e->{hooks}}) {
    if (ref $h eq "HASH" && (($h->{command} // "") =~ m{next/scripts/ingest\.sh})) {
      $already = 1; last;
    }
  }
  last if $already;
}

if ($already) {
  print "  • /next hook already present; skipping add.\n";
  exit 0;
}

push @$ups, { hooks => [ { type => "command", command => $cmd } ] };

my $json = JSON::PP->new->utf8->pretty->canonical->encode($s);
open my $out, ">:encoding(UTF-8)", $path or die "cannot write $path: $!";
print $out $json;
close $out;
print "  ✓ Hook added.\n";
'

# ---- [4/5] Verify ----
echo ""
echo "[4/5] Verifying..."

SETTINGS_PATH="$SETTINGS" perl -MJSON::PP -e '
use strict; use warnings;
my $path = $ENV{SETTINGS_PATH};
open my $fh, "<:encoding(UTF-8)", $path or die;
my $raw = do { local $/; <$fh> };
close $fh;
my $s = decode_json($raw);
my $ups = $s->{hooks}{UserPromptSubmit} // [];
my $found = 0;
my $total = 0;
for my $e (@$ups) {
  $total++;
  for my $h (@{$e->{hooks} // []}) {
    $found = 1 if ($h->{command} // "") =~ /next\/scripts\/ingest\.sh/;
  }
}
if (!$found) { print "  ✗ Hook verification failed.\n"; exit 1; }
print "  ✓ Hook in place. Total UserPromptSubmit entries: $total\n";
'

# ---- [5/5] Dry-run ----
echo ""
echo "[5/5] Dry-run hook..."

# Empty input
if echo '{}' | bash "$SKILL_DIR/scripts/ingest.sh" >/dev/null 2>&1; then
  echo "  ✓ empty input → exit 0"
else
  rc=$?
  echo "  ⚠ empty input → exit $rc (should be 0)"
fi

# Non-matching prompt
out=$(echo '{"prompt":"hello world","session_id":"test","hook_event_name":"UserPromptSubmit"}' \
      | bash "$SKILL_DIR/scripts/ingest.sh" 2>/dev/null || true)
if [ -z "$out" ]; then
  echo "  ✓ non-matching prompt → silent passthrough"
else
  echo "  ⚠ non-matching prompt produced output:"
  echo "    $out"
fi

# Matching prompt with missing slot — should report "slot ZZ does not exist"
out=$(echo '{"prompt":"continue ZZ","session_id":"test","hook_event_name":"UserPromptSubmit"}' \
      | bash "$SKILL_DIR/scripts/ingest.sh" 2>/dev/null || true)
if echo "$out" | grep -q "slot ZZ does not exist"; then
  echo "  ✓ continue ZZ → informative missing-slot message"
else
  echo "  ⚠ continue-with-missing-slot test unexpected output:"
  echo "    $out" | head -3
fi

# False-positive guard: 'next step is to fix bug' must NOT trigger
out=$(echo '{"prompt":"next step is to fix the auth bug","session_id":"test","hook_event_name":"UserPromptSubmit"}' \
      | bash "$SKILL_DIR/scripts/ingest.sh" 2>/dev/null || true)
if [ -z "$out" ]; then
  echo "  ✓ 'next step is...' → silent passthrough (no false positive)"
else
  echo "  ⚠ 'next step is...' triggered the hook — false positive!"
fi

echo ""
echo "━━━ Install complete ━━━"
echo ""
echo "Next steps:"
echo "  1. Open a new Claude Code window. Try   /next list   (should say: No pending handoffs.)"
echo "  2. In a real project, run   /next   to produce your first handoff."
echo "  3. Open another window and paste   continue X   (or  next X  /  继续 X) to verify continuation."
echo ""
echo "Uninstall:"
echo "  rm -rf $SKILL_DIR $RUNTIME_DIR"
echo "  restore settings: cp $SETTINGS.bak-<latest> $SETTINGS"
echo ""
