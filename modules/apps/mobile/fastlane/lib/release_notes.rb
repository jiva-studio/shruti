require "json"

# Generates per-locale "What's new" text for Play Console / TestFlight from
# conventional-commit history. Filters raw `git log` to user-facing types
# (feat/fix/perf), then asks Claude (via AWS Bedrock) to rewrite them in
# marketing-style prose for each requested locale. Falls back to a raw
# bulleted list if Bedrock is unreachable or credentials are missing —
# CI deploys must never fail just because release-notes generation failed.
module ReleaseNotes
  MODEL_ID = "us.anthropic.claude-sonnet-4-6"
  DEFAULT_REGION = "us-east-1"
  # Play Console hard-limits per-locale changelogs at 500 chars; leave headroom.
  PER_LOCALE_LIMIT = 450
  USER_FACING_TYPES = %w[feat fix perf].freeze

  module_function

  def generate(locales:)
    subjects = filtered_subjects(range: commit_range)
    return locales.to_h { |loc| [loc, "Internal build"] } if subjects.empty?

    begin
      llm_translate(subjects: subjects, locales: locales)
    rescue StandardError => e
      notify_warning("[release_notes] LLM call failed (#{e.class}: #{e.message}); falling back to raw subjects")
      raw = subjects.map { |s| "- #{s}" }.join("\n")[0, PER_LOCALE_LIMIT]
      locales.to_h { |loc| [loc, raw] }
    end
  end

  def commit_range
    prev = `git describe --tags --abbrev=0 --match='mobile-v*' HEAD^ 2>/dev/null`.strip
    prev.empty? ? "-30" : "#{prev}..HEAD"
  end

  def filtered_subjects(range:)
    # Force UTF-8: backtick output inherits the locale's external encoding,
    # which is US-ASCII when LANG is unset and chokes on non-ASCII commit
    # subjects (e.g. Cyrillic).
    raw = `git log #{range} --no-merges --pretty=format:%s 2>/dev/null`.force_encoding("UTF-8")
    filter_lines(raw.lines)
  end

  # Pure function — extracted for unit testing.
  def filter_lines(raw_lines)
    raw_lines.map(&:strip).reject(&:empty?).filter_map do |line|
      m = line.match(/\A(?<type>\w+)(?:\([^)]+\))?!?:\s*(?<subj>.+)\z/)
      next unless m && USER_FACING_TYPES.include?(m[:type])
      m[:subj].strip
    end
  end

  def llm_translate(subjects:, locales:)
    require "aws-sdk-bedrockruntime"

    # AWS SDK auto-reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from env.
    # CI sets these in the deploy-android / deploy-ios jobs; locally the SDK
    # falls through to ~/.aws/credentials / SSO / IAM role. If everything
    # fails, the outer rescue catches it and we fall back to raw subjects.

    client = Aws::BedrockRuntime::Client.new(region: ENV.fetch("AWS_REGION", DEFAULT_REGION))
    body = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 800,
      temperature: 0.2,
      messages: [{ role: "user", content: build_prompt(subjects: subjects, locales: locales) }],
    }.to_json

    response = client.invoke_model(
      model_id: MODEL_ID,
      content_type: "application/json",
      accept: "application/json",
      body: body,
    )
    payload = JSON.parse(response.body.read)
    text = payload.dig("content", 0, "text").to_s.strip
    # Strip ```json fences if the model wraps despite the instruction.
    text = text.sub(/\A```(?:json)?\s*/, "").sub(/```\s*\z/, "").strip
    parsed = JSON.parse(text)

    locales.to_h do |loc|
      v = parsed[loc].to_s.strip
      raise "Locale #{loc.inspect} missing in LLM response: #{text.inspect}" if v.empty?
      [loc, v[0, PER_LOCALE_LIMIT]]
    end
  end

  def build_prompt(subjects:, locales:)
    locale_lines = locales.map { |l| "- #{l}" }.join("\n")
    bullet_lines = subjects.map { |s| "- #{s}" }.join("\n")
    <<~TXT
      You write app store release notes for Shruti — a mobile app for
      listening to a curated library of recorded spiritual lectures
      (audio playback, synchronized transcripts, multi-language search,
      playlists, offline downloads).

      Below is a list of user-facing changes (already filtered to
      feat/fix/perf conventional commits) since the previous release.
      Rewrite them as friendly, concise "What's new" notes for each
      requested locale.

      Locales required:
      #{locale_lines}

      Constraints:
      - Each locale's text must stay under 400 characters.
      - Natural app-store voice — clear, brief, end-user focused.
      - No technical jargon (don't mention refactor, API, DB, file paths,
        commit types, build numbers).
      - Plain bullet list with "- " prefix per item. No headings, no emojis.
      - Do not invent features that are not in the input list.
      - For ru-RU, write in idiomatic Russian (not transliterated English).

      Changes:
      #{bullet_lines}

      Respond with ONLY a JSON object mapping each requested locale to its
      release notes string. No prose, no markdown fences. Example shape:
      {"en-US": "- ...\\n- ...", "ru-RU": "- ...\\n- ..."}
    TXT
  end

  def notify_warning(msg)
    if defined?(::FastlaneCore::UI)
      ::FastlaneCore::UI.important(msg)
    else
      warn(msg)
    end
  end
end

# ---- self-test (run: ruby fastlane/lib/release_notes.rb --self-test) -------
if __FILE__ == $PROGRAM_NAME && ARGV.include?("--self-test")
  fixture = [
    "feat(mobile:player): remember last playback position per track",
    "chore(catalog): follow-up cleanup",
    "fix(library): shorten search placeholder",
    "refactor(architecture): enforce hexagonal layer boundaries",
    "ci(release): wire release-please workflow",
    "perf(player): cache decoded audio segments",
    "docs(arch): add ADR for ports/adapters",
    "feat!: drop iOS 14 support",
    "feat(mobile:transcript)!: redesign sentence-sync gestures",
    "",
    "  ",
  ]
  out = ReleaseNotes.filter_lines(fixture)
  expected = [
    "remember last playback position per track",
    "shorten search placeholder",
    "cache decoded audio segments",
    "drop iOS 14 support",
    "redesign sentence-sync gestures",
  ]
  raise "filter mismatch:\n  got: #{out.inspect}\n  exp: #{expected.inspect}" unless out == expected

  empty = ReleaseNotes.filter_lines(["chore: x", "ci: y", "docs: z"])
  raise "expected empty, got #{empty.inspect}" unless empty.empty?

  long = ["feat: " + ("a" * 1000)]
  filtered_long = ReleaseNotes.filter_lines(long)
  raise "expected 1 long item" unless filtered_long.length == 1 && filtered_long.first.length == 1000

  puts "OK: filter_lines (#{out.length} items kept, scope/breaking-! handled, empty input → empty)"
end
