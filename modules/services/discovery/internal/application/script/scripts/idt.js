// audio.iskcondesiretree.com
//
// A listing states everything about a recording in the text of its own link:
//
//   Amal Bhakta Sw   CC Madhya Lila 13-148-150   -   2010-07-28   Los Angeles
//   speaker          book and verses                 date         place
//
// Nothing is left over, and nothing left over is the point. Rather than cut
// pieces out and hope a title survives, every part is accounted for and what
// remains is the title — or, when the string is used up, proof there is none.
//
// Everything the archive's vocabulary consists of is in VOCAB. Teaching it a
// word is adding a line there; nothing below needs to change.

var VOCAB = {
  // Marks a directory or a breadcrumb as naming a person.
  honorifics: [
    'His Holiness', 'His Grace', 'Her Grace',
    'Srila', 'Sriman', 'Srimati', 'Sripad', 'Dr',
    // How the archive addresses a devotee who has not taken initiation.
    'Bhakta', 'Bhaktin',
  ],

  // Forms of address.
  //
  // drop is how one addresses a person rather than how one names them; it does
  // not belong in a stored name. canon is the part of a name that stays, with
  // every spelling the archive uses for it mapped to one: "Sw" and "Maharaja"
  // are a Swami, "dd" and "Mataji" are a Devi Dasi. Written differently they
  // are the same person under two names, which is the thing being avoided.
  address: {
    drop: ['Prabhuji', 'Prabhu', 'Pr', 'HH', 'HG'],
    canon: {
      'Swami': ['Swami', 'Sw', 'Swamiji', 'Maharaja', 'Maharaj', 'Mharaj'],
      'Goswami': ['Goswami', 'Gosvami', 'Gsw'],
      'Das': ['Das', 'Dasa', 'Ds', 'Dasan'],
      'Devi Dasi': ['Devi Dasi', 'Devi dasi', 'Dasi', 'dd', 'Mataji', 'Mtj'],
      // Titles of their own, kept as written: a Babaji is not a Swami and
      // Thakura is how the acaryas are named.
      'Babaji': ['Babaji', 'Baba'],
      'Thakura': ['Thakura', 'Thakur'],
    },
  },


  // Scripture. Longest spelling first — the first match wins, so
  // "CC Madhya Lila" must be tried before "CC".
  books: [
    ['Chaitanya Charitamrita Adi Lila', 'CC_ADI'],
    ['Caitanya Caritamrta Adi Lila', 'CC_ADI'],
    ['Chaitanya Charitamrita Madhya Lila', 'CC_MADHYA'],
    ['Caitanya Caritamrta Madhya Lila', 'CC_MADHYA'],
    ['Chaitanya Charitamrita Antya Lila', 'CC_ANTYA'],
    ['Caitanya Caritamrta Antya Lila', 'CC_ANTYA'],
    ['CC Adi Lila', 'CC_ADI'],
    ['CC Madhya Lila', 'CC_MADHYA'],
    ['CC Antya Lila', 'CC_ANTYA'],
    ['CC Adi', 'CC_ADI'],
    ['CC Madhya', 'CC_MADHYA'],
    ['CC Antya', 'CC_ANTYA'],
    ['Srimad Bhagavatam', 'SB'],
    ['Bhagavad Gita', 'BG'],
    ['Nectar of Devotion', 'NOD'],
    ['Brahma Samhita', 'BS'],
    ['Isopanisad', 'ISO'],
    ['SB', 'SB'],
    ['BG', 'BG'],
    ['NOD', 'NOD'],
    ['BS', 'BS'],
    ['ISO', 'ISO'],
  ],

  // How many levels a coordinate has: SB is canto.chapter.verse, the rest are
  // chapter.verse.
  depth: { SB: 3 },

  // Words that introduce a place rather than being one. "ISKCON Chennai" is a
  // temple; "ISKCON" alone is not a location, and listing every centre the
  // movement has would never end. The marker takes the capitalised words that
  // follow it.
  // "Radha" alone is not one: it begins the name of a deity far more often
  // than a temple, and as a marker it ate the Radha out of Radharani.
  placeMarkers: ['ISKCON'],

  // Places the listing names outright.
  places: [
    'Chowpatty', 'Vrindavan', 'Vrindavana', 'Mayapur', 'Mayapura',
    'Los Angeles', 'San Diego', 'New York', 'Melbourne', 'Sydney', 'London',
    'Moscow', 'Alachua', 'Radhadesh', 'Bhaktivedanta Manor', 'Salem', 'Zurich',
    'Slovenia', 'Bangalore', 'Pune', 'Mumbai', 'Delhi', 'Karur', 'Bhimavaram',
  ],

  // Which way round a date reads when the digits alone cannot say. Measured on
  // this archive: of 3142 filenames leading with three two-digit groups, 2984
  // read as year-month-day and 158 as day-month-year. Only consulted when both
  // readings are valid dates.
  dateOrder: ['YMD', 'DMY', 'MDY'],

  // What the archive puts between two names. A word here only counts as a
  // join when a name was removed on each side of it.
  conjunctions: ['and', '&', '+', ',', 'with', 'featuring', 'ft'],

  // Words the archive uses for a section rather than a talk. They are not a
  // title on their own.
  // Languages the archive names in a directory or a filename. Only what it
  // states outright: a title full of Sanskrit words is a mantra sung inside a
  // talk given in English, and reading the language off the words gets it
  // backwards for half this corpus.
  languages: {
    en: ['English'],
    ru: ['Russian', 'Rus'],
    hi: ['Hindi'],
    bn: ['Bengali', 'Bangla'],
    ta: ['Tamil'],
    te: ['Telugu'],
    mr: ['Marathi'],
    gu: ['Gujarati'],
    kn: ['Kannada'],
    ml: ['Malayalam'],
    sa: ['Sanskrit'],
    sl: ['Slovenian'],
    es: ['Spanish'],
    pt: ['Portuguese'],
    de: ['German'],
    fr: ['French'],
    it: ['Italian'],
    hu: ['Hungarian'],
    zh: ['Chinese', 'Mandarin'],
  },

  // How this archive says there is no speaker. Written down, it is an answer
  // and not a gap: the recording has no named speaker, and a model asked about
  // it can only invent one.
  nobody: ['Unknown', 'Various Devotees', 'Various', 'Devotees', 'N/A', 'Guest'],

  // What this archive calls a category. They appear in a directory name and
  // again inside the filename, and neither is a title.
  filler: [
    // The archive stamps its own name into filenames it has processed.
    'IDesireTree', 'IDT',
    'Various', 'Lectures', 'Lecture', 'Class', 'Classes', 'Seminar', 'Seminars',
    'Festivals', 'Festival', 'Bhajans', 'Kirtan Fest', 'Part', 'Others',
    'Hindi', 'Tamil', 'Bengali', 'Russian', 'Telugu', 'Marathi', 'Gujarati',
  ],
};

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// LANGUAGE maps every word the archive uses for a language to its ISO code.
var LANGUAGE = {}, LANGUAGE_ALL = [];
(function () {
  for (var code in VOCAB.languages) {
    var names = VOCAB.languages[code];
    for (var i = 0; i < names.length; i++) {
      LANGUAGE[names[i].toLowerCase()] = code;
      LANGUAGE_ALL.push(names[i]);
    }
  }
})();

