"""Offline protocol tests: only synthetic SQLite files inside the project are used."""
import hashlib
import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


PROJECT_ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("wechat_db_reader", PROJECT_ROOT / "scripts" / "wechat-db-reader.py")
reader_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader_module)
Reader = reader_module.Reader
GROUP = "test@chatroom"
CONFIG = [{"name": "Test group", "type": "group", "enabled": True}]


class FakeDatabase:
    account = "wxid_bot_abcd"
    wxid = "wxid_bot"

    def __init__(self, directory):
        self.directory = pathlib.Path(directory)
        self.shards = ["message_0.db", "message_1.db"]
        conn = self._contact_conn()
        conn.execute("CREATE TABLE contact(username TEXT, nick_name TEXT, remark TEXT)")
        conn.execute("INSERT INTO contact VALUES (?, ?, ?)", (GROUP, "Test group", ""))
        conn.commit()
        conn.close()
        for shard in self.shards:
            conn = self._open(shard)
            conn.execute("CREATE TABLE %s(local_id INTEGER, local_type INTEGER, real_sender_id INTEGER, "
                         "create_time INTEGER, message_content TEXT, source BLOB, packed_info_data BLOB, "
                         "compress_content BLOB, sort_seq INTEGER)" % self.table)
            conn.execute("CREATE TABLE Name2Id(user_name TEXT PRIMARY KEY, is_session INTEGER)")
            conn.executemany("INSERT INTO Name2Id(rowid,user_name) VALUES (?,?)", [(2, "wxid_friend"), (9, self.wxid)])
            conn.commit()
            conn.close()

    @property
    def table(self):
        return "Msg_" + hashlib.md5(GROUP.encode()).hexdigest()

    def _open(self, shard):
        conn = sqlite3.connect(self.directory / shard)
        conn.row_factory = sqlite3.Row
        return conn

    def _contact_conn(self):
        return self._open("contact.db")

    def _message_dbs(self):
        return self.shards

    def _sender_id_index(self):
        raise AssertionError("Resource SenderName2Id must not be used for message shard sender ids")

    def _msg_type_name(self, kind):
        return "文本" if kind == 1 else "图片"

    def _friendly_content(self, content, kind):
        return "[%s]" % kind

    def set_sender(self, sender_id, user_id, shard="message_0.db"):
        conn = self._open(shard)
        conn.execute("INSERT OR REPLACE INTO Name2Id(rowid,user_name) VALUES (?,?)", (sender_id, user_id))
        conn.commit()
        conn.close()

    def get_nickname(self, user_id):
        return {"wxid_friend": "Friend", self.wxid: "Bot"}.get(user_id, user_id)

    def add(self, local_id, seq=None, content=None, sender=2, kind=1, shard="message_0.db"):
        conn = self._open(shard)
        conn.execute("INSERT INTO %s VALUES(?,?,?,?,?,NULL,NULL,NULL,?)" % self.table,
                     (local_id, kind, sender, 1_700_000_000, content or "message %d" % local_id,
                      seq if seq is not None else local_id))
        conn.commit()
        conn.close()


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".test-db-", dir=PROJECT_ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.db = FakeDatabase(self.temporary.name)
        self.state = pathlib.Path(self.temporary.name) / "watermarks.json"
        self.reader = Reader(self.db, self.state)
        self.reader.start(CONFIG)

    def test_poll_replays_until_ack_and_does_not_write_watermark(self):
        before = self.state.read_bytes()
        self.db.add(1)
        batch = self.reader.poll()
        self.assertEqual(len(batch["messages"]), 1)
        self.assertEqual(batch, self.reader.poll())
        self.assertEqual(before, self.state.read_bytes())
        self.reader.ack(batch["batchId"])
        self.assertNotEqual(before, self.state.read_bytes())
        self.assertEqual(self.reader.poll(), {"batchId": None, "messages": []})

    def test_crash_before_ack_replays_stable_message_ids(self):
        self.db.add(1)
        original = self.reader.poll()
        restarted = Reader(self.db, self.state)
        restarted.start(CONFIG)
        replay = restarted.poll()
        self.assertEqual(original["messages"], replay["messages"])
        restarted.ack(replay["batchId"])
        final = Reader(self.db, self.state)
        final.start(CONFIG)
        self.assertEqual(final.poll()["messages"], [])
        self.assertEqual(final.ack(replay["batchId"]), {"acknowledged": True})

    def test_more_than_two_pages_with_equal_sequences_across_shards(self):
        for index in range(1, 452):
            self.db.add(index, seq=10, shard=self.db.shards[index % 2])
        messages, sizes = [], []
        while True:
            batch = self.reader.poll()
            if batch["batchId"] is None:
                break
            messages.extend(batch["messages"])
            sizes.append(len(batch["messages"]))
            self.reader.ack(batch["batchId"])
        self.assertEqual(sizes, [200, 200, 51])
        self.assertEqual([item["text"] for item in messages], ["message %d" % i for i in range(1, 452)])
        self.assertEqual(len({item["messageId"] for item in messages}), 451)

    def test_shard_is_final_tie_breaker(self):
        for shard in self.db.shards:
            self.db.add(1, seq=1, shard=shard)
        access = self.reader.access
        first = access.messages(GROUP, self.reader.watermarks[GROUP], limit=1)
        second = access.messages(GROUP, reader_module.row_cursor(first[0]), limit=1)
        self.assertEqual([first[0]["_shard"], second[0]["_shard"]], self.db.shards)

    def test_non_text_rows_still_require_ack(self):
        self.db.add(1, kind=3)
        batch = self.reader.poll()
        self.assertIsNotNone(batch["batchId"])
        self.assertEqual(batch["messages"], [])
        self.assertEqual(batch, self.reader.poll())
        self.reader.ack(batch["batchId"])
        self.assertIsNone(self.reader.poll()["batchId"])

    def test_self_identity_uses_username_instead_of_sender_index_two(self):
        self.db.add(1, sender=2)
        self.db.add(2, sender=9)
        messages = self.reader.poll()["messages"]
        self.assertFalse(messages[0]["isSelf"])
        self.assertEqual(messages[0]["senderId"], "wxid_friend")
        self.assertTrue(messages[1]["isSelf"])

    def test_unknown_sender_blocks_ack_and_health_recovers_when_index_is_fixed(self):
        self.db.add(1, sender=77)
        before = self.state.read_bytes()
        with self.assertRaisesRegex(RuntimeError, "Name2Id"):
            self.reader.poll()
        self.assertFalse(self.reader.health()["ready"])
        self.assertEqual(before, self.state.read_bytes())
        self.db.set_sender(77, "wxid_new_member")
        self.assertEqual(self.reader.poll()["messages"][0]["senderId"], "wxid_new_member")
        self.assertTrue(self.reader.health()["ready"])

    def test_group_sender_envelope_only_used_when_index_has_no_identity(self):
        self.db.add(1, sender=99, content="wxid_envelope:\nhello")
        self.db.add(2, sender=9, content="wxid_fake:\nhello")
        messages = self.reader.poll()["messages"]
        self.assertEqual(messages[0]["senderId"], "wxid_envelope")
        self.assertTrue(messages[1]["isSelf"])

    def test_sender_indexes_are_local_to_each_message_shard(self):
        self.db.set_sender(2, self.db.wxid, shard="message_1.db")
        self.db.add(1, sender=2, shard="message_0.db")
        self.db.add(2, sender=2, shard="message_1.db")
        messages = self.reader.poll()["messages"]
        self.assertEqual([item["senderId"] for item in messages], ["wxid_friend", self.db.wxid])
        self.assertEqual([item["isSelf"] for item in messages], [False, True])

    def test_missing_name2id_never_uses_resource_index_or_guesses_self(self):
        conn = self.db._open("message_0.db")
        conn.execute("DROP TABLE Name2Id")
        conn.close()
        self.db.add(1, sender=2)
        before = self.state.read_bytes()
        with self.assertRaisesRegex(RuntimeError, "Name2Id"):
            self.reader.poll()
        self.assertEqual(self.state.read_bytes(), before)

    def test_ack_failure_preserves_in_memory_and_disk_state(self):
        self.db.add(1)
        batch = self.reader.poll()
        before = self.state.read_bytes()
        with patch.object(reader_module.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.reader.ack(batch["batchId"])
        self.assertEqual(batch, self.reader.poll())
        self.assertEqual(before, self.state.read_bytes())
        self.reader.ack(batch["batchId"])
        self.assertTrue(self.reader.health()["ready"])

    def test_wrong_ack_never_advances_watermark(self):
        self.db.add(1)
        batch = self.reader.poll()
        with self.assertRaisesRegex(RuntimeError, "batchId"):
            self.reader.ack("not-the-batch")
        self.assertEqual(batch, self.reader.poll())

    def test_legacy_cursor_replays_boundary_without_resetting_to_latest(self):
        self.db.add(1, seq=10)
        self.db.add(2, seq=10)
        self.db.add(3, seq=11)
        self.state.write_text(json.dumps({GROUP: 10}), encoding="utf-8")
        migrated = Reader(self.db, self.state)
        migrated.start(CONFIG)
        self.assertEqual(len(migrated.poll()["messages"]), 3)

    def test_corrupt_state_is_not_silently_reset(self):
        self.state.write_text("{corrupt", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "水位"):
            Reader(self.db, self.state)
        self.assertEqual(self.state.read_text(encoding="utf-8"), "{corrupt")

    def test_initial_subscription_uses_latest_of_all_shards(self):
        self.db.add(1, seq=100, shard=self.db.shards[0])
        self.db.add(2, seq=200, shard=self.db.shards[1])
        initial = Reader(self.db, self.state.with_name("new.json"))
        initial.start(CONFIG)
        self.assertEqual(initial.watermarks[GROUP]["sortSeq"], 200)
        self.assertEqual(initial.poll()["messages"], [])

    def test_ambiguous_name_requires_explicit_id_and_fuzzy_name_is_rejected(self):
        conn = self.db._contact_conn()
        conn.execute("INSERT INTO contact VALUES ('other@chatroom','Test group','')")
        conn.commit()
        conn.close()
        with self.assertRaisesRegex(RuntimeError, "重名"):
            self.reader.access.resolve_conversation("Test group", "group", None)
        with self.assertRaisesRegex(RuntimeError, "未找到"):
            self.reader.access.resolve_conversation("Test", "group", None)
        self.assertEqual(self.reader.access.resolve_conversation("Test group", "group", GROUP), GROUP)

    def test_account_switch_is_rejected(self):
        self.db.account = "another_account"
        restarted = Reader(self.db, self.state)
        with self.assertRaisesRegex(RuntimeError, "账号"):
            restarted.start(CONFIG)

    def test_decode_placeholder_blocks_batch_but_text_prefix_is_kept(self):
        self.db.add(1, content="[文本] legitimate user text")
        batch = self.reader.poll()
        self.assertEqual(len(batch["messages"]), 1)
        self.reader.ack(batch["batchId"])
        self.db.add(2, content="[文本]")
        literal = self.reader.poll()
        self.assertEqual(literal["messages"][0]["text"], "[文本]")
        self.reader.ack(literal["batchId"])
        self.db.add(3, content=b"undecodable binary")
        with self.assertRaisesRegex(RuntimeError, "无法解码"):
            self.reader.poll()


if __name__ == "__main__":
    unittest.main()
