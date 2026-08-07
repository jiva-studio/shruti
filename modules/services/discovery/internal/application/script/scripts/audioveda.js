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
    series: (d.isPartOf && d.isPartOf.name) || '',
  };
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
