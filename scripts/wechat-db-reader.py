from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import pathlib
import sys
import time
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
UPSTREAM_DB = PROJECT_ROOT / "vendor" / "wechatauto-replica" / "wechatauto" / "db.py"
UPSTREAM_MEDIA = PROJECT_ROOT / "vendor" / "wechatauto-replica" / "wechatauto" / "media.py"
WORKDIR = pathlib.Path(os.environ.get("WECHAT_DB_WORKDIR", PROJECT_ROOT / "data" / "wechat-db-cache"))
WATERMARK_FILE = WORKDIR / "watermarks.json"


def load_upstream():
    spec = importlib.util.spec_from_file_location("wechatauto_replica_db", UPSTREAM_DB)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 wechatauto-replica 数据库模块")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_upstream_media():
    spec = importlib.util.spec_from_file_location("wechatauto_replica_media", UPSTREAM_MEDIA)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 wechatauto-replica 媒体模块")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_watermarks() -> Dict[str, int]:
    try:
        value = json.loads(WATERMARK_FILE.read_text(encoding="utf-8"))
        return {str(key): int(seq) for key, seq in value.items()}
    except (OSError, ValueError, TypeError):
        return {}


def save_watermarks(value: Dict[str, int]) -> None:
    WORKDIR.mkdir(parents=True, exist_ok=True)
    temporary = WATERMARK_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, WATERMARK_FILE)


