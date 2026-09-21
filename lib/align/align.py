"""Re-time an existing transcript's words against the audio with WhisperX's wav2vec2 aligner.

Usage: python align.py <audio-or-video> <segments.json> <out.json> [language]
segments.json: [{"start": s, "end": e, "text": "words separated by spaces"}, ...]
out.json: [{"words": [{"start": s, "end": e} | {}], ...}] one entry per input segment, one word per space-split
token, empty when the aligner couldn't place that word. Progress lines go to stderr.
"""
import json
import sys

import whisperx


def main():
    src, seg_path, out_path = sys.argv[1:4]
    language = sys.argv[4] if len(sys.argv) > 4 else "en"
    segments = json.load(open(seg_path))
    audio = whisperx.load_audio(src)
    model, metadata = whisperx.load_align_model(language_code=language, device="cpu")
    out = []
    # Aligned in chunks so progress can be reported and one bad stretch can't sink the whole episode.
    chunk = 40
    for i in range(0, len(segments), chunk):
        part = segments[i : i + chunk]
        try:
            result = whisperx.align(part, model, metadata, audio, "cpu", return_char_alignments=False)
            aligned = result.get("segments", [])
        except Exception as err:  # keep going; these segments keep their original timings
            print(f"align failed for segments {i}-{i + len(part)}: {err}", file=sys.stderr)
            aligned = []
        for k, seg in enumerate(part):
            tokens = seg["text"].split()
            words = aligned[k].get("words", []) if k < len(aligned) else []
            if len(words) != len(tokens):
                out.append({"words": [{} for _ in tokens]})
                continue
            out.append({"words": [{"start": w["start"], "end": w["end"]} if "start" in w and "end" in w else {} for w in words]})
        print(f"PROGRESS {min(len(segments), i + chunk)}/{len(segments)}", file=sys.stderr, flush=True)
    json.dump(out, open(out_path, "w"))


if __name__ == "__main__":
    main()
