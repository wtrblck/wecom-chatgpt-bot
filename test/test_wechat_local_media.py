"""Synthetic local-media tests. No live account, downloads or messages."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import struct
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from PIL import Image
from test_wechat_db_reader import reader_module, GROUP, PROJECT_ROOT

spec = importlib.util.spec_from_file_location('local_media_test', PROJECT_ROOT / 'scripts/wechat-local-media.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LocalMediaTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='.test-media-', dir=PROJECT_ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.account = self.root / 'account'
        self.account.mkdir()
        self.output = self.root / 'output'
        self.db = SimpleNamespace(account_dir=str(self.account), wxid='synthetic', _friendly_content=lambda data, kind: data.decode())
        self.vendor = reader_module.load_upstream_media().MediaDownloader(self.db, save_dir=str(self.output))
        self.resolver = module.LocalMediaResolver(self.db, self.vendor, self.output)
        stream = io.BytesIO()
        Image.new('RGB', (4, 4), 'red').save(stream, format='PNG')
        self.png = stream.getvalue()
        self.digest = hashlib.md5(self.png).hexdigest()

    def image_row(self):
        return {'local_id': 1, 'sort_seq': 1, 'create_time': 1700000000, 'packed_info_data': self.digest.encode()}

    def sticker_row(self, digest):
        return {'message_content': '<msg><emoji md5="%s" cdnurl="https://invalid.example/do-not-download"/></msg>' % digest}

    def test_xor_encrypted_image_is_decoded_without_touching_original(self):
        folder = self.account / 'msg/attach' / hashlib.md5(GROUP.encode()).hexdigest() / '2026-09/Img'
        folder.mkdir(parents=True)
        candidate = folder / (self.digest + '.dat')
        encrypted = bytes(value ^ 0x88 for value in self.png)
        candidate.write_bytes(encrypted)
        output = self.resolver.resolve(GROUP, self.image_row(), 'image')
        self.assertEqual(Path(output).read_bytes(), self.png)
        self.assertEqual(candidate.read_bytes(), encrypted)
        self.assertEqual(self.resolver.resolve(GROUP, self.image_row(), 'image'), output)
        self.assertEqual(list(self.output.glob('*.tmp')), [])

    def test_v2_aes_and_xor_image_uses_local_decoder(self):
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        key, xor_key = "0123456789abcdef", 0x88
        first, middle, tail = self.png[:32], self.png[32:-8], self.png[-8:]
        encryptor = Cipher(algorithms.AES(key.encode()), modes.ECB()).encryptor()
        cipher = encryptor.update(first + bytes([16]) * 16) + encryptor.finalize()
        encoded = reader_module.load_upstream_media().V2_MAGIC + struct.pack("<LL", len(first), len(tail)) + b"\x00" + cipher + middle + bytes(value ^ xor_key for value in tail)
        folder = self.account / 'msg/attach' / hashlib.md5(GROUP.encode()).hexdigest()
        folder.mkdir(parents=True)
        candidate = folder / (self.digest + '.dat'); candidate.write_bytes(encoded)
        with patch.object(self.vendor, '_derive_xor_key', return_value=xor_key), patch.object(self.vendor, '_resolve_aes_key', return_value=key):
            output = self.resolver.resolve(GROUP, self.image_row(), 'image')
        self.assertEqual(Path(output).read_bytes(), self.png)
        self.assertEqual(candidate.read_bytes(), encoded)

    def test_local_animated_sticker_is_uploaded_as_static_first_frame(self):
        stream = io.BytesIO()
        Image.new('RGB', (4, 4), 'red').save(stream, format='GIF', save_all=True, append_images=[Image.new('RGB', (4, 4), 'blue')], duration=100, loop=0)
        data = stream.getvalue(); digest = hashlib.md5(data).hexdigest()
        folder = self.account / 'business/emoticon'; folder.mkdir(parents=True)
        (folder / (digest + '.gif')).write_bytes(data)
        output = self.resolver.resolve(GROUP, self.sticker_row(digest), 'sticker')
        with Image.open(output) as image:
            self.assertEqual(image.format, 'PNG')
            self.assertFalse(getattr(image, 'is_animated', False))
            self.assertEqual(image.convert('RGB').getpixel((0, 0)), (255, 0, 0))
        self.assertTrue(all(isinstance(value, Path) for value in self.resolver.index.values()))

    def test_extensionless_xor_sticker_uses_header_to_derive_key(self):
        folder = self.account / 'cache'; folder.mkdir()
        (folder / self.digest).write_bytes(bytes(value ^ 0x57 for value in self.png))
        output = self.resolver.resolve(GROUP, self.sticker_row(self.digest), 'sticker')
        self.assertEqual(Path(output).read_bytes(), self.png)

    def test_absent_sticker_is_not_fetched_and_new_cache_is_seen_after_refresh(self):
        self.assertIsNone(self.resolver.resolve(GROUP, self.sticker_row(self.digest), 'sticker'))
        folder = self.account / 'cache'; folder.mkdir()
        (folder / self.digest).write_bytes(self.png)
        self.resolver.scanned_at = 0
        output = self.resolver.resolve(GROUP, self.sticker_row(self.digest), 'sticker')
        self.assertEqual(Path(output).read_bytes(), self.png)

    def test_malformed_or_oversized_cache_is_not_uploaded(self):
        folder = self.account / 'cache'; folder.mkdir()
        candidate = folder / self.digest
        candidate.write_bytes(b'not an image')
        self.assertIsNone(self.resolver.resolve(GROUP, self.sticker_row(self.digest), 'sticker'))
        candidate.write_bytes(self.png)
        with patch.object(module, 'MAX_BYTES', 10):
            self.assertIsNone(self.resolver.resolve(GROUP, self.sticker_row(self.digest), 'sticker'))
        outside = self.root / 'outside.png'; outside.write_bytes(self.png)
        self.assertIsNone(self.resolver._read(outside))


if __name__ == '__main__':
    unittest.main()