class Reader:
    def __init__(self) -> None:
        self.db = None
        self.media = None
        self.sticker_cache_index: Optional[Dict[str, Any]] = None
        self.chats: Dict[str, str] = {}
        self.watermarks = load_watermarks()

    def start(self, conversations: List[Any]) -> Dict[str, Any]:
        if not conversations:
            raise RuntimeError("WECHAT_DB_CONVERSATIONS 不能为空")
        module = load_upstream()
        WORKDIR.mkdir(parents=True, exist_ok=True)
        self.db = module.WeChatDB(
            db_dir=os.environ.get("WECHAT_DB_DIR") or None,
            account=os.environ.get("WECHAT_DB_ACCOUNT") or None,
            workdir=str(WORKDIR),
            keys_file=str(WORKDIR / "keys.json"),
        )
        media_module = load_upstream_media()
        media_dir = WORKDIR / "context-media"
        media_dir.mkdir(parents=True, exist_ok=True)
        self.media = media_module.MediaDownloader(self.db, save_dir=str(media_dir))
        original_scan = self.media._scan_aes_key
        self.media._scan_aes_key = lambda monitor=False, monitor_timeout=120.0: original_scan(
            monitor=False, monitor_timeout=min(float(monitor_timeout), 10.0))
        self.chats = {}
        for raw in conversations:
            if isinstance(raw, dict):
                display_name = str(raw.get("name") or "").strip()
                conversation_type = str(raw.get("type") or "").strip()
                user_id = str(raw.get("id") or "").strip() or None
            else:
                display_name = str(raw).strip()
                conversation_type = ""
                user_id = None
            if not display_name:
                continue
            if not user_id and conversation_type != "contact":
                user_id = self.db.group_name_to_id(display_name)
            if not user_id and conversation_type != "group":
                matches = self.db.search_contact(display_name)
                exact = next((item for item in matches if
                              item.get("remark") == display_name or
                              item.get("nick_name") == display_name or
                              item.get("username") == display_name), None)
                user_id = exact.get("username") if exact else None
            if not user_id:
                raise RuntimeError("未在微信数据库中找到指定会话: %s" % display_name)
            self.chats[user_id] = display_name
            if user_id not in self.watermarks:
                latest = self.db.get_messages(user_id, limit=1)
                self.watermarks[user_id] = int(latest[0]["sort_seq"]) if latest else 0
        save_watermarks(self.watermarks)
        return {"ready": True, "conversationCount": len(self.chats)}

    def health(self) -> Dict[str, Any]:
        return {"ready": self.db is not None, "conversationCount": len(self.chats)}

    def poll(self) -> List[Dict[str, Any]]:
        if self.db is None:
            raise RuntimeError("微信数据库读取器尚未启动")
        output: List[Dict[str, Any]] = []
        changed = False
        for user_id, display_name in self.chats.items():
            since = int(self.watermarks.get(user_id, 0))
            messages = self.db.get_new_messages(user_id, since_seq=since, limit=200)
            for message in messages:
                seq = int(message.get("sort_seq") or 0)
                self.watermarks[user_id] = max(int(self.watermarks.get(user_id, 0)), seq)
                changed = True
                if message.get("type") != "文本":
                    continue
                content = message.get("content")
                if not isinstance(content, str) or not content.strip() or content.startswith("[文本]"):
                    continue
                local_id = int(message.get("local_id") or 0)
                raw_id = "%s|%s|%s" % (user_id, local_id, seq)
                timestamp = int(message.get("create_time") or time.time())
                if timestamp < 10_000_000_000:
                    timestamp *= 1000
                sender_username = str(message.get("sender_username") or "").strip()
                if user_id.endswith("@chatroom"):
                    first_line = content.split("\n", 1)[0].rstrip("\r")
                    if first_line.endswith(":") and " " not in first_line:
                        sender_username = first_line[:-1]
                sender_display_name = ""
                if user_id.endswith("@chatroom") and sender_username:
                    sender_display_name = str(self.db.get_nickname(sender_username) or "").strip()
                output.append({
                    "messageId": hashlib.sha256(raw_id.encode("utf-8")).hexdigest()[:32],
                    "userId": user_id,
                    "displayName": display_name,
                    "senderId": sender_username or None,
                    "senderDisplayName": sender_display_name or sender_username or None,
                    "text": content.strip(),
                    "timestamp": timestamp,
                    "isSelf": message.get("sender_id") in (2, "2"),
                    "sortSeq": seq,
                })
        if changed:
            save_watermarks(self.watermarks)
        return output

    def context(self, user_id: str, before_sort_seq: int, scan_limit: int = 100) -> List[Dict[str, Any]]:
        if self.db is None:
            raise RuntimeError("微信数据库读取器尚未启动")
        if user_id not in self.chats or not user_id.endswith("@chatroom"):
            return []
        output: List[Dict[str, Any]] = []
        for message in self.db.get_messages(user_id, limit=max(10, min(int(scan_limit), 2000))):
            seq = int(message.get("sort_seq") or 0)
            if seq <= 0 or seq >= int(before_sort_seq):
                continue
            message_type = str(message.get("type") or "")
            if message_type not in ("文本", "图片", "动画表情", "文件/链接/卡片"):
                continue
            if message.get("sender_id") in (2, "2"):
                continue
            content = message.get("content")
            if not isinstance(content, str) or not content.strip():
                continue
            sender_username = str(message.get("sender_username") or "").strip()
            body = content.strip()
            first_line = body.split("\n", 1)[0].rstrip("\r")
            if first_line.endswith(":") and " " not in first_line:
                sender_username = first_line[:-1]
                body = body.split("\n", 1)[1].strip() if "\n" in body else ""
            if not body and message_type == "文本":
                continue
            local_id = int(message.get("local_id") or 0)
            raw_id = "%s|%s|%s" % (user_id, local_id, seq)
            timestamp = int(message.get("create_time") or 0)
            if timestamp and timestamp < 10_000_000_000:
                timestamp *= 1000
            context_kind = "text"
            if message_type == "图片":
                context_kind = "image"
                body = "[图片]"
            elif message_type == "动画表情":
                context_kind = "sticker"
                body = "[表情包]"
            elif message_type == "文件/链接/卡片":
                context_kind = "link"
                body = self._describe_card(body)
            output.append({
                "messageId": hashlib.sha256(raw_id.encode("utf-8")).hexdigest()[:32],
                "userId": user_id,
                "displayName": self.chats[user_id],
                "senderId": sender_username or None,
                "senderDisplayName": sender_username or "未知成员",
                "text": body,
                "kind": context_kind,
                "localId": local_id,
                "timestamp": timestamp,
                "isSelf": False,
                "sortSeq": seq,
            })
        return output

    def resolve_media(self, user_id: str, messages: List[Any]) -> List[Dict[str, Any]]:
        """只解析已经选入上下文的媒体，避免为大量历史消息扫描本地缓存。"""
        if self.db is None:
            raise RuntimeError("微信数据库读取器尚未启动")
        if user_id not in self.chats or not user_id.endswith("@chatroom"):
            return []
        output: List[Dict[str, Any]] = []
        nickname_cache: Dict[str, str] = {}
        for raw in messages[:10]:
            if not isinstance(raw, dict):
                continue
            message_id = str(raw.get("messageId") or "")
            kind = str(raw.get("kind") or "")
            local_id = int(raw.get("localId") or 0)
            sender_id = str(raw.get("senderId") or "").strip()
            if not message_id or local_id <= 0:
                continue
            if sender_id and sender_id not in nickname_cache:
                nickname_cache[sender_id] = str(self.db.get_nickname(sender_id) or "").strip()
            attachment_path = None
            try:
                if kind == "image":
                    candidate = self.media.download_image(user_id, local_id) if self.media else None
                    if candidate and pathlib.Path(candidate).suffix.lower() in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
                        attachment_path = str(pathlib.Path(candidate).resolve())
                elif kind == "sticker":
                    row = self.db.get_message_row(user_id, local_id)
                    content = row.get("content") if isinstance(row, dict) else None
                    if isinstance(content, str) and content.strip():
                        body = content.strip()
                        first_line = body.split("\n", 1)[0].rstrip("\r")
                        if first_line.endswith(":") and " " not in first_line and "\n" in body:
                            body = body.split("\n", 1)[1].strip()
                        attachment_path = self._find_local_sticker(body, user_id, local_id)
            except Exception:
                attachment_path = None
            resolved = {
                "messageId": message_id,
                "senderDisplayName": nickname_cache.get(sender_id) or sender_id or "未知成员",
            }
            if attachment_path:
                resolved["attachmentPath"] = attachment_path
            output.append(resolved)
        return output

    @staticmethod
    def _xml_body(content: str) -> str:
        start = content.find("<msg")
        return content[start:] if start >= 0 else content

    @classmethod
    def _describe_card(cls, content: str) -> str:
        try:
            root = ET.fromstring(cls._xml_body(content))
            title = (root.findtext(".//appmsg/title") or "").strip()
            description = (root.findtext(".//appmsg/des") or "").strip()
            url = (root.findtext(".//appmsg/url") or root.findtext(".//url") or "").strip()
            label = "[链接]" if url else "[链接/卡片]"
            parts = [part for part in (label, title, description, url) if part]
            return "\n".join(parts)
        except (ET.ParseError, ValueError):
            return "[链接/卡片]"

    def _find_local_sticker(self, content: str, user_id: str, local_id: int) -> Optional[str]:
        try:
            root = ET.fromstring(self._xml_body(content))
            emoji = root.find(".//emoji")
            if emoji is None:
                return None
            hashes = []
            for name in ("md5", "androidmd5", "externmd5"):
                value = emoji.attrib.get(name, "").strip().lower()
                if len(value) == 32 and all(character in "0123456789abcdef" for character in value):
                    hashes.append(value)
            roots = [
                pathlib.Path(self.db.account_dir) / "msg" / "emoji",
                pathlib.Path(self.db.account_dir) / "msg" / "attach",
                pathlib.Path(self.db.account_dir) / "business" / "emoticon",
                pathlib.Path(self.db.account_dir) / "cache",
            ]
            for digest in hashes:
                for search_root in roots:
                    if not search_root.exists():
                        continue
                    for candidate in search_root.rglob("%s*" % digest):
                        if not candidate.is_file() or candidate.stat().st_size > 15 * 1024 * 1024:
                            continue
                        data = candidate.read_bytes()
                        extension = self._image_extension(data)
                        if not extension and self.media:
                            try:
                                data = self.media.decrypt_image(str(candidate))
                                extension = self._image_extension(data)
                            except Exception:
                                extension = None
                        if not extension:
                            continue
                        destination = WORKDIR / "context-media" / ("%s_%s_sticker%s" % (user_id, local_id, extension))
                        destination.write_bytes(data)
                        return str(destination.resolve())
            if self.sticker_cache_index is None:
                self.sticker_cache_index = {}
                cache_roots = [
                    pathlib.Path(self.db.account_dir) / "business" / "emoticon",
                    pathlib.Path(self.db.account_dir) / "cache",
                ]
                for cache_root in cache_roots:
                    if not cache_root.exists():
                        continue
                    for candidate in cache_root.rglob("*"):
                        if not candidate.is_file() or candidate.stat().st_size > 15 * 1024 * 1024:
                            continue
                        data = candidate.read_bytes()
                        extension = self._image_extension(data)
                        if not extension and self.media:
                            try:
                                data = self.media.decrypt_image(str(candidate))
                                extension = self._image_extension(data)
                            except Exception:
                                extension = None
                        if not extension:
                            continue
                        keys = {
                            candidate.name.lower(),
                            candidate.stem.lower(),
                            hashlib.md5(data).hexdigest(),
                        }
                        for key in keys:
                            self.sticker_cache_index[key] = (data, extension)
            for digest in hashes:
                cached = self.sticker_cache_index.get(digest)
                if not cached:
                    continue
                data, extension = cached
                destination = WORKDIR / "context-media" / ("%s_%s_sticker%s" % (user_id, local_id, extension))
                destination.write_bytes(data)
                return str(destination.resolve())
            return None
        except Exception:
            return None

    @staticmethod
    def _image_extension(data: bytes) -> Optional[str]:
        if data[:3] == b"\xff\xd8\xff":
            return ".jpg"
        if data[:4] == b"\x89PNG":
            return ".png"
        if data[:3] == b"GIF":
            return ".gif"
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return ".webp"
        return None


def write(value: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    reader = Reader()
    for line in sys.stdin:
        request: Dict[str, Any] = {}
        try:
            request = json.loads(line)
            operation = request.get("operation")
            if operation == "start":
                result = reader.start(request.get("conversations", []))
            elif operation == "health":
                result = reader.health()
            elif operation == "poll":
                result = reader.poll()
            elif operation == "context":
                result = reader.context(
                    str(request.get("userId") or ""),
                    int(request.get("beforeSortSeq") or 0),
                    int(request.get("scanLimit") or 100),
                )
            elif operation == "resolve_media":
                result = reader.resolve_media(
                    str(request.get("userId") or ""),
                    request.get("messages") if isinstance(request.get("messages"), list) else [],
                )
            elif operation == "stop":
                write({"id": request.get("id", 0), "ok": True, "result": {"stopped": True}})
                return
            else:
                raise RuntimeError("未知操作: %s" % operation)
            write({"id": request.get("id", 0), "ok": True, "result": result})
        except Exception as error:
            write({"id": request.get("id", 0), "ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
