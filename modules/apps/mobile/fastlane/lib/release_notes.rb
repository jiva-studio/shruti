# Simple release-notes generator.
#
# Produces per-locale "What's new" text from the git history between the
# previous `mobile-v*` tag and HEAD. Both locales receive the same diff
# for now; localize later by hand or plug in a translator here.
#
# This deliberately avoids any external service — no AWS Bedrock, no
# OpenAI, no analytics. Lectorium has no backend dependencies; the CI
# toolchain stays that way too.

module ReleaseNotes
  DEFAULT_FALLBACK = "Bug fixes and improvements.".freeze
  # Google Play caps "What's new" at 500 chars per language; App Store
  # at 4000. 500 is the binding constraint — truncate to fit, with room
  # for an ellipsis suffix to signal that there's more in the changelog.
  MAX_LEN = 500
  TRUNC_SUFFIX = "…".freeze

  def self.generate(locales:)
    diff = raw_diff
    text = diff.empty? ? DEFAULT_FALLBACK : diff
    locales.to_h { |l| [l, truncate(text)] }
  end

  def self.truncate(text)
    return text if text.length <= MAX_LEN
    cut = MAX_LEN - TRUNC_SUFFIX.length
    # Prefer cutting at the last newline-or-space before the limit so we
    # don't slice through the middle of a commit-subject line.
    last_break = text.rindex(/[\n ]/, cut) || cut
    text[0...last_break].rstrip + TRUNC_SUFFIX
  end

  def self.raw_diff
    base = `git describe --tags --abbrev=0 --match 'mobile-v*' 2>/dev/null`.strip
    range = base.empty? ? "HEAD~30..HEAD" : "#{base}..HEAD"
    log = `git log --pretty=format:"- %s" #{range}`.strip
    log
  rescue StandardError
    ""
  end
end
