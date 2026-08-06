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

// transcript turns the published prose into Markdown.
//
// The timings the page carries are dropped. Only this archive publishes them,
// and a citation cut against somebody else's clock does not line up with our own
// re-encode of the audio — so keeping them would be keeping something that
// looks usable and is not.
function transcript(html) {
  var m = html.match(/<div[^>]+itemprop=["']transcript["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!m) return '';

  var body = m[1]
    .replace(/<span[^>]+class=["']timing["'][^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');

  return unescapeHTML(body)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map(function (line) { return line.trim(); })
    .join('\n')
    .trim();
}

function unescapeHTML(s) {
  var named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };
  return s
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&([a-z]+);/gi, function (whole, name) {
      var c = named[name.toLowerCase()];
      return c === undefined ? whole : c;
    });
}
