# Simple release-notes generator.
#
# Produces per-locale "What's new" text from the git history between the
# previous `mobile-v*` tag and HEAD. Both locales receive the same diff
# for now; localize later by hand or plug in a translator here.
#
# This deliberately avoids any external service — no AWS Bedrock, no
# OpenAI, no analytics. Shruti has no backend dependencies; the CI
# toolchain stays that way too.

module ReleaseNotes
  DEFAULT_FALLBACK = "Bug fixes and improvements.".freeze

  def self.generate(locales:)
    diff = raw_diff
    text = diff.empty? ? DEFAULT_FALLBACK : diff
    locales.to_h { |l| [l, text] }
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
