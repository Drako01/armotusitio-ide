"""Harness interpreter launches never write bytecode into the managed Python runtime.

`-I` ignores PYTHONDONTWRITEBYTECODE, so a child of the verified runtime launched without `-B` drops `__pycache__`
into `.harness/runtime/python/**/Lib` and the next integrity check fails. Static and deterministic: no symlinks or
privileges, no interpreter is spawned.
"""
import ast
import unittest
from pathlib import Path

HARNESS = Path(__file__).resolve().parents[2]
SCANNED = [HARNESS / 'cli.py', *sorted((HARNESS / 'core').rglob('*.py')), *sorted((HARNESS / 'tests/python').rglob('*.py'))]


def is_interpreter(node):
    return isinstance(node, ast.Attribute) and node.attr == 'executable' and isinstance(node.value, ast.Name) \
        and node.value.id == 'sys'


def flags(sequence):
    return {item.value for item in sequence.elts if isinstance(item, ast.Constant) and isinstance(item.value, str)}


def violations(source, name='<source>'):
    """Literal launches of sys.executable (`[sys.executable, ...]` or `fn(sys.executable, [...])`) lacking -B."""
    found = []
    for node in ast.walk(ast.parse(source, name)):
        launch = None
        operands = node.elts if isinstance(node, (ast.List, ast.Tuple)) else node.args if isinstance(node, ast.Call) else []
        if operands and is_interpreter(operands[0]):
            # `(sys.executable, [args])` and `spawn_run(sys.executable, [args])` carry flags in the second operand.
            nested = len(operands) > 1 and isinstance(operands[1], (ast.List, ast.Tuple))
            launch = operands[1] if nested else node if not isinstance(node, ast.Call) else None
        if launch is not None and '-B' not in flags(launch):
            found.append(f'{name}:{node.lineno} launches sys.executable without -B'
                         + (' despite -I' if '-I' in flags(launch) else ''))
    return found


class BytecodeIsolationTests(unittest.TestCase):
    def test_detector_flags_isolated_launch_without_dont_write_bytecode(self):
        self.assertEqual(len(violations("subprocess.run([sys.executable, '-I', 'cli.py'])")), 1)
        self.assertEqual(len(violations("runner.spawn_run(sys.executable, ['-I', '-S', '-c', 'pass'])")), 1)
        self.assertEqual(len(violations("plan = [sys.executable, '-c', 'pass']")), 1)
        self.assertEqual(violations("subprocess.run([sys.executable, '-I', '-S', '-B', 'cli.py'])"), [])
        self.assertEqual(len(violations("cmd, args = (sys.executable, ['-I', '-c', probe])")), 1)
        self.assertEqual(violations("runner.spawn_run(sys.executable, ['-B', '-c', 'pass'])"), [])
        self.assertEqual(violations("cmd, args = (sys.executable, ['-I', '-S', '-B', '-c', probe])"), [])

    def test_harness_sources_launch_the_interpreter_with_dont_write_bytecode(self):
        self.assertTrue(SCANNED)
        found = [issue for path in SCANNED
                 for issue in violations(path.read_text(encoding='utf-8'), path.relative_to(HARNESS).as_posix())]
        self.assertEqual(found, [])


if __name__ == '__main__':
    unittest.main()
