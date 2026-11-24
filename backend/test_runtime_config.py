import os
import unittest
from unittest.mock import patch

try:
    from .runtime_config import read_bool, read_device, read_float, read_int
except ImportError:
    from runtime_config import read_bool, read_device, read_float, read_int


class RuntimeConfigTests(unittest.TestCase):
    def test_integer_bounds_and_invalid_values(self):
        with patch.dict(os.environ, {"VALUE": "32"}):
            self.assertEqual(read_int("VALUE", 10, minimum=32, maximum=2048), 32)
        for raw in ("not-a-number", "31", "2049"):
            with self.subTest(raw=raw), patch.dict(os.environ, {"VALUE": raw}):
                with self.assertRaises(RuntimeError):
                    read_int("VALUE", 10, minimum=32, maximum=2048)

    def test_float_rejects_non_finite_and_out_of_range_values(self):
        for raw in ("nan", "inf", "-0.1", "1.1"):
            with self.subTest(raw=raw), patch.dict(os.environ, {"VALUE": raw}):
                with self.assertRaises(RuntimeError):
                    read_float("VALUE", 0.65, minimum=0.0, maximum=1.0)

    def test_boolean_requires_an_explicit_supported_value(self):
        for raw, expected in (("true", True), ("YES", True), ("0", False), ("off", False)):
            with self.subTest(raw=raw), patch.dict(os.environ, {"VALUE": raw}):
                self.assertIs(read_bool("VALUE"), expected)
        with patch.dict(os.environ, {"VALUE": "sometimes"}):
            with self.assertRaises(RuntimeError):
                read_bool("VALUE")

    def test_device_setting_is_constrained(self):
        for raw in ("auto", "cpu", "cuda", "cuda:0", "1"):
            with self.subTest(raw=raw), patch.dict(os.environ, {"VALUE": raw}):
                self.assertEqual(read_device("VALUE"), raw)
        for raw in ("cuda:-1", "gpu", "cuda:abc"):
            with self.subTest(raw=raw), patch.dict(os.environ, {"VALUE": raw}):
                with self.assertRaises(RuntimeError):
                    read_device("VALUE")


if __name__ == "__main__":
    unittest.main()
