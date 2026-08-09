// YouTube channels.
//
// A plain GET returns a page holding nothing, so this source is read by yt-dlp
// and what arrives here is its JSON. Two shapes come through it: a channel,
// which lists what exists, and a single video, which carries what it is.
//
// Nothing is downloaded. The recording's address is its watch page, and that is
// the address stored: a direct audio stream expires in six hours and is bound
// to whoever asked for it, so keeping one would be keeping a dead field.

function extract(page, items) {
  var doc = parse(page.html || '');
  if (!doc) return [];

  // A channel names its videos and nothing more. Each becomes a page of its
  // own, so the schedule can revisit one video without re-reading the channel.
  if (doc._type === 'playlist' || doc.entries) return [];

  // The reader hands over every track worth keeping: what the uploader
  // published, in whatever languages they published it, and failing that the
  // one machine track it can vouch for as the original.
  var tracks = doc._captions || [];
  var texts = [];
  // Which language was spoken, and only where something says so. A published
  // track is a language somebody offered — a Russian talk with English
  // subtitles offers "en" — and the reader hands them over in alphabetical
  // order, so no position among them means anything. The machine track is
  // different: the reader picks it by the site's own mark for the original.
  var spoken = '';
  for (var i = 0; i < tracks.length; i++) {
    var words = captions(tracks[i].json3);
    if (words) texts.push({ lang: tracks[i].lang, text: words });
    if (tracks[i].origin === 'auto' && !spoken) spoken = baseLang(tracks[i].lang);
  }

  var label = (doc.title || '').trim();
  var channel = (doc.channel || doc.uploader || '').trim();
  var posted = uploadDate(doc.upload_date || '');

  // What the uploader typed, handed over whole rather than passed off as a
  // title. It is a line like "Е.М. Сарвагья прабху. ШБ 9.10.12. Уроки
  // Рама-лилы. 4.01.2025. Хампи" — a speaker, a passage, a name, a date and a
  // place written into one box, and none of it is the title on its own.
  var material = [];
  if (label) material.push({ label: 'video title', text: label });
  if (channel) material.push({ label: 'published on the channel', text: channel });
  // When the talk was posted, which is when it was given only where the name
  // says nothing else. A channel filming its own class posts it within days; a
  // channel putting an archive online posts it decades late. Which of the two
  // this is can be read off the name, so the reading is the model's.
  if (posted) material.push({ label: 'published on', text: posted });

  return items.map(function (it) {
    return {
      url: it.url,
      // Deliberately empty, along with the speaker and the passage. All three
      // live in that one line, the script has no way to take it apart, and
      // whatever it did parse out of it would be thrown away anyway: a
      // recording that goes to the model comes back replaced entire.
      title: '',
      author: '',
      authors: [],
      // Kept as well as handed over, so that a file the model passed over
      // still carries a date rather than none.
      date: posted,
      references: [],
      material: material,
      // The still, built from the id this very document is keyed by. mqdefault
      // and not one of the larger ones: it is the only size that exists for
      // every video and the only one that is not letterboxed, and a picture
      // that 404s is worse than a small one.
      cover_url: doc.id ? 'https://i.ytimg.com/vi/' + doc.id + '/mqdefault.jpg' : '',
      duration_s: doc.duration || 0,
      // The language of the words, where we have words; otherwise what the
      // site says about the recording. Never guessed from the text.
      language: spoken || baseLang(doc.language || ''),
      texts: texts,
    };
  });
}

// recordings: a video page is the recording. There is no file to point at —
// nothing is downloaded, and a direct audio stream would expire in six hours
// and be bound to whoever asked for it — so the watch address stands for both.
function recordings(page) {
  var doc = parse(page.html || '');
  if (!doc || doc.entries || !doc.id) return [];
  // The address this page was read from, which for a video is its watch page.
  // Building one out of the id worked until a page turned out not to be a
  // video at all.
  return page.url ? [page.url] : [];
}

// links are the videos a channel holds, for the crawl to visit one at a time.
function links(page) {
  var doc = parse(page.html || '');
  if (!doc || !doc.entries) return [];
  var out = [];
  for (var i = 0; i < doc.entries.length; i++) {
    var e = doc.entries[i];
    if (!e) continue;
    // The address the reader gave, not one built out of an id. A channel does
    // not always answer with its videos: some answer with their tabs, whose id
    // is the channel's own, and building a watch address out of that produced
    // three addresses to nowhere and a channel nobody ever walked. A video
    // carries url, a tab carries webpage_url, and both are already right.
    var u = e.url || e.webpage_url || '';
    if (!u || isShorts(u)) continue;
    out.push(u);
  }
  return out;
}

// isShorts drops the tab of vertical clips. They are not lectures, and a
// channel read whole offers them alongside its videos and its streams.
function isShorts(u) {
  return /\/shorts(\/|$|\?)/i.test(u);
}

// The reader's output arrives whole in page.html. page.text is the flattened
// prose extraction makes of it, which is not JSON and never was.
function parse(raw) {
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// baseLang turns "en-US" into "en", the way caption tracks are keyed.
function baseLang(s) {
  return String(s).split(/[-_]/)[0].toLowerCase();
}

// uploadDate turns YYYYMMDD into the shape the rest of the corpus uses.
function uploadDate(s) {
  var m = String(s).match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
}

// captions turns YouTube's json3 into plain prose.
//
// The timings go. They belong to somebody else's copy of the audio, and a
// citation cut against them would not line up with our own re-encode — so
// keeping them would be keeping something that looks usable and is not.
function captions(raw) {
  var doc = parse(raw);
  if (!doc || !doc.events) return '';
  var lines = [];
  for (var i = 0; i < doc.events.length; i++) {
    var segs = doc.events[i].segs;
    if (!segs) continue;
    var line = '';
    for (var j = 0; j < segs.length; j++) line += segs[j].utf8 || '';
    line = line.replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
  }
  // Auto-captions arrive as a rolling window, so the same words come round
  // again on the next event. A line repeating the one before it is that, not
  // something said twice.
  var out = [];
  for (var k = 0; k < lines.length; k++) {
    if (k === 0 || lines[k] !== lines[k - 1]) out.push(lines[k]);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}
