from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import sqlite3
import sys
import time
import uuid
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
UPSTREAM_DB = PROJECT_ROOT / "vendor" / "wechatauto-replica" / "wechatauto" / "db.py"
UPSTREAM_MEDIA = PROJECT_ROOT / "vendor" / "wechatauto-replica" / "wechatauto" / "media.py"
WORKDIR = pathlib.Path(os.environ.get("WECHAT_DB_WORKDIR", PROJECT_ROOT / "data" / "wechat-db-cache"))
WATERMARK_FILE = WORKDIR / "watermarks.json"
PAGE_SIZE = 200


def load_upstream():
    spec = importlib.util.spec_from_file_location("wechatauto_replica_db", UPSTREAM_DB)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 wechatauto-replica 数据库模块")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cursor_key(cursor: Dict[str, Any]) -> tuple:
    return (int(cursor["sortSeq"]), int(cursor["localId"]), str(cursor.get("shard", "")))


def load_upstream_media():
    spec = importlib.util.spec_from_file_location("wechatauto_replica_media", UPSTREAM_MEDIA)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 wechatauto-replica 媒体模块")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def row_cursor(row: Dict[str, Any]) -> Dict[str, Any]:
    return {"sortSeq": int(row["sort_seq"]), "localId": int(row["local_id"]), "shard": row["_shard"]}


class DatabaseAccess:
    """Keep version-sensitive, read-only vendor access in one compatibility layer.

    Upstream polling uses only the first matching shard and a scalar sort_seq.
    Query all shards with a composite cursor so page boundaries cannot lose ties.
    """

    def __init__(self, db: Any) -> None:
        self.db = db

    def resolve_conversation(self, name: str, kind: str, explicit_id: str | None) -> str:
        conn = self.db._contact_conn()
        if conn is None:
            raise RuntimeError("无法读取微信联系人数据库")
        try:
            if explicit_id:
                rows = conn.execute("SELECT username FROM contact WHERE username=?", (explicit_id,)).fetchall()
            else:
                # No fuzzy match or LIMIT 50: both can silently bind another group.
                rows = conn.execute(
                    "SELECT username FROM contact WHERE username=? OR nick_name=? OR remark=?",
                    (name, name, name),
                ).fetchall()
        finally:
            conn.close()
        candidates = sorted({str(row[0]) for row in rows if row[0] and (
            not kind or str(row[0]).endswith("@chatroom") == (kind == "group")
        )})
        if len(candidates) != 1:
            reason = "存在重名，请在会话配置中填写 id" if candidates else "未找到对应类型的会话，请核对名称或 id"
            raise RuntimeError("%s: %s" % (name, reason))
        return candidates[0]

    def messages(self, user_id: str, cursor: Dict[str, Any] | None, limit: int = PAGE_SIZE, before_sort_seq: int | None = None) -> List[Dict[str, Any]]:
        table = "Msg_" + hashlib.md5(user_id.encode("utf-8")).hexdigest()
        # This identifier is generated, never interpolated from user input.
        for attempt in (0, 1):
            try:
                rows = []
                for shard in self.db._message_dbs():
                    conn = self.db._open(shard)
                    try:
                        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                            continue
                        if cursor is None:
                            where, params, order = "", (limit,), "DESC"
                            if before_sort_seq is not None:
                                where, params = "WHERE sort_seq < ?", (before_sort_seq, limit)
                        else:
                            seq, local_id, previous_shard = cursor_key(cursor)
                            where = "WHERE sort_seq > ? OR (sort_seq = ? AND (local_id > ? OR (local_id = ? AND ? > ?)))"
                            params = (seq, seq, local_id, local_id, shard, previous_shard, limit)
                            order = "ASC"
                        selected = conn.execute(
                            "SELECT local_id, local_type, real_sender_id, create_time, message_content, "
                            "source, packed_info_data, compress_content, sort_seq FROM %s %s "
                            "ORDER BY sort_seq %s, local_id %s LIMIT ?" % (table, where, order, order), params,
                        ).fetchall()
                        senders = self._shard_senders(conn, selected)
                        rows.extend(dict(row, _shard=shard,
                                         _sender_username=senders.get(int(row["real_sender_id"] or 0), ""))
                                    for row in selected)
                    finally:
                        conn.close()
                rows.sort(key=lambda row: cursor_key(row_cursor(row)), reverse=cursor is None)
                return rows[:limit]
            except sqlite3.DatabaseError as error:
                if attempt or "malformed" not in str(error).lower():
                    raise
                self.db._invalidate_cache()
        return []

    @staticmethod
    def _shard_senders(conn: sqlite3.Connection, rows: List[Any]) -> Dict[int, str]:
        # real_sender_id refers to Name2Id in THIS message shard. The resource
        # database's SenderName2Id has a separate index space and can be empty.
        # Read only identities referenced by the selected conversation rows.
        sender_ids = sorted({int(row["real_sender_id"] or 0) for row in rows})
        if not sender_ids or not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='Name2Id'"
        ).fetchone():
            return {}
        placeholders = ",".join("?" for _ in sender_ids)
        return {int(row[0]): str(row[1]) for row in conn.execute(
            "SELECT rowid, user_name FROM Name2Id WHERE rowid IN (%s)" % placeholders, sender_ids
        ) if row[1]}

    def decode(self, row: Dict[str, Any]) -> Dict[str, Any]:
        # Reuse upstream content codecs without invoking its resource-based
        # sender lookup or its hard-coded sender_id == 2 assumption.
        kind = self.db._msg_type_name(row["local_type"])
        content = row["message_content"]
        if isinstance(content, bytes):
            content = self.db._friendly_content(content, kind)
        if content == "[%s]" % kind and isinstance(row.get("compress_content"), bytes):
            content = self.db._friendly_content(row["compress_content"], kind)
        return {"type": kind, "content": content, "create_time": row["create_time"]}


