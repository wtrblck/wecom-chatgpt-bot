# Third-party attribution

`GateScanner.cs` adapts the PE section, RIP-relative cross-reference, accessibility gate byte-pattern and proximity algorithm from:

- Project: [fanyuantaier/wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica)
- Source: [wechatauto/uia_driver.py](https://github.com/fanyuantaier/wechatauto-replica/blob/b9a9f5619f34c6a3e6eb15c27ec73d0adbbb4386/wechatauto/uia_driver.py)
- Commit: `b9a9f5619f34c6a3e6eb15c27ec73d0adbbb4386`
- License: Apache License 2.0, reproduced in `LICENSE` alongside this notice.

Changes made on 2026-09-06: translated the scanner into C#; required x64 PE32+, bounded non-overlapping sections, exactly one read-only log anchor and at least one matching reference, a unique gate target in writable non-executable image data; removed upstream hard-coded offsets and closest-address fallback. Added independent process identity, disk hash, in-memory instruction/header evidence, page protection, original-byte and post-write read-back validation. No upstream automatic login, foreground activation, OCR, sending or module injection code is included.

The upstream author does not endorse these modifications. The scan pattern is evidence of a candidate accessibility state byte, not a guarantee that a particular client build exposes working UIA controls after activation.
