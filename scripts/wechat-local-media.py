"""Resolve only local WeChat media; never download URLs or drive the WeChat UI."""
from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import re
import time
import xml.etree.ElementTree as ET

MAX_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 40_000_000


class LocalMediaResolver:
    def __init__(self, db, media, destination: Path):
        self.db, self.media = db, media
        self.destination = destination.resolve()
        self.destination.mkdir(parents=True, exist_ok=True)
        self.account = Path(db.account_dir).resolve()
        self.index = {}
        self.scan = None
        self.scanned_at = 0.0

    def _files(self):
        for folder in ("msg/emoji", "business/emoticon", "cache", "msg/attach"):
            for directory, folders, files in os.walk(self.account / folder, followlinks=False):
                folders[:] = [name for name in folders if not (Path(directory) / name).is_symlink()]
                for name in files:
                    yield Path(directory) / name

    def _read(self, candidate: Path):
        resolved = candidate.resolve()
        if not resolved.is_relative_to(self.account) or not resolved.is_file():
            return None
        if not 0 < resolved.stat().st_size <= MAX_BYTES:
            return None
        # Bound the read even when the cache file changes after stat().
        with resolved.open("rb") as source:
            data = source.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            return None
        if data.startswith((b"\xff\xd8\xff", b"\x89PNG", b"GIF", b"RIFF", b"wxgf")):
            return data
        # Decode from the bounded buffer, including extensionless sticker cache.
        if data.startswith(b"\x07\x08\x56\x32\x08\x07"):
            return self.media._decrypt_v2(data, str(resolved), None, None)
        if data.startswith(b"\x07\x08\x05\x56\x02\x05"):
            key = self.media._derive_xor_key(str(resolved))
            return bytes(value ^ (key & 0xFF) for value in data[22:])
        for header in (b"\xff\xd8\xff", b"\x89PNG", b"GIF8", b"RIFF"):
            key = data[0] ^ header[0]
            if bytes(value ^ key for value in data[:len(header)]) == header:
                return bytes(value ^ key for value in data)
        return None

    def _sticker(self, hashes):
        if not hashes:
            return None
        # Index paths, not image bytes. Resume a bounded walk on the next request,
        # and refresh after a minute so newly downloaded stickers can be found.
        if self.scan is None and time.monotonic() - self.scanned_at > 60:
            self.index.clear()
            self.scan = iter(self._files())
        for digest in hashes:
            if digest in self.index:
                try:
                    data = self._read(self.index[digest])
                    if data:
                        return data
                except OSError:
                    self.index.pop(digest, None)
        deadline, byte_budget = time.monotonic() + 2, 32 * 1024 * 1024
        for _ in range(3000):
            if self.scan is None or time.monotonic() >= deadline:
                break
            try:
                candidate = next(self.scan)
            except StopIteration:
                self.scan = None
                self.scanned_at = time.monotonic()
                break
            keys = set(re.findall(r"[a-f0-9]{32}", candidate.name.lower()))
            data = None
            try:
                if keys.intersection(hashes):
                    data = self._read(candidate)
                elif not keys and byte_budget > 0:
                    size = candidate.stat().st_size
                    if 0 < size <= min(MAX_BYTES, byte_budget):
                        byte_budget -= size
                        data = self._read(candidate)
                        if data:
                            keys.add(hashlib.md5(data).hexdigest())
                for key in keys:
                    if len(self.index) < 10000:
                        self.index[key] = candidate
                if keys.intersection(hashes) and data:
                    return data
            except (OSError, ValueError):
                continue
        return None

    def resolve(self, user_id: str, row: dict, kind: str):
        data = None
        if kind == "image":
            # The caller already resolved the exact shard and message. Avoid the
            # vendor's first-shard local_id lookup, which may select another image.
            digest = self.media._img_md5({"packed_info": row.get("packed_info_data"),
                                           "content": row.get("message_content")})
            if not digest:
                content = row.get("message_content")
                match = re.search(r'md5=["\']([a-fA-F0-9]{32})["\']', content or "") if isinstance(content, str) else None
                digest = match.group(1).lower() if match else None
            if not digest:
                return None
            candidate = self.media._find_dat(user_id, digest, row["create_time"])
            if not candidate:
                candidate = self.media._find_dat(user_id, digest, row["create_time"], thumbnail=True)
            if candidate:
                data = self._read(Path(candidate))
        elif kind == "sticker":
            content = row.get("message_content")
            if isinstance(content, bytes):
                content = self.db._friendly_content(content, "动画表情")
            if content == "[动画表情]" and isinstance(row.get("compress_content"), bytes):
                content = self.db._friendly_content(row["compress_content"], "动画表情")
            if not isinstance(content, str):
                return None
            start = content.find("<msg")
            root = ET.fromstring(content[start:] if start >= 0 else content)
            emoji = root if root.tag == "emoji" else root.find(".//emoji")
            if emoji is None:
                return None
            hashes = {emoji.get(name, "").lower() for name in ("md5", "androidmd5", "externmd5")}
            hashes = {value for value in hashes if re.fullmatch(r"[a-f0-9]{32}", value)}
            data = self._sticker(hashes)
        if not data or len(data) > MAX_BYTES:
            return None
        if data.startswith(b"wxgf"):
            data = self.media._wxgf_to_jpg(data)
            if not data:
                return None
        # ChatGPT consumes a static image. Decode/verify and convert animated
        # GIF/WebP to their first frame; never pass an unsupported cache blob.
        from PIL import Image
        with Image.open(io.BytesIO(data)) as picture:
            if picture.width * picture.height > MAX_PIXELS:
                return None
            picture.seek(0)
            picture.load()
            animated = bool(getattr(picture, "is_animated", False))
            if animated or picture.format not in ("JPEG", "PNG", "WEBP"):
                output = io.BytesIO()
                picture.convert("RGBA").save(output, format="PNG")
                data, extension = output.getvalue(), ".png"
            else:
                extension = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}[picture.format]
        if len(data) > MAX_BYTES:
            return None
        # Content-addressed files stay valid for queued/retried tasks, including
        # across restarts and colliding local IDs. No original cache is modified.
        destination = self.destination / (hashlib.sha256(data).hexdigest() + extension)
        if not destination.exists():
            temporary = destination.with_suffix(".tmp")
            try:
                temporary.write_bytes(data)
                temporary.replace(destination)
            finally:
                temporary.unlink(missing_ok=True)
        return str(destination)
