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

if [ -f "$DEMO_DIR/demo.webm" ]; then
  WEBM="$DEMO_DIR/demo.webm"
else
  WEBM="$(ls -t "$DEMO_DIR"/*.webm 2>/dev/null | head -n 1 || true)"
fi
[ -n "$WEBM" ] && [ -f "$WEBM" ] || fail "no .webm recording found in $DEMO_DIR"
echo "demo-encode: source $WEBM"

FRAME_WIDTH="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$WEBM" | head -n 1)"
FRAME_WIDTH="${FRAME_WIDTH:-1280}"

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
  FRAME_WIDTH="$FRAME_WIDTH" \
  node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const beats = JSON.parse(readFileSync(process.env.BEATS_FILE, "utf8"));
const captions = Array.isArray(beats.captions) ? beats.captions : [];
const frameWidth = Number(process.env.FRAME_WIDTH) || 1280;
const fontSize = 34;
const boxBorder = 16;
const maxTextWidth = frameWidth - boxBorder * 2 - 64;
const maxChars = Math.max(12, Math.floor(maxTextWidth / (fontSize * 0.62)));

function wrapCaption(text) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && candidate.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

const parts = [];
let index = 0;
for (const caption of captions) {
  const start = Math.max(0, Number(caption.startMs) / 1000);
  const end = Math.max(start + 0.5, Number(caption.endMs) / 1000);
  const lines = wrapCaption(caption.text);
  const textFile = `${process.env.CAPTIONS_DIR}/caption-${index}.txt`;
  writeFileSync(textFile, lines.join("\n"));
  const yOffset = (lines.length - 1) * (fontSize + 6);
  parts.push(
    [
      `drawtext=fontfile=${process.env.FONT_FILE}`,
      `textfile=${textFile}`,
      "x=(w-text_w)/2",
      `y=h-${92 + yOffset}`,
      `fontsize=${fontSize}`,
      "fontcolor=white",
      "box=1",
      "boxcolor=black@0.55",
      `boxborderw=${boxBorder}`,
      "text_align=center",
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

# Programmatic caption-width check: every wrapped line, plus the drawtext box
# border, must fit inside the frame. Uses PIL when available (same TTF font).
if python3 -c "import PIL" >/dev/null 2>&1; then
  FONT_FILE="$FONT" FRAME_WIDTH="$FRAME_WIDTH" BOX_BORDER=16 FONTSIZE=34 \
  CAPTIONS_DIR="$CAPTIONS_DIR" \
  python3 - <<'CHECK' || fail "caption width check failed"
import os
import sys

from PIL import ImageFont

font = ImageFont.truetype(os.environ["FONT_FILE"], int(os.environ["FONTSIZE"]))
frame_width = int(os.environ["FRAME_WIDTH"])
box_border = int(os.environ["BOX_BORDER"])
limit = frame_width - 2 * box_border
problems = []
for name in sorted(os.listdir(os.environ["CAPTIONS_DIR"])):
    if not (name.startswith("caption-") and name.endswith(".txt")):
        continue
    path = os.path.join(os.environ["CAPTIONS_DIR"], name)
    with open(path, encoding="utf-8") as handle:
        for line in handle.read().splitlines():
            left, _, right, _ = font.getbbox(line)
            width = right - left
            status = "OK" if width <= limit else "CLIPPED"
            print(f"  {name}: line={width + 2 * box_border}px (limit {frame_width}px) {status}")
            if width > limit:
                problems.append((name, width, line))
if problems:
    for name, width, line in problems:
        print(f"caption width check: {name} line too wide: {width}px text {line!r}", file=sys.stderr)
    sys.exit(1)
CHECK
else
  echo "demo-encode: python3/PIL not available; skipping programmatic caption width check"
fi

FRAMES_FILE="$CAPTIONS_DIR/frames.txt"
BEATS_FILE="$BEATS" CAPTIONS_DIR="$CAPTIONS_DIR" \
  node --input-type=module <<'NODE' > "$FRAMES_FILE"
import { readFileSync } from "node:fs";

const beats = JSON.parse(readFileSync(process.env.BEATS_FILE, "utf8"));
const captions = Array.isArray(beats.captions) ? beats.captions : [];
const lines = [];
if (captions.length > 0) {
  for (const [index, caption] of captions.entries()) {
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