// CANON maps every spelling of a kept form of address to the one we store.
var CANON = {}, CANON_ALL = [];
(function () {
  for (var full in VOCAB.address.canon) {
    var variants = VOCAB.address.canon[full];
    for (var i = 0; i < variants.length; i++) {
      CANON[variants[i].toLowerCase()] = full;
      CANON_ALL.push(variants[i]);
    }
  }
})();

// anyOf builds one alternation from a vocabulary list, longest first so that a
// longer phrase is never eaten piecemeal by a shorter one inside it.
function anyOf(words) {
  var sorted = words.slice().sort(function (a, b) { return b.length - a.length; });
  return sorted.map(function (w) { return esc(w).replace(/\s+/g, '[\\s_-]+'); }).join('|');
}

var RE = {
  honorific: new RegExp('^(' + anyOf(VOCAB.honorifics) + ')[\\s_]+', 'i'),
  address: new RegExp('\\b(' + anyOf(VOCAB.address.drop.concat(CANON_ALL)) + ')\\b\\.?', 'i'),
  // Trailing form of address on a name: dropped outright, or rewritten to the
  // one spelling we keep.
  dropTail: new RegExp('[\\s_,.]+(' + anyOf(VOCAB.address.drop) + ')\\b\\.?\\s*$', 'i'),
  canonTail: new RegExp('[\\s_,.]+(' + anyOf(CANON_ALL) + ')\\b\\.?\\s*$', 'i'),
  place: new RegExp('\\b(' + anyOf(VOCAB.places) + ')\\b', 'i'),
  // A marker plus the capitalised words it introduces: "ISKCON New Govardhana".
  markedPlace: new RegExp('\\b(' + anyOf(VOCAB.placeMarkers) +
    ')((?:[\\s_]+[A-Z][A-Za-z.]*){0,3})', ''),
  filler: new RegExp('\\b(' + anyOf(VOCAB.filler) + ')\\b', 'ig'),
  nobody: new RegExp('\\b(' + anyOf(VOCAB.nobody) + ')\\b', 'i'),
  language: new RegExp('\\b(' + anyOf(LANGUAGE_ALL) + ')\\b', 'i'),
  numbers: /(\d{1,3}(?:[-.]\d{1,3})+|\b\d{1,3}\b)/,
};

