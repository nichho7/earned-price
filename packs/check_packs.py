# Proves each exam pack's planted bugs are real. MIT License. Standard library only.
# For every pack in packs/index.json: run its unittest suite and require that the tests that fail
# are exactly test_bug_B1..B5 (one per planted bug in the answer key) and every test_ok_* passes.
# Exit 0 when all packs hold, 1 otherwise. Used by `npm test` (test/packs.test.js).

import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))


def check(pack):
    folder = os.path.join(ROOT, pack["dir"])
    with open(os.path.join(folder, "answer-key.json"), encoding="utf-8") as f:
        key = json.load(f)
    expected = {f"test_bug_{bug['id']}" for bug in key["bugs"]}
    suite = unittest.defaultTestLoader.discover(folder, pattern="test_*.py", top_level_dir=folder)
    result = unittest.TestResult()
    suite.run(result)
    broken = [t for t, _ in result.failures + result.errors]
    names = {t.id().split(".")[-1] for t in broken}
    failed_bugs = {"test_bug_" + n.split("_")[2] for n in names if n.startswith("test_bug_")}
    failed_ok = sorted(n for n in names if not n.startswith("test_bug_"))
    skipped = [t.id() for t, _ in result.skipped]
    problems = []
    if failed_bugs != expected:
        problems.append(f"bug tests failing {sorted(failed_bugs)}, expected {sorted(expected)}")
    if failed_ok:
        problems.append(f"control tests failing {failed_ok}")
    if skipped:
        problems.append(f"skipped {skipped}")
    if result.testsRun < len(expected) + 1:
        problems.append(f"only {result.testsRun} tests ran")
    return problems, result.testsRun


def main():
    with open(os.path.join(ROOT, "index.json"), encoding="utf-8") as f:
        packs = json.load(f)["packs"]
    ok = True
    for pack in packs:
        sys.path.insert(0, os.path.join(ROOT, pack["dir"]))
        problems, ran = check(pack)
        status = "OK" if not problems else "FAIL"
        print(f"pack {pack['id']}: {status} ({ran} tests; 5 planted-bug tests fail as designed)"
              if not problems else f"pack {pack['id']}: {status}: {'; '.join(problems)}")
        ok = ok and not problems
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
