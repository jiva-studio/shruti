// audioveda.ru
//
// This archive states what it holds, in schema.org: a JSON-LD block names the
// talk, its speaker, its date, its length and the series it belongs to, and the
// transcript is marked up with itemprop="transcript". Nothing has to be read out
// of a filename, so there is nothing here to guess at and no vocabulary to keep.
//
// The mp3 address only appears to a signed-in reader; the metadata and the
// transcript are public.

function extract(page, items) {
  var meta = jsonLD(page.html || '');
  var text = transcript(page.html || '');

  return items.map(function (it) {
    return {
      url: it.url,
      title: meta.name || '',
      author: meta.author || '',
      authors: meta.author ? [meta.author] : [],
      date: (meta.datePublished || '').slice(0, 10),
      duration_s: seconds(meta.duration),
      language: pageLanguage(page.html || ''),
      collection_title: meta.series || '',
      page_text: text,
      // The site said all of it outright. What it did not say, it does not have.
      complete: (meta.name || '') !== '' && (meta.author || '') !== '',
      reasons: (meta.name && meta.author) ? [] : ['no-speaker'],
    };
  });
}

// jsonLD reads the block the site publishes about this recording.
function jsonLD(html) {
  var m = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return {};
  var d;
  try { d = JSON.parse(m[1]); } catch (e) { return {}; }
  return {
    name: d.name || '',
    author: (d.author && d.author.name) || '',
    datePublished: d.datePublished || '',
    duration: d.duration || '',
    series: (d.isPartOf && d.isPartOf.name) || '',
  };
}

// seconds reads how long the recording runs out of the ISO 8601 duration the
// archive publishes — "PT1H10M45S".
//
// Worth taking because it is free. Every other source here would cost a request
// per recording to learn this: the length of an mp3 is not in any header, only
// in the file, so it has to be computed from the bitrate in its first frame.
// This archive simply says it.
//
// Anything unreadable is nothing rather than a guess: a duration of zero means
// "not stated", and a wrong one would be believed.
function seconds(iso) {
  if (!iso) return 0;
  var m = /^P(?:([0-9]+)D)?T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9.]+)S)?$/.exec(iso);
  if (!m) return 0;
  var total = (parseInt(m[1] || 0, 10) * 86400) + (parseInt(m[2] || 0, 10) * 3600) +
    (parseInt(m[3] || 0, 10) * 60) + Math.round(parseFloat(m[4] || 0));
  // A talk that claims to run for a week is the archive being wrong about
  // itself, and believing it would put it at the top of every "longest" list.
  return total > 0 && total < 24 * 3600 ? total : 0;
}

// The transcript is read out of the page by the host, not by a regular
// expression here. Everything this file knows is which element holds the prose
// and which parts of it are not prose.
//
// Two things inside the block are not the lecture. The timings are the
// archive's own clock and do not line up with our re-encode of the audio, so a
// citation cut against them would be wrong in a way nobody could see. The staff
// block is who transcribed it and where they live — a credit worth having on
// the site and not part of what was said.
function transcript(html) {
  return markdown(html, { select: 'itemprop=transcript', drop: ['.timing', '.staff'] });
}
