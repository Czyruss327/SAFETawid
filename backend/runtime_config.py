"""Strict parsers for backend environment configuration."""

import math
import os
import re


def read_int(name, default, minimum=None, maximum=None):
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"{name} must be a whole number; received {raw!r}.") from error
    if minimum is not None and value < minimum:
        raise RuntimeError(f"{name} must be at least {minimum}.")
    if maximum is not None and value > maximum:
        raise RuntimeError(f"{name} must be at most {maximum}.")
    return value


def read_float(name, default, minimum=None, maximum=None):
    raw = os.getenv(name, str(default)).strip()
    try:
        value = float(raw)
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"{name} must be a number; received {raw!r}.") from error
    if not math.isfinite(value):
        raise RuntimeError(f"{name} must be finite.")
    if minimum is not None and value < minimum:
        raise RuntimeError(f"{name} must be at least {minimum}.")
    if maximum is not None and value > maximum:
        raise RuntimeError(f"{name} must be at most {maximum}.")
    return value


def read_bool(name, default=False):
    raw = os.getenv(name, "true" if default else "false").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be true or false; received {raw!r}.")


def read_device(name, default="auto"):
    value = os.getenv(name, default).strip().lower()
    if value in {"auto", "cpu", "cuda"} or re.fullmatch(r"cuda:[0-9]+|[0-9]+", value):
        return value
    raise RuntimeError(f"{name} must be auto, cpu, cuda, cuda:N, or a CUDA device index.")
