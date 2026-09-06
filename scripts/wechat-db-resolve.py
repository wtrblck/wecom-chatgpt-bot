"""Resolve configured chat IDs without polling or sending; saves initial read cursor."""
import contextlib
import importlib.util
import json
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('reader', root / 'scripts/wechat-db-reader.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with contextlib.redirect_stdout(sys.stderr):
    config = json.loads((root / 'config/wechat-conversations.json').read_text(encoding='utf-8-sig'))
    reader = module.Reader()
    reader.start(config['conversations'])
print(json.dumps({'ready': True, 'conversations': [{'name': name, 'id': identifier} for identifier, name in reader.chats.items()]}, ensure_ascii=False))
