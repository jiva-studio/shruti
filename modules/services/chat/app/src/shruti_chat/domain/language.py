"""Language-tag handling.

Two things in this service reduce a language tag, and they are NOT two
implementations of one rule — they answer different questions:

  - `research.pipeline.reduce_locale_to_content_lang` — which corpus content
    language does this UI locale map to? (`uk` -> `ru`, because there is no
    Ukrainian corpus.)
  - `observability.auto_scores._base_lang` — which bucket do I compare in?
    (`hr` -> `sr`, because langdetect confuses the Serbo-Croatian continuum.)

Both policies are correct and neither should absorb the other. What they DO
share is the step before: turning a BCP-47-ish tag into its base subtag. That
step was written twice and the copies disagreed — one normalised `_` to `-`,
the other did not, so `sr_Latn` reduced to `sr_latn` and could never equal a
detected `sr`. Any client sending an underscore locale scored a correct
Serbian answer as a language mismatch.

This module owns that one step. The policies stay where they belong.
"""

from __future__ import annotations


def base_tag(code: str | None) -> str:
    """The base subtag of a language tag, lowercased.

    Accepts both separators — `sr-Latn` and `sr_Latn` are the same tag, and
    clients send both. Returns `""` for empty input so callers can decide what
    absence means rather than being handed a guess.

        >>> base_tag("sr-Latn"), base_tag("sr_Latn"), base_tag("EN_US")
        ('sr', 'sr', 'en')
    """
    if not code:
        return ""
    return code.strip().lower().replace("_", "-").split("-", 1)[0]
