#!/usr/bin/env python3
import argparse
import base64
import json
import math
import sys
import time


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def round_float(value, digits=4):
    try:
        return round(float(value), digits)
    except Exception:
        return 0.0


def pcm_rms(pcm):
    try:
        if pcm.size == 0:
            return 0.0
        return float(np.sqrt(np.mean(np.square(pcm.astype(np.float32)))))
    except Exception:
        return 0.0


def finite_float_or_none(value):
    try:
        parsed = float(value)
    except Exception:
        return None
    return parsed if math.isfinite(parsed) else None


def normalize_label(value):
    if not isinstance(value, str):
        return ""
    out = []
    for ch in value.strip().lower():
        if ch.isalnum():
            out.append(ch)
        elif ch in (" ", "-", "_"):
            out.append(" ")
    return " ".join("".join(out).split())


def choose_target_label(requested_wake_word, available_labels, allow_approximate=False):
    if not available_labels:
        return ""
    normalized_to_raw = {}
    for raw in available_labels:
        normalized_to_raw[normalize_label(raw)] = raw

    requested = normalize_label(requested_wake_word)
    exact = normalized_to_raw.get(requested)
    if exact:
        return exact

    if not allow_approximate:
        return ""

    preferred = {
        "hey groovy": ["hey mycroft", "hey jarvis", "alexa"],
        "hey mycroft": ["hey mycroft"],
        "hey jarvis": ["hey jarvis"],
        "alexa": ["alexa"],
        "ok google": ["ok google"],
    }
    candidates = preferred.get(requested, [requested]) + [
        "hey mycroft",
        "hey jarvis",
        "alexa",
    ]
    for candidate in candidates:
        raw = normalized_to_raw.get(normalize_label(candidate))
        if raw:
            return raw
    return available_labels[0]


