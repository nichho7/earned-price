# Proves each exam pack's planted bugs are real and that the answer key points at them.
# MIT License. Standard library only. Used by `npm test` (test/packs.test.js).
#
# For every pack in packs/index.json:
#   1. Run its unittest suite on the frozen code. The tests that fail must be exactly
#      test_bug_B1..B5 (one per bug in the answer key), each by an assertion FAILURE. Any ERROR
#      (NameError, crash, wrong exception) fails the check: a broken test is not a bug exposed.
#      Every test_ok_* must pass and nothing may be skipped.
#   2. Apply each reference fix (packs/reference-fixes.json) alone to a scratch copy. The fix must
#      sit inside its key's line window, the key's category must be the fix's, and exactly that
#      bug's test_bug_* must flip to pass. All five fixes together must make every test pass.
# Exit 0 when all packs hold, 1 otherwise.

import json
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # keep pack folders free of __pycache__


def run_suite(folder):
    """Runs every test_*.py in folder with fresh imports; returns (failed, errored, skipped, ran)."""
    for name in os.listdir(folder):
        if name.endswith(".py"):
            sys.modules.pop(name[:-3], None)
    saved_path = list(sys.path)
    try:
        suite = unittest.defaultTestLoader.discover(folder, pattern="test_*.py", top_level_dir=folder)
        result = unittest.TestResult()
        suite.run(result)
    finally:
        sys.path[:] = saved_path
    name = lambda t: t.id().split(".")[-1]  # noqa: E731
    return (
        {name(t) for t, _ in result.failures},
        {name(t) for t, _ in result.errors},
        [t.id() for t, _ in result.skipped],
        result.testsRun,
    )


def bug_test_ids(names):
    return {n.split("_")[2] for n in names if n.startswith("test_bug_")}


def describe(failed, errored, skipped, expected_bugs):
    """Problems with a run whose failing tests should be exactly test_bug_<expected_bugs>."""
    problems = []
    if errored:
        problems.append(f"tests errored instead of failing an assertion {sorted(errored)}")
    if bug_test_ids(failed) != expected_bugs:
        problems.append(f"bug tests failing {sorted(bug_test_ids(failed))}, expected {sorted(expected_bugs)}")
    failed_ok = sorted(n for n in failed if not n.startswith("test_bug_"))
    if failed_ok:
        problems.append(f"control tests failing {failed_ok}")
    if skipped:
        problems.append(f"skipped {skipped}")
    return problems


def apply_fixes(source, fixes):
    lines = source.split("\n")
    for fix in sorted(fixes, key=lambda f: f["start"], reverse=True):
        lines[fix["start"] - 1:fix["end"]] = fix["new"]
    return "\n".join(lines)


def run_fixed(folder, fixes):
    with tempfile.TemporaryDirectory() as tmp:
        copy = os.path.join(tmp, "pack")
        shutil.copytree(folder, copy, ignore=shutil.ignore_patterns("__pycache__"))
        by_file = {}
        for fix in fixes:
            by_file.setdefault(fix["file"], []).append(fix)
        for path, file_fixes in by_file.items():
            with open(os.path.join(copy, path), encoding="utf-8") as f:
                source = f.read()
            with open(os.path.join(copy, path), "w", encoding="utf-8") as f:
                f.write(apply_fixes(source, file_fixes))
        return run_suite(copy)


def check_fixes(pack, folder, key, fixes):
    problems = []
    bugs = {bug["id"]: bug for bug in key["bugs"]}
    mine = [f for f in fixes if f["pack"] == pack["id"]]
    if sorted(f["bug"] for f in mine) != sorted(bugs):
        return [f"reference fixes cover {sorted(f['bug'] for f in mine)}, key has {sorted(bugs)}"]
    for fix in mine:
        bug = bugs[fix["bug"]]
        tag = f"fix {fix['bug']}"
        if fix["file"] != bug["file"]:
            problems.append(f"{tag}: file {fix['file']} but key says {bug['file']}")
            continue
        if bug["category"] != fix["category"]:
            problems.append(f"{tag}: key category {bug['category']}, expected {fix['category']}")
        if not (bug["line_start"] <= fix["start"] <= fix["end"] <= bug["line_end"]):
            problems.append(f"{tag}: changes lines {fix['start']}-{fix['end']}, outside key window "
                            f"{bug['line_start']}-{bug['line_end']}")
            continue
        with open(os.path.join(folder, fix["file"]), encoding="utf-8") as f:
            actual = f.read().split("\n")[fix["start"] - 1:fix["end"]]
        if actual != fix["old"]:
            problems.append(f"{tag}: lines {fix['start']}-{fix['end']} are {actual}, fix expects {fix['old']}")
            continue
        failed, errored, skipped, _ = run_fixed(folder, [fix])
        problems += [f"{tag} alone: {p}" for p in describe(failed, errored, skipped, set(bugs) - {fix["bug"]})]
    if not problems:
        failed, errored, skipped, _ = run_fixed(folder, mine)
        problems += [f"all fixes: {p}" for p in describe(failed, errored, skipped, set())]
    return problems


def check(pack, fixes):
    folder = os.path.join(ROOT, pack["dir"])
    with open(os.path.join(folder, "answer-key.json"), encoding="utf-8") as f:
        key = json.load(f)
    expected = {bug["id"] for bug in key["bugs"]}
    failed, errored, skipped, ran = run_suite(folder)
    problems = describe(failed, errored, skipped, expected)
    if ran < len(expected) + 1:
        problems.append(f"only {ran} tests ran")
    if not problems:
        problems = check_fixes(pack, folder, key, fixes)
    return problems, ran


def main():
    with open(os.path.join(ROOT, "index.json"), encoding="utf-8") as f:
        packs = json.load(f)["packs"]
    with open(os.path.join(ROOT, "reference-fixes.json"), encoding="utf-8") as f:
        fixes = json.load(f)["fixes"]
    ok = True
    for pack in packs:
        problems, ran = check(pack, fixes)
        if problems:
            print(f"pack {pack['id']}: FAIL: {'; '.join(problems)}")
        else:
            print(f"pack {pack['id']}: OK ({ran} tests; 5 planted-bug tests fail as designed; "
                  f"each reference fix flips only its own test)")
        ok = ok and not problems
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