class Reader:
    def __init__(self, db: Any = None, watermark_file: pathlib.Path | None = None) -> None:
        self.db = db
        self.access = DatabaseAccess(db) if db is not None else None
        self.watermark_file = watermark_file or WATERMARK_FILE
        self.media = None
        self.media_enabled = False
        self.local_media = None
        self.chats: Dict[str, str] = {}
        self.watermarks: Dict[str, Dict[str, Any]] = {}
        self.account: str | None = None
        self.self_id = ""
        self.last_ack: str | None = None
        self.pending: Dict[str, Any] | None = None
        self.pending_watermarks: Dict[str, Dict[str, Any]] | None = None
        self.started = False
        self.last_poll_at: int | None = None
        self.last_error: str | None = None
        self._load_state()

    def _load_state(self) -> None:
        try:
            value = json.loads(self.watermark_file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError) as error:
            raise RuntimeError("无法读取微信消息水位；已保留原文件，请修复后重试: %s" % self.watermark_file) from error
        try:
            if not isinstance(value, dict):
                raise ValueError("invalid watermark object")
            if "version" in value:
                if value["version"] != 2 or not isinstance(value.get("cursors"), dict):
                    raise ValueError("unsupported watermark version")
                self.account = value.get("account")
                self.last_ack = value.get("lastAck")
                self.watermarks = {str(key): {"sortSeq": cursor_key(cursor)[0], "localId": cursor_key(cursor)[1],
                                             "shard": cursor_key(cursor)[2]} for key, cursor in value["cursors"].items()}
            else:
                # Replay the legacy boundary: older code may have acknowledged
                # only part of a repeated sort_seq. Node deduplicates messageId.
                self.watermarks = {str(key): {"sortSeq": int(seq), "localId": -1, "shard": ""}
                                   for key, seq in value.items()}
        except (ValueError, TypeError, KeyError, AttributeError) as error:
            raise RuntimeError("微信消息水位格式无效，拒绝重置水位: %s" % self.watermark_file) from error

    def _save_state(self, watermarks: Dict[str, Dict[str, Any]], last_ack: str | None) -> None:
        self.watermark_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.watermark_file.with_suffix(".tmp")
        value = {"version": 2, "account": self.account, "cursors": watermarks, "lastAck": last_ack}
        with temporary.open("w", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, self.watermark_file)

    def start(self, conversations: List[Any], media_enabled: bool = False) -> Dict[str, Any]:
        if not isinstance(media_enabled, bool):
            raise RuntimeError("mediaEnabled 必须为开关值")
        if self.started:
            return self.health()
        self.media_enabled = media_enabled
        if not conversations:
            raise RuntimeError("WECHAT_DB_CONVERSATIONS 不能为空")
        if self.db is None:
            module = load_upstream()
            WORKDIR.mkdir(parents=True, exist_ok=True)
            self.db = module.WeChatDB(
                db_dir=os.environ.get("WECHAT_DB_DIR") or None,
                account=os.environ.get("WECHAT_DB_ACCOUNT") or None,
                workdir=str(WORKDIR), keys_file=str(WORKDIR / "keys.json"),
            )
            self.access = DatabaseAccess(self.db)
        account = str(self.db.account)
        if self.account is not None and self.account != account:
            raise RuntimeError("微信账号与消息水位所属账号不一致，请为不同账号使用独立 WECHAT_DB_WORKDIR")
        self.account = account
        self.self_id = str(self.db.wxid or "").strip()
        if not self.self_id:
            raise RuntimeError("无法确认当前微信账号身份")
        assert self.access is not None
        chats = {}
        watermarks = dict(self.watermarks)
        for raw in conversations:
            if isinstance(raw, dict):
                if raw.get("enabled") is False:
                    continue
                display_name = str(raw.get("name") or "").strip()
                kind = str(raw.get("type") or "").strip()
                explicit_id = str(raw.get("id") or "").strip() or None
            else:
                display_name, kind, explicit_id = str(raw).strip(), "", None
            if not display_name or kind not in ("", "contact", "group"):
                raise RuntimeError("微信会话配置的名称或类型无效")
            user_id = self.access.resolve_conversation(display_name, kind, explicit_id)
            if user_id in chats:
                raise RuntimeError("微信会话配置重复指向同一 id: %s" % display_name)
            chats[user_id] = display_name
            if user_id not in watermarks:
                # First subscription intentionally starts after current history.
                latest = self.access.messages(user_id, None, limit=1)
                watermarks[user_id] = row_cursor(latest[0]) if latest else {"sortSeq": 0, "localId": -1, "shard": ""}
        if not chats:
            raise RuntimeError("没有启用的微信监听会话")
        self._save_state(watermarks, self.last_ack)
        self.watermarks, self.chats = watermarks, chats
        self.started = True
        return self.health()

    def health(self) -> Dict[str, Any]:
        return {"ready": self.started and self.last_error is None, "conversationCount": len(self.chats),
                "lastPollAt": self.last_poll_at, "lastError": self.last_error,
                "pendingBatchId": self.pending["batchId"] if self.pending else None}

    def _incoming(self, user_id: str, display_name: str, row: Dict[str, Any],
                  nicknames: Dict[str, str], include_context: bool = False,
                  skip_unknown_sender: bool = False) -> Dict[str, Any] | None:
        assert self.access is not None
        message = self.access.decode(row)
        content = message.get("content")
        kind = {"文本": "text", "图片": "image", "动画表情": "sticker", "文件/链接/卡片": "link"}.get(message.get("type"))
        if kind is None or (kind != "text" and not include_context and (not self.media_enabled or kind == "link")):
            return None
        if kind == "image":
            content = "[图片]"
        elif kind == "sticker":
            content = "[表情包]"
        elif kind == "link":
            content = self._describe_card(content if isinstance(content, str) else "")
        if not isinstance(content, str) or (
            content == "[文本]" and isinstance(row["message_content"], (bytes, bytearray))
        ):
            raise RuntimeError("微信文本无法解码，请检查微信数据库版本及 zstandard 依赖")
        if not content.strip():
            return None
        sender_id = str(row.get("_sender_username") or "")
        if user_id.endswith("@chatroom"):
            match = re.match(r"^([A-Za-z0-9_.@-]+):\r?\n", content)
            if match and not sender_id:
                sender_id = match.group(1)
        # Numeric sender ids are indexes, not a documented self marker.
        if not sender_id:
            # Supplemental group context is best-effort. Some WeChat 4.x
            # wrapper/card rows legitimately point at an empty Name2Id slot.
            # Never guess their author, but do not let an unrelated historical
            # row block a valid, attributable trigger message either.
            if skip_unknown_sender:
                return None
            raise RuntimeError("无法确认消息发送者，暂不推进水位；请检查消息分片 Name2Id 与微信数据库版本")
        if sender_id not in nicknames:
            nicknames[sender_id] = str(self.db.get_nickname(sender_id) or sender_id).strip()
        raw_id = "%s|%s|%s" % (user_id, int(row["local_id"]), int(row["sort_seq"]))
        timestamp = int(message.get("create_time") or time.time())
        if timestamp < 10_000_000_000:
            timestamp *= 1000
        return {"messageId": hashlib.sha256(raw_id.encode("utf-8")).hexdigest()[:32],
                "userId": user_id, "displayName": display_name, "senderId": sender_id,
                "senderDisplayName": nicknames[sender_id] or sender_id, "text": content.strip(),
                "timestamp": timestamp, "isSelf": sender_id == self.self_id,
                "sortSeq": int(row["sort_seq"]), "kind": kind, "localId": int(row["local_id"]), "shard": row["_shard"]}

    def poll(self) -> Dict[str, Any]:
        if not self.started or self.access is None:
            raise RuntimeError("微信数据库读取器尚未启动")
        if self.pending is not None:
            return self.pending
        try:
            output = []
            cursors = dict(self.watermarks)
            nicknames: Dict[str, str] = {}
            changed = False
            for user_id, display_name in self.chats.items():
                rows = self.access.messages(user_id, cursors[user_id])
                for row in rows:
                    incoming = self._incoming(user_id, display_name, row, nicknames)
                    if incoming is not None:
                        output.append(incoming)
                if rows:
                    cursors[user_id] = row_cursor(rows[-1])
                    changed = True
            self.last_poll_at, self.last_error = int(time.time() * 1000), None
            if not changed:
                return {"batchId": None, "messages": []}
            self.pending = {"batchId": uuid.uuid4().hex, "messages": output}
            self.pending_watermarks = cursors
            return self.pending
        except Exception as error:
            self.last_error = str(error)
            raise

    def ack(self, batch_id: str) -> Dict[str, bool]:
        if not isinstance(batch_id, str) or not batch_id:
            raise RuntimeError("ack 缺少 batchId")
        if batch_id == self.last_ack:
            return {"acknowledged": True}
        if self.pending is None or batch_id != self.pending["batchId"] or self.pending_watermarks is None:
            raise RuntimeError("ack batchId 不属于当前待确认批次")
        try:
            # Save before changing memory. A failed write keeps the batch replayable.
            self._save_state(self.pending_watermarks, batch_id)
        except Exception as error:
            self.last_error = str(error)
            raise
        self.watermarks, self.last_ack = self.pending_watermarks, batch_id
        self.pending, self.pending_watermarks, self.last_error = None, None, None
        return {"acknowledged": True}

    def context(self, user_id: str, before_sort_seq: int, scan_limit: int = 100) -> List[Dict[str, Any]]:
        if not self.started or self.access is None:
            raise RuntimeError("微信数据库读取器尚未启动")
        if user_id not in self.chats or not user_id.endswith("@chatroom"):
            return []
        # Use the same shard-local Name2Id mapping as polling, including for media.
        rows = self.access.messages(user_id, None, limit=max(1, min(int(scan_limit), 200)),
                                    before_sort_seq=int(before_sort_seq))
        output, nicknames = [], {}
        for row in rows:
            item = self._incoming(user_id, self.chats[user_id], row, nicknames,
                                  include_context=True, skip_unknown_sender=True)
            if item and not item["isSelf"]:
                if item["kind"] == "text":
                    item["text"] = re.sub(r"^[^\s:\r\n]{1,128}:\r?\n", "", item["text"]).strip()
                if item["text"]:
                    output.append(item)
        return output

    def _ensure_media(self) -> None:
        if self.local_media is not None:
            return
        media_module = load_upstream_media()
        media_dir = WORKDIR / "context-media"
        media_dir.mkdir(parents=True, exist_ok=True)
        self.media = media_module.MediaDownloader(self.db, save_dir=str(media_dir))
        original_scan = self.media._scan_aes_key
        self.media._scan_aes_key = lambda monitor=False, monitor_timeout=120.0: original_scan(
            monitor=False, monitor_timeout=min(float(monitor_timeout), 5.0))
        spec = importlib.util.spec_from_file_location("wechat_local_media", PROJECT_ROOT / "scripts" / "wechat-local-media.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.local_media = module.LocalMediaResolver(self.db, self.media, media_dir)

    def _media_row(self, user_id: str, raw: Dict[str, Any]) -> Dict[str, Any] | None:
        # local_id is only unique inside one shard. Refuse ambiguous older payloads.
        table = "Msg_" + hashlib.md5(user_id.encode("utf-8")).hexdigest()
        rows = []
        for shard in self.db._message_dbs():
            if raw.get("shard") and shard != raw["shard"]:
                continue
            conn = self.db._open(shard)
            try:
                if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                    continue
                for row in conn.execute("SELECT * FROM %s WHERE local_id=?" % table, (int(raw.get("localId") or 0),)):
                    if raw.get("sortSeq") is not None and int(row["sort_seq"]) != int(raw["sortSeq"]):
                        continue
                    rows.append(dict(row, _shard=shard))
            finally:
                conn.close()
        if len(rows) != 1:
            return None
        row = rows[0]
        identity = "%s|%s|%s" % (user_id, row["local_id"], row["sort_seq"])
        if hashlib.sha256(identity.encode()).hexdigest()[:32] != raw.get("messageId"):
            return None
        return row

    def resolve_media(self, user_id: str, messages: List[Any]) -> List[Dict[str, Any]]:
        if not self.media_enabled:
            return []
        if not self.started or self.db is None:
            raise RuntimeError("微信数据库读取器尚未启动")
        if user_id not in self.chats:
            return []
        output = []
        for raw in messages[:10]:
            if not isinstance(raw, dict) or raw.get("kind") not in ("image", "sticker"):
                continue
            resolved = {"messageId": str(raw.get("messageId") or ""),
                        "senderDisplayName": str(self.db.get_nickname(raw.get("senderId") or "") or raw.get("senderId") or "未知成员")}
            try:
                row = self._media_row(user_id, raw)
                expected = "图片" if raw["kind"] == "image" else "动画表情"
                if row and self.db._msg_type_name(row["local_type"]) == expected:
                    self._ensure_media()
                    attachment = self.local_media.resolve(user_id, row, raw["kind"])
                    if attachment:
                        resolved["attachmentPath"] = attachment
            except Exception as error:
                # Do not lose a text batch because a cache file is locked or absent.
                print("本地媒体不可用: %s" % type(error).__name__, file=sys.stderr)
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


def write(value: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8", errors="strict")
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    reader = None
    for line in sys.stdin:
        request: Dict[str, Any] = {}
        try:
            parsed = json.loads(line)
            if not isinstance(parsed, dict):
                raise RuntimeError("请求必须是 JSON 对象")
            request = parsed
            operation = request.get("operation")
            # Vendor diagnostics must never interleave with protocol output.
            with contextlib.redirect_stdout(sys.stderr):
                if reader is None:
                    reader = Reader()
                if operation == "start":
                    result = reader.start(request.get("conversations", []), request.get("mediaEnabled", False))
                elif operation == "health":
                    result = reader.health()
                elif operation == "poll":
                    result = reader.poll()
                elif operation == "ack":
                    result = reader.ack(request.get("batchId"))
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
                    result = {"stopped": True}
                else:
                    raise RuntimeError("未知操作: %s" % operation)
            write({"id": request.get("id", 0), "ok": True, "result": result})
            if operation == "stop":
                return
        except Exception as error:
            write({"id": request.get("id", 0), "ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