def main():
    parser = argparse.ArgumentParser(description="openWakeWord frame scorer")
    parser.add_argument("--wake-word", default="hey groovy")
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--model-path", default="")
    parser.add_argument("--allow-approximate", action="store_true")
    args = parser.parse_args()

    threshold = max(0.0, min(1.0, float(args.threshold)))
    wake_word = (args.wake_word or "hey groovy").strip()
    model_path = (args.model_path or "").strip()
    cooldown_seconds = 1.5

    try:
        import numpy as np  # type: ignore
        from openwakeword.model import Model  # type: ignore
    except Exception as exc:
        emit(
            {
                "type": "error",
                "detail": f"openwakeword_import_failed:{type(exc).__name__}:{exc}",
            }
        )
        return 2

    try:
        if model_path:
            model = Model(wakeword_models=[model_path])
        else:
            model = Model()
    except Exception as exc:
        emit(
            {
                "type": "error",
                "detail": f"openwakeword_model_init_failed:{type(exc).__name__}:{exc}",
            }
        )
        return 3

    models_obj = getattr(model, "models", {})
    if isinstance(models_obj, dict):
        available_labels = list(models_obj.keys())
    else:
        available_labels = []
    target_label = choose_target_label(
        wake_word,
        available_labels,
        allow_approximate=bool(args.allow_approximate),
    )
    if not model_path and not target_label:
        emit(
            {
                "type": "error",
                "detail": "openwakeword_model_not_found_for_wake_word",
                "wake_word": wake_word,
                "available_models": available_labels,
            }
        )
        return 4
    ready_model_label = target_label or (available_labels[0] if len(available_labels) == 1 else "")
    effective_wake_word = wake_word if model_path else target_label or wake_word
    approximate_match = normalize_label(effective_wake_word) != normalize_label(wake_word)

    emit(
        {
            "type": "ready",
            "requested_wake_word": wake_word,
            "effective_wake_word": effective_wake_word,
            "model_label": ready_model_label,
            "threshold": threshold,
            "allow_approximate": bool(args.allow_approximate),
            "approximate_match": approximate_match,
            "model_path": model_path,
            "available_models_count": len(available_labels),
            "available_models_preview": available_labels[:12],
        }
    )

    last_detect_at = 0.0
    last_near_miss_at = 0.0
    peak_score = 0.0
    peak_top_label = ""
    peak_top_score = 0.0
    peak_rms = 0.0
    peak_raw_rms = 0.0
    score_sum = 0.0
    rms_sum = 0.0
    raw_rms_sum = 0.0
    peak_report_at = time.time()
    frame_count = 0
    frames_since_debug = 0
    near_miss_count = 0
    near_miss_threshold = threshold * 0.75 if threshold > 0 else 0.05
    near_miss_cooldown_seconds = 1.25
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        msg_type = str(msg.get("type") or "").strip().lower()
        if msg_type == "shutdown":
            break
        if msg_type != "frame":
            continue

        audio_b64 = str(msg.get("audio") or "")
        if not audio_b64:
            continue

        try:
            audio_bytes = base64.b64decode(audio_b64)
            pcm = np.frombuffer(audio_bytes, dtype=np.int16)
        except Exception:
            continue
        if pcm.size == 0:
            continue

        raw_rms_from_msg = finite_float_or_none(msg.get("raw_rms"))
        denoised_rms_from_msg = finite_float_or_none(msg.get("denoised_rms"))

        try:
            scores = model.predict(pcm)
        except Exception:
            continue
        if not isinstance(scores, dict) or not scores:
            continue

        frame_count += 1
        frames_since_debug += 1
        top_label = max(scores, key=scores.get)
        top_score = float(scores.get(top_label, 0.0) or 0.0)
        label = target_label if target_label in scores else top_label
        score = float(scores.get(label, 0.0) or 0.0)
        rms = denoised_rms_from_msg
        if rms is None:
            rms = pcm_rms(pcm)
        raw_rms = raw_rms_from_msg if raw_rms_from_msg is not None else rms
        score_sum += score
        rms_sum += rms
        raw_rms_sum += raw_rms
        if score > peak_score:
            peak_score = score
        if top_score >= peak_top_score:
            peak_top_score = top_score
            peak_top_label = top_label
        if rms > peak_rms:
            peak_rms = rms
        if raw_rms > peak_raw_rms:
            peak_raw_rms = raw_rms
        now = time.time()
        if now - peak_report_at >= 5.0:
            emit(
                {
                    "type": "score_debug",
                    "model_label": label,
                    "target_label": target_label,
                    "requested_wake_word": wake_word,
                    "effective_wake_word": effective_wake_word,
                    "current_score": round_float(score),
                    "peak_score": round(peak_score, 4),
                    "avg_score": round_float(score_sum / max(1, frames_since_debug)),
                    "top_label": top_label,
                    "top_score": round_float(top_score),
                    "peak_top_label": peak_top_label or top_label,
                    "peak_top_score": round_float(peak_top_score),
                    "threshold": threshold,
                    "near_miss_threshold": round_float(near_miss_threshold),
                    "rms": round_float(rms, 2),
                    "peak_rms": round_float(peak_rms, 2),
                    "avg_rms": round_float(rms_sum / max(1, frames_since_debug), 2),
                    "raw_rms": round_float(raw_rms, 2),
                    "peak_raw_rms": round_float(peak_raw_rms, 2),
                    "avg_raw_rms": round_float(
                        raw_rms_sum / max(1, frames_since_debug), 2
                    ),
                    "denoised_rms": round_float(rms, 2),
                    "peak_denoised_rms": round_float(peak_rms, 2),
                    "avg_denoised_rms": round_float(
                        rms_sum / max(1, frames_since_debug), 2
                    ),
                    "frames": frame_count,
                    "frames_since_debug": frames_since_debug,
                    "near_miss_count": near_miss_count,
                }
            )
            peak_score = 0.0
            peak_top_label = ""
            peak_top_score = 0.0
            peak_rms = 0.0
            peak_raw_rms = 0.0
            score_sum = 0.0
            rms_sum = 0.0
            raw_rms_sum = 0.0
            peak_report_at = now
            frames_since_debug = 0
            near_miss_count = 0
        if threshold > 0 and score < threshold and score >= near_miss_threshold:
            near_miss_count += 1
            if now - last_near_miss_at >= near_miss_cooldown_seconds:
                last_near_miss_at = now
                emit(
                    {
                        "type": "wake_near_miss",
                        "model_label": label,
                        "target_label": target_label,
                        "top_label": top_label,
                        "top_score": round_float(top_score),
                        "score": round_float(score),
                        "threshold": threshold,
                        "score_ratio": round_float(score / threshold),
                        "near_miss_threshold": round_float(near_miss_threshold),
                        "rms": round_float(rms, 2),
                        "raw_rms": round_float(raw_rms, 2),
                        "denoised_rms": round_float(rms, 2),
                        "frames": frame_count,
                        "ts": int(now * 1000),
                    }
                )
        if score >= threshold and (now - last_detect_at) >= cooldown_seconds:
            last_detect_at = now
            emit(
                {
                    "type": "wake_detected",
                    "model_label": label,
                    "target_label": target_label,
                    "top_label": top_label,
                    "top_score": round_float(top_score),
                    "score": round_float(score),
                    "threshold": threshold,
                    "score_ratio": round_float(score / threshold) if threshold > 0 else 1.0,
                    "rms": round_float(rms, 2),
                    "raw_rms": round_float(raw_rms, 2),
                    "denoised_rms": round_float(rms, 2),
                    "frames": frame_count,
                    "ts": int(now * 1000),
                }
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
