from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import pathlib
import sys
import time
from typing import Any, Dict, List


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
UPSTREAM_DB = PROJECT_ROOT / "vendor" / "wechatauto-replica" / "wechatauto" / "db.py"
WORKDIR = pathlib.Path(os.environ.get("WECHAT_DB_WORKDIR", PROJECT_ROOT / "data" / "wechat-db-cache"))
WATERMARK_FILE = WORKDIR / "watermarks.json"


def load_upstream():
    spec = importlib.util.spec_from_file_location("wechatauto_replica_db", UPSTREAM_DB)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 wechatauto-replica 数据库模块")
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
                })
        if changed:
            save_watermarks(self.watermarks)
        return output


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
