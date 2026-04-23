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

# Check if already present
my $already = 0;
for my $e (@$ups) {
  next unless ref $e eq "HASH" && ref $e->{hooks} eq "ARRAY";
  for my $h (@{$e->{hooks}}) {
    if (ref $h eq "HASH" && ($h->{command} // "") eq $cmd) {
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

# Matching prompt (no existing slot — should say slot not found)
out=$(echo '{"prompt":"继续 ZZ","session_id":"test","hook_event_name":"UserPromptSubmit"}' \
      | bash "$SKILL_DIR/scripts/ingest.sh" 2>/dev/null || true)
if echo "$out" | grep -q "槽位 ZZ 不存在"; then
  echo "  ✓ matching prompt w/ missing slot → informative message"
else
  echo "  ⚠ matching prompt missing-slot test unexpected output:"
  echo "    $out" | head -3
fi

echo ""
echo "━━━ Install complete ━━━"
echo ""
echo "下一步："
echo "  1. 新开 CC 窗口试  /next list   （应见 'No pending handoffs.'）"
echo "  2. 在真实项目里  /next  产出第一份 handoff"
echo "  3. 再开一个新窗口，粘  继续 X  验证续接"
echo ""
echo "卸载："
echo "  rm -rf $SKILL_DIR $RUNTIME_DIR"
echo "  还原 settings: cp $SETTINGS.bak-<latest> $SETTINGS"
echo ""
