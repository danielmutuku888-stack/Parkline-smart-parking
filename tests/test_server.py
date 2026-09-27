import unittest

from server import amounts_match


class AmountComparisonTests(unittest.TestCase):
    def test_accepts_minor_float_precision_drift(self):
        self.assertTrue(amounts_match(30.16, 30.160000000000004))

    def test_rejects_real_fee_change(self):
        self.assertFalse(amounts_match(30.16, 50.0))


if __name__ == "__main__":
    unittest.main()
