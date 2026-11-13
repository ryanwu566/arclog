"""可重現的亂數產生器（mulberry32），和 web/js/core/prng.js 產生同一串數字。"""
import math

_MASK = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & _MASK


def mulberry32(seed: int):
    """回傳一個函式，每次呼叫給 [0, 1) 的數。"""
    state = [seed & _MASK]

    def nxt() -> float:
        state[0] = (state[0] + 0x6D2B79F5) & _MASK
        t = state[0]
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & _MASK
        return ((t ^ (t >> 14)) & _MASK) / 4294967296

    return nxt


def rand_int(rng, n: int) -> int:
    """0 到 n-1 的整數。"""
    return math.floor(rng() * n)


def rand_normal(rng) -> float:
    """常態分布亂數（Box–Muller）。"""
    u = rng()
    if u < 1e-12:
        u = 1e-12
    v = rng()
    return math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * v)
