"""Build a Meal Note review link; this script never writes to the recipe app."""

import argparse
import json
import math
import sys
from pathlib import Path
from urllib.parse import quote, urlsplit

MAX_JSON_CHARS = 20_000
MAX_LINK_CHARS = 12_000
DEFAULT_APP_URL = "https://seg1142.github.io/meal-note/"


def validate_recipe(recipe):
    if not isinstance(recipe, dict):
        raise ValueError("Pass one recipe object, not an array or a backup.")
    if not isinstance(recipe.get("title"), str) or not recipe["title"].strip():
        raise ValueError("A non-empty title is required.")
    for field in ("ingredients", "steps"):
        entries = recipe.get(field)
        if not isinstance(entries, list) or not 1 <= len(entries) <= 100:
            raise ValueError(f"{field} must contain 1 to 100 entries.")
    for ingredient in recipe["ingredients"]:
        if isinstance(ingredient, str) and ingredient.strip():
            continue
        if not isinstance(ingredient, dict) or not isinstance(ingredient.get("name"), str) or not ingredient["name"].strip():
            raise ValueError("Every ingredient needs a name or non-empty text.")
        quantity = ingredient.get("quantity")
        if quantity is not None and (type(quantity) not in (int, float) or not math.isfinite(quantity) or quantity < 0):
            raise ValueError("Ingredient quantity must be a non-negative number or null.")
        for key in ("unit", "note", "originalText"):
            if key in ingredient and not isinstance(ingredient[key], str):
                raise ValueError(f"Ingredient {key} must be a string.")
        if "optional" in ingredient and type(ingredient["optional"]) is not bool:
            raise ValueError("Ingredient optional must be a boolean.")
    for step in recipe["steps"]:
        if not isinstance(step, str) or not step.strip():
            raise ValueError("Every step must be a non-empty string.")
    if "servings" in recipe and (type(recipe["servings"]) not in (int, float) or not math.isfinite(recipe["servings"]) or recipe["servings"] <= 0):
        raise ValueError("servings must be a positive number.")
    for key in ("prepTimeMinutes", "cookTimeMinutes"):
        value = recipe.get(key)
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value < 0):
            raise ValueError(f"{key} must be a non-negative number or null.")
    return recipe


def build_link(recipe, app_url=DEFAULT_APP_URL):
    validate_recipe(recipe)
    parsed = urlsplit(app_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("app-url must be an HTTP(S) app URL without credentials, query, or fragment.")
    compact = json.dumps(recipe, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    # Browser validation uses JavaScript string length (UTF-16 code units).
    json_chars = len(compact.encode("utf-16-le")) // 2
    if json_chars > MAX_JSON_CHARS:
        raise ValueError(f"Recipe JSON exceeds {MAX_JSON_CHARS} characters.")
    target = app_url.rstrip("/") + "/#/recipes/import"
    url = target + "?recipe=" + quote(compact, safe="~()*!.'-_")
    too_long = len(url) > MAX_LINK_CHARS
    return {
        "title": recipe["title"],
        "url": None if too_long else url,
        "importUrl": target,
        "jsonCharacters": json_chars,
        "linkCharacters": len(url),
        "requiresPaste": too_long,
        "saved": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recipe_file", type=Path)
    parser.add_argument("--app-url", default=DEFAULT_APP_URL)
    args = parser.parse_args()
    try:
        recipe = json.loads(args.recipe_file.read_text(encoding="utf-8-sig"))
        result = build_link(recipe, args.app_url)
    except (OSError, ValueError, TypeError) as exc:
        parser.exit(2, f"Error: {exc}\n")
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