// GAP stands where something was taken out, so a hole left by a removal can be
// told from an ordinary dash. Without the distinction "Que and Ans - Brahmacari
// and Mind" looks as broken as a title with an unread city sitting in it.
//
// A middle dot rather than a control character: it survives a log, a grep and a
// terminal, and on the day one leaks into a title it reads as a separator
// instead of corrupting the file it sits in.
var GAP = '\u00b7';

// eat removes the first match and reports what was taken, so a caller can tell
// "absent" from "found and consumed".
function eat(state, re) {
  var m = state.s.match(re);
  if (!m) return null;
  state.s = state.s.slice(0, m.index) + GAP + state.s.slice(m.index + m[0].length);
  return m;
}

function eatAll(state, re) {
  while (eat(state, re)) { /* until none left */ }
}

// linkText maps each media address to the words the page printed for it. The
// listing writes them spaced and readable where the filename runs them
// together, so this is the better of the two.
function linkText(html) {
  var by = {}, re = /<a[^>]+href\s*=\s*"?([^"\s>]+\.(?:mp3|MP3|m4a|wav|ogg))"?[^>]*>([\s\S]*?)<\/a>/g, m;
  while ((m = re.exec(html)) !== null) {
    var text = m[2].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    if (text) by[decodeURIComponent(m[1])] = text;
  }
  return by;
}

// namesAPerson tells a speaker's directory from a seminar that happens to open
// with an honorific. "His Holiness Amal Bhakta Swami" ends in a form of
// address; "Srila Prabhupada-Living Bhagavatam" is the name of a course, and
// its dash is the giveaway.
function namesAPerson(seg) {
  seg = seg.replace(/^\d+\s*-\s*/, '');
  if (!RE.honorific.test(seg)) return false;
  var rest = seg.replace(RE.honorific, '').trim();
  if (RE.canonTail.test(rest) || RE.dropTail.test(rest)) return true;
  return rest.indexOf('-') < 0 && rest.split(/\s+/).length <= 3;
}

