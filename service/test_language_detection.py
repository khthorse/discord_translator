import unittest

from language_detection import best_allowed_language, requested_language_hint


class LanguageSelectionTests(unittest.TestCase):
    def test_reuses_valid_turn_hint(self):
        self.assertEqual(requested_language_hint(["en", "es"], "es"), "es")

    def test_ignores_invalid_turn_hint(self):
        self.assertIsNone(requested_language_hint(["en", "es"], "fr"))

    def test_forces_only_allowed_language(self):
        self.assertEqual(requested_language_hint(["no"], ""), "no")

    def test_empty_allowlist_keeps_automatic_detection(self):
        self.assertIsNone(requested_language_hint([], "en"))

    def test_selects_highest_probability_allowed_language(self):
        self.assertEqual(
            best_allowed_language(["en", "es", "no"], {"en": 0.1, "es": 0.7, "no": 0.2}),
            "es",
        )

    def test_probability_tie_preserves_configured_order(self):
        self.assertEqual(best_allowed_language(["no", "en"], {"no": 0.4, "en": 0.4}), "no")

    def test_empty_allowlist_has_no_correction(self):
        self.assertIsNone(best_allowed_language([], {"en": 1.0}))


if __name__ == "__main__":
    unittest.main()
