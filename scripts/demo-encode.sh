#!/usr/bin/env bash
# Encode the latest demo recording (artifacts/demo/*.webm) into
# docs/submission/demo.mp4 with per-beat burned-in captions from beats.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="${DEMO_DIR:-$ROOT/artifacts/demo}"
OUT_DIR="$ROOT/docs/submission"
OUT="${DEMO_OUT:-$OUT_DIR/demo.mp4}"
BEATS="$DEMO_DIR/beats.json"
MAX_SECONDS=180
CAPTIONS_DIR="$DEMO_DIR/captions"
FRAMES_DIR="$DEMO_DIR/frames"

fail() {
  echo "demo-encode: $*" >&2
  exit 1
}

[ -f "$BEATS" ] || fail "missing $BEATS; run scripts/demo-record.ts first"

WEBM="$(ls -t "$DEMO_DIR"/*.webm 2>/dev/null | head -n 1 || true)"
[ -n "$WEBM" ] || fail "no .webm recording found in $DEMO_DIR"
echo "demo-encode: source $WEBM"

FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
if [ ! -f "$FONT" ]; then
  FONT="$(find /usr/share/fonts -type f -name '*.ttf' 2>/dev/null | head -n 1 || true)"
fi
[ -n "$FONT" ] && [ -f "$FONT" ] || fail "no TTF font available for drawtext"
echo "demo-encode: caption font $FONT"

rm -rf "$CAPTIONS_DIR" "$FRAMES_DIR"
mkdir -p "$CAPTIONS_DIR" "$FRAMES_DIR" "$OUT_DIR"

FILTER="$(
  BEATS_FILE="$BEATS" CAPTIONS_DIR="$CAPTIONS_DIR" FONT_FILE="$FONT" \
  node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const beats = JSON.parse(readFileSync(process.env.BEATS_FILE, "utf8"));
const captions = Array.isArray(beats.captions) ? beats.captions : [];
const parts = [];
let index = 0;
for (const caption of captions) {
  const start = Math.max(0, Number(caption.startMs) / 1000);
  const end = Math.max(start + 0.5, Number(caption.endMs) / 1000);
  const textFile = `${process.env.CAPTIONS_DIR}/caption-${index}.txt`;
  writeFileSync(textFile, String(caption.text));
  parts.push(
    [
      `drawtext=fontfile=${process.env.FONT_FILE}`,
      `textfile=${textFile}`,
      "x=(w-text_w)/2",
      "y=h-92",
      "fontsize=34",
      "fontcolor=white",
      "box=1",
      "boxcolor=black@0.55",
      "boxborderw=16",
      `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`,
    ].join(":")
  );
  index += 1;
}
if (parts.length === 0) {
  console.error("beats.json has no captions");
  process.exit(1);
}
process.stdout.write(parts.join(","));
NODE
)" || fail "could not build the drawtext filtergraph from $BEATS"

ffmpeg -y -nostdin -v error -i "$WEBM" \
  -vf "$FILTER" \
  -r 30 \
  -c:v libx264 -pix_fmt yuv420p -crf 23 -preset veryfast \
  -movflags +faststart -an "$OUT" || fail "ffmpeg encode failed"

DURATION="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$OUT")"
SIZE_BYTES="$(stat -c%s "$OUT")"
echo "demo-encode: wrote $OUT duration=${DURATION}s size=$((SIZE_BYTES / 1024))KiB"

awk -v d="$DURATION" -v max="$MAX_SECONDS" 'BEGIN { if (d + 0 >= max + 0) exit 1 }' ||
  fail "duration ${DURATION}s is not under ${MAX_SECONDS}s"

FRAMES_FILE="$CAPTIONS_DIR/frames.txt"
BEATS_FILE="$BEATS" CAPTIONS_DIR="$CAPTIONS_DIR" \
  node --input-type=module <<'NODE' > "$FRAMES_FILE"
import { readFileSync } from "node:fs";

const beats = JSON.parse(readFileSync(process.env.BEATS_FILE, "utf8"));
const captions = Array.isArray(beats.captions) ? beats.captions : [];
const lines = [];
if (captions.length > 0) {
  const wanted = Math.min(4, captions.length);
  const indices = new Set();
  for (let i = 0; i < wanted; i += 1) {
    indices.add(Math.round((i * (captions.length - 1)) / Math.max(1, wanted - 1)));
  }
  for (const index of [...indices].sort((a, b) => a - b)) {
    const caption = captions[index];
    const start = Number(caption.startMs) || 0;
    const end = Number(caption.endMs) || start;
    const mid = (start + end) / 2 / 1000;
    lines.push(`${mid.toFixed(3)}\tcap-${index + 1}`);
  }
} else {
  for (const [index, time] of [5, 20, 40, 60].entries()) {
    lines.push(`${time.toFixed(3)}\tframe-${index + 1}`);
  }
}
process.stdout.write(`${lines.join("\n")}\n`);
NODE

while IFS=$'\t' read -r time name; do
  [ -n "${time:-}" ] || continue
  ffmpeg -y -nostdin -v error -ss "$time" -i "$OUT" -frames:v 1 "$FRAMES_DIR/$name.png"
done < "$FRAMES_FILE"

echo "demo-encode: extracted $(ls "$FRAMES_DIR" | wc -l) frame(s) into $FRAMES_DIR"