// speakerFrom reads the breadcrumb, which spells a name in full where the
// listing abbreviates it, and falls back to the directory that names a person.
function speakerFrom(html, path) {
  var re = /<a[^>]+href\s*=\s*"?index\.php\?q=f[^">]*"?[^>]*>([^<]+)<\/a>/g, m, found = '';
  while ((m = re.exec(html)) !== null) {
    var t = m[1].replace(/\s+/g, ' ').trim();
    if (namesAPerson(t)) found = t.replace(RE.honorific, '');
  }
  if (found) return name(stripHonorifics(found));
  for (var i = 0; i < path.length; i++) {
    var seg = path[i].replace(/_/g, ' ').replace(/^\d+\s*-\s*/, '').trim();
    if (namesAPerson(seg)) return name(stripHonorifics(seg));
  }
  return '';
}

// stripHonorifics takes them all off, not one: "His Grace Bhakta Shivahari"
// carries two, and removing the first leaves the second to pass for a name.
function stripHonorifics(s) {
  for (;;) {
    var next = s.replace(RE.honorific, '').trim();
    if (next === s) return s;
    s = next;
  }
}

// name is what we store: the person, without the words used to address them,
// and with the words that stay written one way.
function name(s) {
  s = s.replace(RE.dropTail, '').trim();
  var m = s.match(RE.canonTail);
  if (m) s = s.slice(0, s.length - m[0].length).trim() + ' ' + CANON[m[1].toLowerCase()];
  return s.trim();
}

function placeFrom(path) {
  if (!path.length) return '';
  var top = path[0].replace(/_/g, ' ').replace(/^\d+\s*-\s*/, '').trim();
  return RE.place.test(top) ? top : '';
}

// eatDate reads whatever date the string carries.
//
// Four digits name a year wherever they sit, which settles the rest. Three
// two-digit groups do not settle anything on their own: 06-01-05 is a valid
// date read three ways. Where a group is over 12 it cannot be a month and where
// it is over 31 it cannot be a day, and often that alone decides; where it does
// not, the archive's measured habit does.
//
// Digits that are no date under any reading are the one thing here we could see
// and not read, and that is what a model is for.
function eatDate(state, out) {
  var date = readDate(state, out);
  // Whatever years are left are the archive numbering its own shelf: "1989 011
  // An Empty Husk" carries the year once as a catalogue mark and once as the
  // date, and a year has never been the first word of a title.
  eatAll(state, /\b(19|20)\d{2}\b/);
  return date;
}

function readDate(state, out) {
  // A four-digit year settles which end is which, and the order after it is
  // conventional rather than a coin-flip: year-month-day unless that is not a
  // date at all.
  var m = eat(state, /\b(\d{4})[-._](\d{1,2})[-._](\d{1,2})\b/);
  if (m) return resolve(out, [m[1], m[2], m[3]], ['YMD', 'YDM'], true);

  m = eat(state, /\b(\d{1,2})[-._](\d{1,2})[-._](\d{4})\b/);
  if (m) return resolve(out, [m[1], m[2], m[3]], ['DMY', 'MDY'], true);

  // Three two-digit groups settle nothing. Here the alternatives are real, and
  // dateOrder is the archive's measured habit.
  m = eat(state, /\b(\d{2})[-._](\d{2})[-._](\d{2})\b/);
  if (m) return resolve(out, [m[1], m[2], m[3]], VOCAB.dateOrder, false);

  // A year and a month with no day. The corpus reads a month on its own as its
  // first, the same way it reads a bare year as the first of January.
  m = eat(state, /\b(19|20)(\d{2})[-._](\d{1,2})\b/);
  if (m) {
    var mo = parseInt(m[3], 10);
    if (mo >= 1 && mo <= 12) return pad(m[1] + m[2], mo, 1);
  }

  m = eat(state, /\b(19|20)(\d{2})\b/);
  return m ? m[1] + m[2] + '-01-01' : '';
}

