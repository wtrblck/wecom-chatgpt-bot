"""Verify a receipt from project-local caches without starting a reader or advancing cursors."""
from __future__ import annotations

import argparse
import datetime
import hashlib
import importlib.util
import json
import pathlib
import re
import sqlite3
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parents[1]


def open_read_only(path: pathlib.Path) -> sqlite3.Connection:
    # mode=ro includes committed WAL data; immutable=1 would ignore live bot WAL.
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def iso_time(milliseconds: int | None) -> str | None:
    if milliseconds is None:
        return None
    return datetime.datetime.fromtimestamp(milliseconds / 1000, datetime.timezone.utc).astimezone().isoformat()


class CachedDatabase:
    def __init__(self, directory: pathlib.Path, codecs: Any) -> None:
        self.directory = directory
        state = json.loads((directory / "watermarks.json").read_text(encoding="utf-8"))
        account = state.get("account")
        if not isinstance(account, str) or not account:
            raise RuntimeError("缓存缺少账号标识，不能验证是否为本人发送")
        self.wxid = re.sub(r"_\w{4}$", "", account)
        self._msg_type_name = codecs._msg_type_name
        self._friendly_content = codecs._friendly_content

    def _message_dbs(self) -> list[str]:
        return sorted(path.name for path in self.directory.glob("message__message_*.db")
                      if re.fullmatch(r"message__message_\d+\.db", path.name))

    def _open(self, shard: str) -> sqlite3.Connection:
        return open_read_only(self.directory / shard)


def verify(root: pathlib.Path, identifier: str, expected: str | None, task_id: int | None) -> dict:
    config = json.loads((root / "config/wechat-conversations.json").read_text(encoding="utf-8-sig"))
    if not any(chat.get("id") == identifier and chat.get("enabled", True) for chat in config["conversations"]):
        raise RuntimeError("目标必须是配置中显式启用的会话 ID")
    spec = importlib.util.spec_from_file_location("receipt_reader", root / "scripts/wechat-db-reader.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Import codecs only. WeChatDB() and Reader.start()/ack() are never called.
    upstream = module.load_upstream()
    cached = CachedDatabase(root / "data/wechat-db-cache", upstream.WeChatDB)
    access = module.DatabaseAccess(cached)
    rows = access.messages(identifier, None, 200)
    report = {"scope": "latest_200_rows_in_project_cache", "cachedRowsChecked": len(rows)}
    parts = [{"part": 0, "content": expected, "status": "sent"}]
    if task_id is not None:
        with open_read_only(root / "data/bot.sqlite") as database:
            task = database.execute(
                "SELECT * FROM tasks WHERE id=? AND userid=?", (task_id, "wechat:" + identifier)
            ).fetchone()
            if task is None:
                raise RuntimeError("未找到指定会话的任务")
            parts = [dict(row) for row in database.execute(
                "SELECT part,content,status,updated_at FROM wechat_outbox WHERE delivery_key=? AND user_id=? ORDER BY part",
                ("task:%d" % task_id, identifier),
            )]
            if not parts:
                raise RuntimeError("任务没有已保存的发送分片")
            inbox = database.execute("SELECT * FROM wechat_inbox WHERE message_id=?", (
                task["msgid"].removeprefix("wechat:"),
            )).fetchone()
            report["task"] = {"id": task_id, "status": task["status"], "response": task["response"],
                              "createdAt": iso_time(task["created_at"]), "startedAt": iso_time(task["started_at"]),
                              "finishedAt": iso_time(task["finished_at"])}
            if inbox:
                payload = json.loads(inbox["payload"])
                matching_input = [row for row in rows if hashlib.sha256(("%s|%s|%s" % (
                    identifier, int(row["local_id"]), int(row["sort_seq"])
                )).encode("utf-8")).hexdigest()[:32] == inbox["message_id"]]
                report["input"] = {"messageTime": iso_time(payload["timestamp"]),
                                   "inboxReceivedAt": iso_time(inbox["received_at"]),
                                   "inboxHandledAt": iso_time(inbox["handled_at"]),
                                   "cachedMatches": len(matching_input),
                                   "cachedCreateTime": [iso_time(int(row["create_time"]) * 1000) for row in matching_input],
                                   "isSelf": [row.get("_sender_username") == cached.wxid for row in matching_input]}
    receipts = []
    for part in parts:
        matches = []
        for row in rows:
            decoded = access.decode(row)
            content = decoded.get("content")
            sender = row.get("_sender_username") or ""
            if isinstance(content, str) and sender:
                content = re.sub(r"^" + re.escape(sender) + r":\r?\n", "", content, count=1)
            # Exact full text, including its textual @ mention; no substring match.
            if decoded.get("type") == "文本" and content == part["content"]:
                matches.append({"sortSeq": row["sort_seq"], "localId": row["local_id"],
                                "createTime": iso_time(int(row["create_time"]) * 1000),
                                "isSelf": bool(sender) and sender == cached.wxid})
        receipts.append({"part": part["part"], "outboxStatus": part["status"],
                         "outboxUpdatedAt": iso_time(part.get("updated_at")),
                         "includesTextMention": bool(part["content"] and part["content"].startswith("@")),
                         "exactMatches": len(matches), "matches": matches})
    report["receipts"] = receipts
    report["verified"] = bool(receipts) and all(
        item["outboxStatus"] == "sent" and item["exactMatches"] == 1 and item["matches"][0]["isSelf"]
        for item in receipts
    )
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("identifier", help="Explicit enabled conversation ID")
    parser.add_argument("expected", nargs="?", help="Exact complete sent text, including mention")
    parser.add_argument("--task-id", type=int, help="Read exact persisted chunks from this conversation's task")
    args = parser.parse_args()
    if (args.expected is None) == (args.task_id is None):
        parser.error("Provide either exact expected text or --task-id")
    result = verify(ROOT, args.identifier, args.expected, args.task_id)
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(0 if result["verified"] else 1)


if __name__ == "__main__":
    main()
