"""Password hashing and tenant-scoping helpers.

No JWT anywhere in DevNexus. Sessions are opaque tokens looked up in DynamoDB,
which buys instant revocation and removes signing-key management entirely.

Passwords are still hashed properly. "Keep auth simple" means no token crypto;
it does not mean storing passwords in a form that a leaked table would expose.
scrypt ships in the standard library, so this costs us no dependency.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

# scrypt parameters. n=2**14 lands around 50-80ms on Lambda ARM64 at 1024MB:
# slow enough to make offline cracking expensive, fast enough that login does
# not feel laggy. Raising n is the lever if that tradeoff ever changes.
_N = 2 ** 14
_R = 8
_P = 1
_DKLEN = 32
_SALT_BYTES = 16


def hash_password(password: str) -> str:
    """Returns `scrypt$n$r$p$salt_hex$hash_hex`.

    Parameters are stored alongside the hash so they can be raised later
    without invalidating existing passwords.
    """
    if not password or len(password) < 8:
        raise ValueError("password must be at least 8 characters")
    salt = secrets.token_bytes(_SALT_BYTES)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=_DKLEN)
    return f"scrypt${_N}${_R}${_P}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time verification. Never raises on malformed input."""
    try:
        scheme, n, r, p, salt_hex, hash_hex = stored.split("$")
        if scheme != "scrypt":
            return False
        dk = hashlib.scrypt(
            password.encode(), salt=bytes.fromhex(salt_hex),
            n=int(n), r=int(r), p=int(p), dklen=len(hash_hex) // 2,
        )
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


def normalize_email(email: str) -> str:
    """Lower-cased and trimmed. This is the partition key for user lookup, so
    `Rahul@ABC.com` and `rahul@abc.com` must resolve to the same item."""
    return (email or "").strip().lower()


def constant_time_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a or "", b or "")