// resolve tries each reading in order and takes the first that is a real date.
// The order of the candidates is the archive's measured habit, so the first
// survivor is the answer rather than a coin-flip to be deferred.
function resolve(out, groups, orders, conventional) {
  var valid = [];
  for (var i = 0; i < orders.length; i++) {
    var d = asDate(groups, orders[i]);
    if (d) valid.push(d);
  }
  if (!valid.length) {
    out.unresolved = true;
    return '';
  }
  return valid[0];
}

// asDate arranges three numbers according to a reading and says whether the
// result is a date that could exist.
function asDate(groups, order) {
  var y, mo, d;
  for (var i = 0; i < 3; i++) {
    var n = parseInt(groups[i], 10);
    if (order.charAt(i) === 'Y') y = groups[i].length === 4 ? n : (n >= 70 ? 1900 + n : 2000 + n);
    if (order.charAt(i) === 'M') mo = n;
    if (order.charAt(i) === 'D') d = n;
  }
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return '';
  if (!(y >= 1900 && y <= 2100)) return '';
  if (d > daysIn(y, mo)) return '';
  return pad(String(y), mo, d);
}

function daysIn(y, mo) {
  var days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mo === 2 && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) return 29;
  return days[mo - 1];
}

function pad(y, mo, d) {
  return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
}

// eatRefs takes a book and the numbers beside it. Dashes separate the levels of
// a coordinate here — "13-148-150" is chapter 13, verses 148 to 150 — so the
// groups past the book's depth are a range.
function eatRefs(state) {
  for (var i = 0; i < VOCAB.books.length; i++) {
    var pattern = new RegExp('\\b' + esc(VOCAB.books[i][0]).replace(/\s+/g, '[\\s_-]+') + '\\b', 'i');
    var at = state.s.match(pattern);
    if (!at) continue;

    // Only the numbers touching the book are its coordinate. Taken from
    // anywhere in the string, "2015-02-18_SB_08-22-20" hands the reference the
    // date and leaves the recording undated.
    var after = state.s.slice(at.index + at[0].length);
    // The levels of a coordinate are separated by a dash, a dot or a plain
    // space: this archive writes "15-103" and "15 103" for the same verse.
    var nums = after.match(/^[\s_.:-]*(\d{1,3}(?:[-. ]\d{1,3})+|\d{1,3})\b/);

    // A book named with no coordinate beside it is being talked about, not
    // cited: "Glories of Srimad Bhagavatam" is a title.
    if (!nums) continue;

    state.s = state.s.slice(0, at.index) + GAP +
              after.slice(nums[0].length);

    var code = VOCAB.books[i][1];
    var parts = nums[1].split(/[-. ]/).map(function (x) { return String(parseInt(x, 10)); });
    var depth = VOCAB.depth[code] || 2;
    if (parts.length <= depth) return [code + ' ' + parts.join('.')];
    var head = parts.slice(0, depth - 1).join('.');
    var range = parts.slice(depth - 1);
    return [code + ' ' + head + '.' + range[0] + '-' + range[range.length - 1]];
  }
  return [];
}

// eatSpeaker removes the name however the listing wrote it: in full, in
// separate words, or squeezed into one token — "BRS", "BRasamritaSw",
// "BCaitanyaS". A token whose letters run through the name in order is that
// name contracted.
// eatSpeaker removes the name however the listing wrote it: in full, in
// separate words, or squeezed into one token.
function eatSpeaker(state, speaker) {
  if (!speaker) return;
  // The name comes out whole, where it stands. Taken word by word across the
  // line it takes the same words out of the title: a speaker called Gopal or
  // Nitai or Krishna shares them with half the talks in the archive, and
  // "The Deer like life of Conditioned Soul" came back as "The Deer like life
  // of" once Soul had gone with somebody's name.
  var whole = speaker.split(/\s+/).map(esc).join('[\\s_-]+');
  eatAll(state, new RegExp('\\b' + whole + '\\b', 'i'));

  // Only a form of address left standing next to the name we just removed is
  // ours. Taken wherever it appears, "Madhudvisa Prabhu's Memorial Festival"
  // loses a word out of the middle of somebody else's name.
  var forms = anyOf(VOCAB.address.drop.concat(CANON_ALL));
  eatAll(state, new RegExp(GAP + '[\\s_.,]*(' + forms + ')\\b\\.?', 'i'));
  eatAll(state, new RegExp('\\b(' + forms + ')\\b\\.?[\\s_.,]*' + GAP, 'i'));
}

