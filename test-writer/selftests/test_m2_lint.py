"""Self-tests for the M2 static lint and its fixture manifest.

These tests use only the standard library and local fixtures.  They do not
contact the network, use sudo, or depend on ``/opt/test-writer``.
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from grader.lint import MAX_SOURCE_BYTES, lint_source  # noqa: E402
from grader.reasons import LINT_RULES, hint_for  # noqa: E402

FIXTURES = ROOT / "fixtures" / "lint"
MANIFEST = json.loads((FIXTURES / "MANIFEST.json").read_text(encoding="utf-8"))
EXPECTED = MANIFEST["expected"]
ALLOWED_MODULES = MANIFEST["allowed_modules"]


def rule_ids(source, allowed_modules=ALLOWED_MODULES):
    return [item["rule"] for item in lint_source(source, allowed_modules=allowed_modules)]


class ManifestFixtureTests(unittest.TestCase):
    def test_manifest_covers_every_fixture_file(self):
        on_disk = {
            path.name
            for path in FIXTURES.iterdir()
            if path.is_file() and path.name != "MANIFEST.json"
        }
        self.assertEqual(on_disk, set(EXPECTED))

    def test_manifest_expectations_are_known_rules(self):
        for name, expected in EXPECTED.items():
            with self.subTest(fixture=name):
                self.assertIsInstance(expected, list)
                self.assertEqual(len(expected), len(set(expected)))
                for rule in expected:
                    self.assertIn(rule, LINT_RULES)

    def test_every_rule_has_a_bad_fixture(self):
        covered = set()
        for name, expected in EXPECTED.items():
            if name.startswith("bad_"):
                self.assertTrue(expected, name)
                covered.update(expected)
            else:
                self.assertEqual(expected, [], name)
        self.assertEqual(covered, set(LINT_RULES))

    def test_fixture_rule_sets_match_manifest(self):
        for name, expected in EXPECTED.items():
            with self.subTest(fixture=name):
                source = (FIXTURES / name).read_text(encoding="utf-8")
                self.assertEqual(rule_ids(source), expected)

    def test_violation_shape_and_hint(self):
        for name in EXPECTED:
            source = (FIXTURES / name).read_text(encoding="utf-8")
            for violation in lint_source(source, allowed_modules=ALLOWED_MODULES):
                with self.subTest(fixture=name, rule=violation["rule"]):
                    self.assertEqual(set(violation), {"rule", "hint"})
                    self.assertIn(violation["rule"], LINT_RULES)
                    self.assertEqual(
                        violation["hint"], hint_for(f"LINT:{violation['rule']}")
                    )

    def test_rule_order_is_stable_and_deduplicated(self):
        source = (
            "import os\n\n\n"
            "def test_a():\n"
            "    assert True\n\n\n"
            "def test_b():\n"
            "    assert 1 == 1\n"
        )
        rules = rule_ids(source)
        self.assertEqual(rules, [rule for rule in LINT_RULES if rule in set(rules)])
        self.assertEqual(len(rules), len(set(rules)))
        self.assertIn("TAUTOLOGY", rules)
        self.assertIn("DISALLOWED_IMPORT", rules)
        self.assertIn("SIZE", rules)

    def test_allowed_modules_controls_target_imports(self):
        source = (FIXTURES / "good_plain.py").read_text(encoding="utf-8")
        self.assertEqual(rule_ids(source, ("target",)), [])
        self.assertEqual(rule_ids(source, ()), ["DISALLOWED_IMPORT"])


class OracleTests(unittest.TestCase):
    def test_detector_check_is_an_oracle(self):
        source = "def test_exercises():\n    detector.check(False, detail='safe')\n"
        self.assertEqual(rule_ids(source), [])

    def test_pytest_raises_is_an_oracle(self):
        source = (
            "import pytest\n\n\n"
            "def test_rejects():\n"
            "    with pytest.raises(ValueError):\n"
            "        raise ValueError\n"
        )
        self.assertEqual(rule_ids(source), [])

    def test_assertion_outside_the_test_is_not_an_oracle(self):
        source = (
            "def helper():\n"
            "    observed = 1\n"
            "    assert observed == 1\n\n\n"
            "def test_calls_helper():\n"
            "    helper()\n"
        )
        self.assertIn("NO_ORACLE", rule_ids(source))

    def test_uncalled_nested_assertion_is_not_an_oracle(self):
        source = (
            "def test_never_runs_helper():\n"
            "    def helper():\n"
            "        observed = 1\n"
            "        assert observed == 1\n"
            "    return None\n"
        )
        self.assertIn("NO_ORACLE", rule_ids(source))

    def test_shadowed_detector_is_a_hook(self):
        source = (
            "def detector():\n"
            "    return None\n\n\n"
            "def test_uses_shadow():\n"
            "    observed = 1\n"
            "    assert observed == 1\n"
        )
        rules = rule_ids(source)
        self.assertIn("PYTEST_HOOK", rules)


class SizeTests(unittest.TestCase):
    def test_size_budget_boundary(self):
        prefix = "def test_boundary():\n    observed = 1\n    assert observed == 1\n"
        padding = MAX_SOURCE_BYTES - len(prefix) - 1
        self.assertGreater(padding, 0)
        exact = prefix + "#" * padding + "\n"
        self.assertEqual(len(exact.encode("utf-8")), MAX_SOURCE_BYTES)
        self.assertNotIn("SIZE", rule_ids(exact))
        oversized = exact + "\n"
        self.assertEqual(rule_ids(oversized), ["SIZE"])


class HostileInputTests(unittest.TestCase):
    def assert_never_raises(self, source, allowed_modules=()):
        try:
            result = lint_source(source, allowed_modules=allowed_modules)
        except Exception as exc:  # pragma: no cover - failure path
            self.fail(f"lint_source raised {type(exc).__name__}: {exc}")
        self.assertIsInstance(result, list)
        for violation in result:
            self.assertIn(violation["rule"], LINT_RULES)
            self.assertEqual(violation["hint"], hint_for(f"LINT:{violation['rule']}"))
        return result

    def test_non_string_inputs_are_syntax(self):
        for value in (None, 7, b"def test_x(): pass", ["not", "source"]):
            with self.subTest(value=value):
                result = self.assert_never_raises(value)
                self.assertEqual([item["rule"] for item in result], ["SYNTAX"])

    def test_malformed_sources_never_raise(self):
        cases = (
            "def test_broken(:\n    pass\n",
            "def test_x():\n    return (\n",
            "",
            "for x in range(3)\n    pass\n",
        )
        for source in cases:
            with self.subTest(source=source):
                self.assert_never_raises(source)

    def test_surrogate_text_never_raises(self):
        source = "def test_x():\n    observed = '\ud800'\n    assert observed\n"
        self.assert_never_raises(source)

    def test_nul_byte_never_raises(self):
        source = "def test_x():\n    assert 1 == 1\x00\n"
        self.assert_never_raises(source)

    def test_deeply_nested_expression_never_raises(self):
        depth = 2000
        source = "def test_x():\n    assert " + "(" * depth + "1" + ")" * depth + "\n"
        self.assert_never_raises(source)

    def test_lint_does_not_execute_source(self):
        source = (
            "raise RuntimeError('source executed')\n\n\n"
            "def test_x():\n"
            "    observed = 1\n"
            "    assert observed == 1\n"
        )
        self.assertIn("MODULE_SIDE_EFFECT", rule_ids(source))

    def test_oversized_source_reports_size(self):
        prefix = "def test_oversized():\n    observed = 1\n    assert observed == 1\n"
        source = prefix + "#" * (MAX_SOURCE_BYTES + 1 - len(prefix))
        self.assertEqual(rule_ids(source), ["SIZE"])


class EvasionTests(unittest.TestCase):
    def test_split_canary_literal_is_detected(self):
        source = (
            "def test_split_canary():\n"
            "    protected = '/can' + 'ary/secret.txt'\n"
            "    assert protected\n"
        )
        self.assertIn("CANARY_LITERAL", rule_ids(source))

    def test_builtins_access_is_a_dynamic_escape(self):
        source = (
            "def test_builtins():\n"
            "    opener = __builtins__['open']\n"
            "    assert opener\n"
        )
        self.assertIn("DYNAMIC_ESCAPE", rule_ids(source))

    def test_folded_constant_assertion_is_tautology(self):
        source = "def test_math():\n    assert 1 + 1 == 2\n"
        self.assertIn("TAUTOLOGY", rule_ids(source))

    def test_false_constant_assertion_is_not_tautology(self):
        source = "def test_math():\n    assert 1 == 2\n"
        self.assertNotIn("TAUTOLOGY", rule_ids(source))

    def test_aliased_hypothesis_profile_is_detected(self):
        source = (
            "from hypothesis import settings as fast\n\n\n"
            "@fast(max_examples=1)\n"
            "def test_profile():\n"
            "    assert 1 == 2\n"
        )
        self.assertIn("HYPOTHESIS_OVERRIDE", rule_ids(source))

    def test_aliased_pytest_raises_is_an_oracle(self):
        source = (
            "import pytest as pt\n\n\n"
            "def test_rejects():\n"
            "    with pt.raises(ValueError):\n"
            "        raise ValueError\n"
        )
        self.assertEqual(rule_ids(source), [])

    def test_aliased_skip_decorator_is_detected(self):
        source = (
            "import pytest as pt\n\n\n"
            "@pt.mark.skip(reason='later')\n"
            "def test_skipped():\n"
            "    observed = 1\n"
            "    assert observed == 1\n"
        )
        self.assertIn("SKIP_OR_XFAIL", rule_ids(source))


class PluginEscapeTests(unittest.TestCase):
    """Regression tests for the audit findings against pytest escape hatches."""

    def test_helper_api_examples_stay_green(self):
        for name in ("good_plain.py", "good_hypothesis.py", "good_parameter.py"):
            with self.subTest(fixture=name):
                source = (FIXTURES / name).read_text(encoding="utf-8")
                self.assertEqual(rule_ids(source), [])

    def test_request_and_pytestconfig_parameters_are_mocking(self):
        cases = {
            "request": (
                "def test_forbidden(request):\n"
                "    detector.check(False)\n"
            ),
            "pytestconfig": (
                "def test_forbidden(pytestconfig):\n"
                "    detector.check(False)\n"
            ),
            "mocker": (
                "def test_forbidden(mocker):\n"
                "    detector.check(False)\n"
            ),
            "monkeypatch": (
                "def test_forbidden(monkeypatch):\n"
                "    detector.check(False)\n"
            ),
        }
        for label, source in cases.items():
            with self.subTest(fixture=label):
                self.assertEqual(rule_ids(source), ["MOCKING"])

    def test_pytest_monkeypatch_is_mocking(self):
        source = (
            "import pytest\n\n\n"
            "def test_patches(detector):\n"
            "    pytest.MonkeyPatch()\n"
            "    detector.check(False)\n"
        )
        self.assertEqual(rule_ids(source), ["MOCKING"])

    def test_plugin_manager_attributes_are_dynamic_escape(self):
        cases = {
            "config": "pytest.config",
            "pluginmanager": "pytest.config.pluginmanager",
            "get_plugin": "pytest.config.pluginmanager.get_plugin",
            "getplugin": "pytest.config.pluginmanager.getplugin",
            "_getplugin": "pytest.config.pluginmanager._getplugin",
            "plugins": "pytest.config.pluginmanager.plugins",
        }
        for label, expression in cases.items():
            source = (
                "import pytest\n\n\n"
                "def test_escape(detector):\n"
                f"    value = {expression}\n"
                "    detector.check(False)\n"
            )
            with self.subTest(attribute=label):
                self.assertEqual(rule_ids(source), ["DYNAMIC_ESCAPE"])

    def test_request_attribute_chain_is_dynamic_escape(self):
        source = (
            "def test_escape(detector, request):\n"
            "    value = request.config.pluginmanager.get_plugin('plugin')\n"
            "    detector.check(False)\n"
        )
        self.assertEqual(rule_ids(source), ["MOCKING", "DYNAMIC_ESCAPE"])

    def test_any_dunder_attribute_is_dynamic_escape(self):
        for attribute in ("__doc__", "__file__", "__code__", "__globals__"):
            source = (
                "def test_dunder(detector):\n"
                f"    value = object().{attribute}\n"
                "    detector.check(False)\n"
            )
            with self.subTest(attribute=attribute):
                self.assertEqual(rule_ids(source), ["DYNAMIC_ESCAPE"])

    def test_aliased_pytest_escape_is_dynamic_escape(self):
        source = (
            "import pytest as pt\n\n\n"
            "def test_escape(detector):\n"
            "    value = pt.config.pluginmanager\n"
            "    detector.check(False)\n"
        )
        self.assertEqual(rule_ids(source), ["DYNAMIC_ESCAPE"])

    def test_pytest_exit_is_pytest_hook(self):
        for expression in ("pytest.exit('stop')", "pytest.exit('stop', returncode=0)"):
            source = (
                "import pytest\n\n\n"
                "def test_exits(detector):\n"
                "    detector.check(False)\n"
                f"    {expression}\n"
            )
            with self.subTest(expression=expression):
                self.assertEqual(rule_ids(source), ["PYTEST_HOOK"])

    def test_aliased_pytest_exit_is_pytest_hook(self):
        source = (
            "import pytest as pt\n\n\n"
            "def test_exits(detector):\n"
            "    detector.check(False)\n"
            "    pt.exit('stop', returncode=0)\n"
        )
        self.assertEqual(rule_ids(source), ["PYTEST_HOOK"])

    def test_escape_exception_names_are_dynamic_escape(self):
        for name in ("SystemExit", "KeyboardInterrupt", "GeneratorExit"):
            source = (
                "def test_raises(detector):\n"
                "    detector.check(False)\n"
                f"    raise {name}(0)\n"
            )
            with self.subTest(name=name):
                self.assertEqual(rule_ids(source), ["DYNAMIC_ESCAPE"])


if __name__ == "__main__":
    unittest.main()
