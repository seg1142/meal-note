import importlib.util
import json
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

MODULE = Path(__file__).resolve().parents[1] / "skills/save-recipe/scripts/build_save_link.py"
SPEC = importlib.util.spec_from_file_location("save_link", MODULE)
save_link = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(save_link)


class SaveLinkTests(unittest.TestCase):
    def recipe(self):
        return {
            "generator": "chatgpt",
            "title": "動線テスト（実レシピではありません）",
            "servings": 1,
            "ingredients": [{"name": "テスト材料", "quantity": None, "unit": "g", "originalText": "テスト材料 150〜200g", "note": "お好みで", "optional": True}],
            "steps": ["これは画面・データ保持の確認用です。"],
        }

    def test_unicode_round_trip_and_no_saved_claim(self):
        recipe = self.recipe()
        result = save_link.build_link(recipe, "http://127.0.0.1:4173/")
        payload = parse_qs(urlsplit(result["url"]).fragment.split("?", 1)[1])["recipe"][0]
        self.assertEqual(json.loads(payload), recipe)
        self.assertFalse(result["saved"])

    def test_rejects_invalid_recipe(self):
        for patch in ({"title": ""}, {"ingredients": []}, {"steps": [""]}, {"servings": True}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                save_link.build_link(self.recipe() | patch)

    def test_rejects_non_finite_and_boolean_quantities(self):
        for quantity in (True, float("nan"), float("inf"), -1):
            recipe = self.recipe()
            recipe["ingredients"][0]["quantity"] = quantity
            with self.subTest(quantity=quantity), self.assertRaises(ValueError):
                save_link.build_link(recipe)

    def test_long_url_falls_back_to_paste(self):
        recipe = self.recipe() | {"description": "補足" * 1000}
        result = save_link.build_link(recipe)
        self.assertIsNone(result["url"])
        self.assertTrue(result["requiresPaste"])
        self.assertTrue(result["importUrl"].endswith("#/recipes/import"))

    def test_json_limit_counts_browser_utf16_units(self):
        recipe = self.recipe() | {"description": "🍳" * 10000}
        with self.assertRaises(ValueError):
            save_link.build_link(recipe)

    def test_rejects_bad_app_destinations(self):
        for destination in ("javascript:alert(1)", "https://user:secret@example.com/", "https://example.com/#wrong", "https://example.com/?key=value"):
            with self.subTest(destination=destination), self.assertRaises(ValueError):
                save_link.build_link(self.recipe(), destination)


if __name__ == "__main__":
    unittest.main()