// leftover is what none of the parts claimed, and how many separate runs it
// came in.
//
// One run is a title with everything around it accounted for. Two or more mean
// something stood between them that was removed without being recognised — an
// unknown place name, a word this archive uses that we have never seen. That is
// the only signal the script has that it failed: without it, every unclaimed
// token quietly becomes part of a title and nothing ever looks wrong.
function leftover(state) {
  // A section word standing at the edge of what is left, or beside a hole where
  // something was removed, belongs to the archive's filing. Between two words
  // of a phrase it belongs to the phrase: taking "Lecture" out of "kirtan and
  // Lecture" leaves "kirtan and", which is not the name of anything.
  var edge = '(^|' + GAP + '|[\\s\\-–_.,:;()\\[\\]])';
  var forms = anyOf(VOCAB.filler);
  var cleaned = state.s;
  for (;;) {
    var next = cleaned
      .replace(new RegExp('^[\\s\\-–_.,]*(' + forms + ')\\b', 'i'), GAP)
      .replace(new RegExp('\\b(' + forms + ')[\\s\\-–_.,]*$', 'i'), GAP)
      .replace(new RegExp(GAP + '[\\s\\-–_.,]*(' + forms + ')\\b', 'ig'), GAP)
      .replace(new RegExp('\\b(' + forms + ')[\\s\\-–_.,]*' + GAP, 'ig'), GAP);
    if (next === cleaned) break;
    cleaned = next;
  }
  cleaned = cleaned.replace(/[\s\-–_.,:;()\[\]]+/g, ' ');

  var runs = [];
  var parts = cleaned.split(GAP);
  for (var i = 0; i < parts.length; i++) {
    var run = parts[i].trim();
    if (run) runs.push(run);
  }
  // A run of nothing but digits is the archive counting — "Day-01" losing its
  // "Day" to the page stamp — and counting is not a word we failed to read.
  // Dropping it from the text without dropping it from the count left the line
  // looking unaccounted for, and a page of numbered kirtans went to a model
  // over a number.
  var named = [];
  for (var j = 0; j < runs.length; j++) {
    // A zero-padded number is an index, never a quantity anybody says out loud:
    // "011 An Empty Husk" is the archive's shelf mark, while "9 Best Bhakti
    // Practices" is what the talk is called.
    var run = runs[j].replace(/^0\d*[\s.-]+/, '').trim();
    if (run && !/^[\d\s.,:;()-]+$/.test(run)) named.push(run);
  }
  var text = named.join(' ');
  // A name does not end on "and" or begin on "of". Where it does, something
  // that belonged to it was taken out with something else, and guessing which
  // word is worse than saying so.
  var dangling = new RegExp('(^\\s*(' + anyOf(VOCAB.conjunctions) +
    '|of|the|in|for|to)\\b|\\b(' + anyOf(VOCAB.conjunctions) +
    '|of|the|in|for|to)\\s*$)', 'i');
  return { text: text, runs: named.length, cut: text !== '' && dangling.test(text) };
}

function speakersInText(state) {
  var forms = anyOf(VOCAB.address.drop.concat(CANON_ALL));
  // Up to five words: "Bhakti Vigna Vinasa Narsimha Sw" is one person, and
  // stopping at three leaves "Bhakti" behind to pass for a title. A dash or a
  // date breaks the run, so a title's last words are not swept in with it.
  var re = new RegExp('((?:\\b[A-Z][A-Za-z]*[\\s_]+){1,5})(' + forms + ')\\b\\.?', 'g');
  var found = [], m;
  while ((m = re.exec(state.s)) !== null) {
    var whole = m[0].replace(/[\s_]+/g, ' ').trim();
    var name = m[1].replace(/[\s_]+/g, ' ').trim();
    // "Hare Krishna Kirtan - Govinda Pr": only the words touching the form of
    // address belong to it, and a leading word of the title must not be eaten
    // with them.
    if (name && !RE.filler.test(name)) found.push({ whole: whole, name: whole });
  }
  for (var i = 0; i < found.length; i++) {
    eat(state, new RegExp('\\b' + esc(found[i].whole) + '\\b'));
  }
  // "Amala Harinam Pr and Kirtan Premi Pr" leaves "and" standing between the
  // two holes where the names were. Between two removals it joined them; it is
  // not a word we failed to read, and counting it as one sends a perfectly
  // understood line to the model.
  eatAll(state, new RegExp(GAP + '[\\s_]*(' + anyOf(VOCAB.conjunctions) + ')[\\s_]*' + GAP, 'i'));
  return found.map(function (f) { return f.name; });
}

// sections are the words the breadcrumb uses for where we are — "Bhajans",
// "Bhagavad Gita", "Festivals". The listing repeats them in every line, and
// repeating the folder you are standing in is not a title.
//
// Read from the page rather than listed in advance: the archive states its own
// sections, and no list written here would keep up with them.
function sectionsFrom(path, speaker) {
  var out = [];
  for (var i = 0; i < path.length; i++) {
    var seg = path[i].replace(/_/g, ' ').replace(/^\d+\s*-\s*/, '').trim();
    if (!seg || RE.honorific.test(seg)) continue;
    if (speaker && seg.indexOf(speaker) >= 0) continue;
    if (seg.length > 2) out.push(seg);
  }
  return out;
}

// boilerplate is the words every line on this page repeats.
//
// An archive stamps each filename with the same marks — a speaker squeezed to
// "SP", a series code, a section — and none of them belongs to any one talk. A
// word in every line cannot be a title, and a word in one line might be.
//
// This is counted from the page rather than guessed at. Deciding by the shape
// of a token instead — does "SNP" look like somebody's initials? — has no
// right answer: an archive abbreviates however it likes, and a rule loose
// enough to catch "SNP" also eats "DC" out of Washington DC.
function boilerplate(strings) {
  if (strings.length < 3) return [];
  var count = {}, i, j;
  for (i = 0; i < strings.length; i++) {
    var seen = {};
    var words = strings[i].match(/[A-Za-z][A-Za-z.]*/g) || [];
    for (j = 0; j < words.length; j++) {
      var w = words[j].toLowerCase();
      if (seen[w]) continue;
      seen[w] = true;
      count[w] = (count[w] || 0) + 1;
    }
  }
  var out = [];
  for (var w2 in count) {
    if (count[w2] === strings.length) out.push(w2);
  }
  return out;
}

// reasons names everything that stopped the script on one line. They add up:
// a line can lack a speaker and carry an unreadable date and leave words
// unaccounted for at once, and a fix for one of them will not move it.
function reasons(noSpeaker, badDate, leftWords) {
  var out = [];
  if (noSpeaker) out.push('no-speaker');
  if (badDate) out.push('unreadable-date');
  if (leftWords) out.push('unaccounted-words');
  return out;
}

function extract(page, items) {
  var texts = linkText(page.html || '');
  var speaker = speakerFrom(page.html || '', page.path || []);
  var place = placeFrom(page.path || []);
  var sections = sectionsFrom(page.path || [], speaker);

  // A language the archive named in the path applies to every recording under
  // it: "Tamil_Lectures", "02_-_Bengali".
  var pathLang = '';
  for (var pi = 0; pi < (page.path || []).length; pi++) {
    var hit = page.path[pi].replace(/_/g, ' ').match(RE.language);
    if (hit) pathLang = LANGUAGE[hit[1].toLowerCase()];
  }

  var raws = items.map(function (it) {
    return texts[decodeURIComponent(it.url)] || texts[it.url] ||
           it.filename.replace(/\.[A-Za-z0-9]+$/, '').replace(/_/g, ' ');
  });
  var stamped = boilerplate(raws);

  return items.map(function (it) {
    var state = { s: ' ' + raws[items.indexOf(it)] + ' ' };
    var flags = { unresolved: false };

    // References first: a book name anchors the numbers beside it, so the
    // coordinate is taken before anything can mistake it for a date. "SB
    // 03-31-22" reads as a perfectly good March the 31st otherwise.
    // Who spoke, read before anything is taken out. On a page that is one
    // speaker's own archive their name is in every line, which makes it the
    // page's stamp — and removing it as a stamp left nobody to find, so the
    // whole page went to a model for a name that was written on every line of
    // it.
    var spoken = speaker ? [] : speakersInText(state);

    var refs = eatRefs(state);
    var date = eatDate(state, flags);
    eatSpeaker(state, speaker);

    for (var b = 0; b < stamped.length; b++) {
      eatAll(state, new RegExp('\\b' + esc(stamped[b]) + '\\b', 'i'));
    }
    for (var k = 0; k < sections.length; k++) {
      eatAll(state, new RegExp('\\b' + esc(sections[k]).replace(/\s+/g, '[\\s_-]+') + '\\b', 'i'));
    }

    // Where the directory names nobody, the listing usually does — unless it
    // says outright that nobody is named. Read from the line as it arrived: a
    // page whose every recording says "Unknown" makes the word its own stamp,
    // and by now it has already been taken out.
    var stated = RE.nobody.test(raws[items.indexOf(it)]);
    eat(state, RE.nobody);

    var spoken_in = eat(state, RE.language);
    var lang = spoken_in ? LANGUAGE[spoken_in[1].toLowerCase()] : pathLang;

    // A marked place is taken whole, so the centre's name goes to the location
    // rather than being left behind to pass for a title.
    var named = place;
    var marked = eat(state, RE.markedPlace);
    if (marked) {
      var whole = marked[0].replace(/[\s_]+/g, ' ').trim();
      if (!named) named = whole;
    }
    var hit = eat(state, RE.place);
    if (hit && !named) named = hit[1];
    eatAll(state, RE.place);
    eatAll(state, RE.markedPlace);

    var rest = leftover(state);
    return {
      url: it.url,
      author: speaker || spoken[0] || '',
      authors: spoken,
      location: named,
      date: date,
      references: refs,
      language: lang,
      // Complete means the string was understood, not that every field was
      // filled. A recording with no date in its name has no date, and asking a
      // model for one buys a guess. What does send it to the model is text we
      // saw and could not read: a date whose digits read more than one way.
      complete: (speaker !== '' || spoken.length > 0 || stated) &&
                !flags.unresolved && rest.runs <= 1 && !rest.cut,
      reasons: reasons(speaker === '' && spoken.length === 0 && !stated,
                       flags.unresolved, rest.runs > 1 || rest.cut),
      why: speaker === '' && spoken.length === 0 && !stated ? 'no-speaker'
         : flags.unresolved ? 'unreadable-date'
         : rest.runs > 1 ? 'unaccounted-words'
         : '',
      // Whatever the parts did not claim is the title, however short. A single
      // word is a real title here — "Overview", "Mind" — and a leftover that
      // reads as rubbish is a gap in VOCAB, not something to hide behind a
      // length test.
      title: (typeof TRACE === 'undefined' ? rest.text : state.s),
    };
  });
}
