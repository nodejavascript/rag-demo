/**
 * The details a note carries besides its words — places, people, amounts, pictures.
 *
 * Everything here is **found by code**. A model may not count and may not invent,
 * so the only honest way to tell a reader *where* a document talks about, and *how
 * often*, is to look for it and count it. The model's job is to write the answer;
 * this file's job is to say what is actually on the page.
 *
 * The design is deliberately conservative. A false place is worse than a missed
 * one, because a missed one costs nothing and a false one puts a wrong fact in
 * front of someone checking an answer. So:
 *  - a name must be **capitalised in the text as written** — `reading` the verb is
 *    never Reading the town;
 *  - a single capitalised word is **not** a place on its own, it needs a
 *    preposition (`in Hamilton`, `to Hamilton`) or a gazetteer hit;
 *  - a person needs a **full name** — two capitalised words — or an honorific.
 */

import type { ImageRef, Mention } from './types.js';

const COUNTRIES = [
  'Afghanistan','Albania','Algeria','Argentina','Armenia','Australia','Austria','Azerbaijan','Bahamas','Bahrain',
  'Bangladesh','Barbados','Belarus','Belgium','Belize','Benin','Bhutan','Bolivia','Bosnia','Botswana','Brazil',
  'Brunei','Bulgaria','Burkina Faso','Burundi','Cambodia','Cameroon','Canada','Chad','Chile','China','Colombia',
  'Congo','Costa Rica','Croatia','Cuba','Cyprus','Czechia','Czech Republic','Denmark','Dominican Republic',
  'Ecuador','Egypt','El Salvador','England','Eritrea','Estonia','Ethiopia','Fiji','Finland','France','Gabon',
  'Gambia','Georgia','Germany','Ghana','Greece','Guatemala','Guinea','Guyana','Haiti','Honduras','Hungary',
  'Iceland','India','Indonesia','Iran','Iraq','Ireland','Israel','Italy','Jamaica','Japan','Jordan','Kazakhstan',
  'Kenya','Kuwait','Kyrgyzstan','Laos','Latvia','Lebanon','Lesotho','Liberia','Libya','Liechtenstein','Lithuania',
  'Luxembourg','Madagascar','Malawi','Malaysia','Maldives','Mali','Malta','Mauritania','Mauritius','Mexico',
  'Moldova','Monaco','Mongolia','Montenegro','Morocco','Mozambique','Myanmar','Namibia','Nepal','Netherlands',
  'New Zealand','Nicaragua','Niger','Nigeria','North Korea','North Macedonia','Norway','Oman','Pakistan','Panama',
  'Papua New Guinea','Paraguay','Peru','Philippines','Poland','Portugal','Qatar','Romania','Russia','Rwanda',
  'Saudi Arabia','Scotland','Senegal','Serbia','Seychelles','Sierra Leone','Singapore','Slovakia','Slovenia',
  'Somalia','South Africa','South Korea','South Sudan','Spain','Sri Lanka','Sudan','Suriname','Sweden',
  'Switzerland','Syria','Taiwan','Tajikistan','Tanzania','Thailand','Togo','Tunisia','Turkey','Turkmenistan',
  'Uganda','Ukraine','United Arab Emirates','United Kingdom','United States','Uruguay','Uzbekistan','Vanuatu',
  'Venezuela','Vietnam','Wales','Yemen','Zambia','Zimbabwe',
];

const REGIONS = [
  'Alabama','Alaska','Alberta','Arizona','Arkansas','British Columbia','California','Colorado','Connecticut',
  'Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana',
  'Maine','Manitoba','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana',
  'Nebraska','Nevada','New Brunswick','New Hampshire','New Jersey','New Mexico','New York','Newfoundland',
  'North Carolina','North Dakota','Northwest Territories','Nova Scotia','Nunavut','Ohio','Oklahoma','Ontario',
  'Oregon','Pennsylvania','Prince Edward Island','Quebec','Rhode Island','Saskatchewan','South Carolina',
  'South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin',
  'Wyoming','Yukon',
];

const CITIES = [
  'Hamilton','Toronto','Ottawa','Montreal','Vancouver','Calgary','Edmonton','Winnipeg','Halifax','Victoria',
  'Saskatoon','Regina','St. John\u2019s','Quebec City','London','Windsor','Kitchener','Waterloo','Cambridge',
  'Guelph','Brantford','Burlington','Oakville','Mississauga','Brampton','Markham','Oshawa','Kingston','Barrie',
  'St. Catharines','Niagara Falls','Sudbury','Thunder Bay','Fredericton','Moncton','Charlottetown','Whitehorse',
  'Yellowknife','Iqaluit','Ancaster','Dundas','Stoney Creek','Grimsby','Milton','Milton','Freelton','Hagersville',
  'Port Dover','Simcoe','Paris','Dunnville','Caledonia','New York','Los Angeles','Chicago','Houston','Phoenix',
  'Philadelphia','San Antonio','San Diego','Dallas','San Jose','Austin','Jacksonville','Columbus','Charlotte',
  'Indianapolis','Seattle','Denver','Boston','Nashville','Detroit','Portland','Las Vegas','Memphis','Atlanta',
  'Miami','Minneapolis','New Orleans','Cleveland','Pittsburgh','Buffalo','Rochester','Syracuse','London','Paris',
  'Berlin','Munich','Hamburg','Frankfurt','Vienna','Zurich','Geneva','Amsterdam','Rotterdam','Brussels','Madrid',
  'Barcelona','Lisbon','Rome','Milan','Naples','Venice','Athens','Istanbul','Moscow','Kyiv','Warsaw','Prague',
  'Budapest','Bucharest','Stockholm','Oslo','Copenhagen','Helsinki','Dublin','Edinburgh','Glasgow','Manchester',
  'Birmingham','Liverpool','Bristol','Leeds','Belfast','Cardiff','Dubai','Doha','Riyadh','Tel Aviv','Jerusalem',
  'Cairo','Nairobi','Lagos','Accra','Cape Town','Johannesburg','Casablanca','Mumbai','Delhi','Bangalore','Chennai',
  'Kolkata','Karachi','Lahore','Dhaka','Bangkok','Singapore','Jakarta','Manila','Hanoi','Ho Chi Minh City',
  'Kuala Lumpur','Hong Kong','Shanghai','Beijing','Shenzhen','Seoul','Tokyo','Osaka','Kyoto','Taipei','Sydney',
  'Melbourne','Brisbane','Perth','Auckland','Wellington','Rio de Janeiro','S\u00e3o Paulo','Buenos Aires',
  'Santiago','Lima','Bogot\u00e1','Mexico City','Guadalajara','Havana','Kingston','Nassau','Portland',
];

const GAZETTEER = new Set([...COUNTRIES, ...REGIONS, ...CITIES].map((name) => name.toLowerCase()));

/**
 * Words that disqualify a capitalised phrase from being a person.
 *
 * A capitalised pair is the shape of a name — and also of a job title, an
 * institution, a technology and a street. This list is what separates them, and it
 * earns its place from a real run: a resume produced *Software Engineer*, *Computer
 * Science* and *First Canadian Title* as people, and *TypeScript* and *Node.js* as
 * places, which is exactly the kind of confident nonsense this tool must not do.
 * Being on this list is not a claim about the word, only about what its presence
 * alongside another capital means.
 */
const NOT_NAME_WORDS = new Set([
  // roles and titles
  'engineer','engineers','developer','developers','manager','director','officer','president','consultant',
  'architect','analyst','designer','administrator','specialist','coordinator','supervisor','assistant',
  'technician','accountant','lawyer','paralegal','teacher','nurse','doctor','professor','student',
  // institutions and places of work or study
  'university','college','school','institute','academy','hospital','clinic','bank','company','corporation',
  'inc','ltd','llc','corp','group','holdings','partners','associates','department','division','team','unit',
  'bachelor','master','masters','honours','honors','diploma','certificate','degree','science','sciences',
  'arts','engineering','technology','technologies','studies',
  // street and place types
  'street','road','avenue','drive','lane','boulevard','crescent','court','place','way','highway','trail',
  'park','square','bridge','centre','center','plaza','mall','station','airport','hospital',
  // technologies, because a resume is full of them
  'typescript','javascript','node','nodejs','react','next','graphql','postgresql','postgres','mongodb','mysql',
  'python','java','kotlin','golang','rust','docker','kubernetes','linux','windows','macos','html','css','sql',
  'aws','azure','gcp','redis','kafka','terraform','django','rails','laravel','spring','dotnet','swift',
  'github','gitlab','jira','figma','wordpress',
  // 🔴 ORGANISATION AND PRODUCT WORDS.
  //
  // This half of the list is here because of a second real failure on the same resume
  // that produced *University of Windsor*. With the sections finally splitting, the
  // "people" list filled up with **44** entries and almost none of them were people:
  // `Model Context Protocol`, `Google Workspace`, `RESTful API`, `Material UI`,
  // `Apache Tika`, `British Columbia`, `North America`. Those are a technology, a
  // product, a place and a continent.
  //
  // The rule that resolves it: **this list is for people.** Anything that reads as an
  // organisation, a product or a technology is rejected outright, because a company
  // keeps its own place and a place keeps its own. Being generous here costs a
  // person's name only when it is also spelled like a company, which is rare; being
  // mean costs nothing but a shorter list.
  'protocol','api','apis','sdk','cli','ui','ux','client','server','service','services','suite',
  'cloud','platform','platforms','systems','system','solutions','solution','technologies',
  'technology','digital','labs','lab','global','media','networks','network','data','analytics',
  'maps','workspace','studio','studios','agency','consulting','ventures','capital','foundation',
  'america','europe','asia','africa','kingdom','states','republic','north','south','east','west',
  'central','national','international','federal','ontario','quebec','alberta','columbia','canada',
  // role words, because a bullet that starts a line is a job, not a person
  'senior','junior','lead','staff','principal','chief','head','full','front','back','end','stack',
  'level','grade','tier','model','context','design','analysis','management','operations','quality',
  'service','customer','project','programme','program','product','business','software','hardware',
  // The long tail, measured rather than imagined. After the rules above, this resume
  // still reported ten things as people; every one of them is on this list. It is
  // deliberately a plain list of words that are not names — a closed vocabulary is the
  // honest way to do this without a model, and the cost of a word being here is only
  // that somebody must share a name with it.
  'compose','databases','database','languages','language','centers','center','centre','ai','ml','jwt','git',
  'tika','apache','agentic','agent','agents','workflows','workflow','orchestration','telemetry','reporting',
  'warehousing','normalization','migrations','seeding','caching','monitoring','logging','alerting','hardening',
  'reverse','proxy','architecture','pipelines','pipeline','webhooks','websockets','socketio','present','fort',
  'vs','code','visual','studio','docker','cordova','ionic','expo','meteor','hapi','joi','redux','storybook',
  'bootstrap','material','ant','angular','asp','php','coldfusion','vue','svelte','express','mongo','postgres',
  'sqlite','qdrant','meilisearch','opentelemetry','prometheus','grafana','loki','rabbitmq','mqtt','nginx',
  'traefik','caddy','cloudflare','stripe','paypal','cloudinary','digitalocean','vercel','netlify','supabase',
  'laser','eye','fitness','health','ventures','holdings','vision','visions','remote','hybrid','onsite',
  // verbs that open a bullet, which the punctuation rule cannot catch when the bullet is
  // written as a bare word rather than a dash
  'used','implemented','queried','created','built','worked','led','managed','developed','designed','wrote',
  'delivered','gathered','accelerated','maintained','authored','directed','shipping','owned','own','ran',
  // calendar words, which are not names and not places
  'monday','tuesday','wednesday','thursday','friday','saturday','sunday','january','february','march','april',
  'may','june','july','august','september','october','november','december',
]);

/**
 * True when a phrase contains a word that rules it out as a NAME.
 *
 * 🔴 This is separate from the place test below on purpose, and sharing one function
 * between them was a real bug for about ten minutes: the whole-phrase gazetteer check
 * is right for people (`British Columbia` is not a person) and is exactly backwards for
 * places, where a gazetteer hit is the BEST possible evidence. Sharing it made
 * `Port Dover` stop being a place.
 */
function hasNonNameWord(phrase: string): boolean {
  return phrase
    .split(/[\s.]+/)
    .filter(Boolean)
    .some((word) => NOT_NAME_WORDS.has(word.toLowerCase()));
}

/** A phrase that is not a person: a technology, an organisation, or a known place. */
function disqualifiedFromBeingAPerson(phrase: string): boolean {
  if (GAZETTEER.has(phrase.trim().toLowerCase())) return true;
  return hasNonNameWord(phrase);
}

/** Words that begin a sentence often enough to be mistaken for a first name. */
const NOT_NAMES = new Set([
  'the','this','that','these','those','there','then','they','them','their','when','where','what','which','while',
  'with','without','would','could','should','after','before','during','because','however','although','though',
  'every','everything','everyone','nothing','something','someone','anything','another','other','first','second',
  'third','last','next','monday','tuesday','wednesday','thursday','friday','saturday','sunday','january',
  'february','march','april','may','june','july','august','september','october','november','december','today',
  'tomorrow','yesterday','dear','note','notes','summary','introduction','conclusion','chapter','part','section',
  'monday','she','he','it','we','you','i','my','our','his','her','its','and','but','for','not','all','some',
  'one','two','three','four','five','six','seven','eight','nine','ten','new','old','good','bad','best','worst',
  'image','figure','table','photo','picture','source','references','appendix','total','average','report','page',
]);

const HONORIFICS = /\b(?:Mr|Mrs|Ms|Miss|Dr|Prof|Sir|Rev|Capt|Sgt|Fr)\.?\s+([A-Z][\p{L}'\u2019-]+)/gu;

function titleCaseMatches(text: string): { phrase: string; index: number }[] {
  const out: { phrase: string; index: number }[] = [];
  // Two or three consecutive capitalised words, which is what a full name is.
  //
  // 🔴 Each word must END IN A LETTER. An earlier version allowed `.` inside a word,
  // which made the full stop of one sentence part of the name and glued two sentences
  // together — "Better. Fixed the fence" was reported as a person called *Better.
  // Fixed*. Requiring a letter at the end drops that and costs nothing real: an
  // abbreviation like `St.` is a place, and places are found by the gazetteer anyway.
  const word = String.raw`[A-Z][\p{L}'\u2019-]*\p{L}`;
  const pattern = new RegExp(String.raw`\b(${word})(?:\s+(${word}))(?:\s+(${word}))?`, 'gu');
  for (const m of text.matchAll(pattern)) {
    const words = [m[1], m[2], m[3]].filter((piece): piece is string => Boolean(piece));
    out.push({ phrase: words.join(' '), index: m.index ?? 0 });
  }
  return out;
}

/**
 * Places, on the test of a preposition or a gazetteer, never a lone capital.
 */
export function findPlaces(text: string): string[] {
  const found: string[] = [];

  // `in Hamilton` · `to Port Dover` · `near St. Catharines`.
  //
  // 🔴 A SINGLE word found this way is only accepted when the gazetteer knows it.
  // Without that condition the rule fired on any preposition followed by a capital,
  // and a resume was read as being located *in TypeScript* and *in PostgreSQL*. A
  // multi-word phrase is accepted on its own, because `in Port Dover` needs no
  // gazetteer to be plainly a place. The cost is a small town missing from the
  // gazetteer and written as one word — and a missed place is nothing next to a
  // wrong one, which is what this rule is really protecting.
  const preposition = /\b(?:in|at|to|from|near|around|outside|across|via|visit(?:ed|ing)?|mov(?:ed|ing) to|flew to|drove to|based in|living in)\s+([A-Z][\p{L}'\u2019.-]+(?:\s+[A-Z][\p{L}'\u2019.-]+){0,2})/gu;
  for (const m of text.matchAll(preposition)) {
    const phrase = (m[1] ?? '').trim();
    if (phrase.length < 3) continue;
    const head = phrase.split(/\s+/)[0] ?? '';
    if (NOT_NAMES.has(head.toLowerCase())) continue;
    // For a PLACE the reject-list is only the technology and organisation words. The
    // gazetteer test must not be applied here — `Port Dover` is in it, and that is the
    // best evidence there is that something is a place.
    if (hasNonNameWord(phrase)) continue;
    const words = phrase.split(/\s+/).length;
    if (words === 1 && !GAZETTEER.has(phrase.toLowerCase())) continue;
    found.push(phrase);
  }

  // Any gazetteer name written with a capital, wherever it sits.
  const words = text.match(/[A-Z][\p{L}'\u2019.-]*/gu) ?? [];
  for (const word of words) {
    if (GAZETTEER.has(word.toLowerCase()) && word.length > 2) found.push(word);
  }

  return found;
}

/**
 * People.
 *
 * Three tiers, strongest first, and the weakest one has to earn its place:
 *
 *  1. **After an honorific** — `Dr. Smith`. Certain.
 *  2. **A full name** — two or three capitalised words in a row, `Necole Fielder`.
 *     `Hamilton Ontario` is rejected here, because the first word is a place.
 *  3. **A lone first name, only if it recurs.** A diary writes `Necole said` far
 *     more often than it writes a surname, and dropping every single name would
 *     lose the most-mentioned person in the document. But one capital does not
 *     make a name — `Meanwhile` and `Tuesday` are not people — so a lone name is
 *     accepted only when it is NOT at the start of a sentence, is not a place, is
 *     not a common opener, is not written in capitals, and **appears at least
 *     twice**. That last condition is what separates a person from a coincidence.
 */
export function findPeople(text: string): string[] {
  const found: string[] = [];

  for (const m of text.matchAll(HONORIFICS)) {
    if (m[1]) found.push(m[1]);
  }

  for (const { phrase } of titleCaseMatches(text)) {
    const words = phrase.split(/\s+/);
    const first = words[0] ?? '';
    const lower = first.toLowerCase();
    if (NOT_NAMES.has(lower) || GAZETTEER.has(lower)) continue;
    if (first.length > 1 && first === first.toUpperCase()) continue;
    if (disqualifiedFromBeingAPerson(phrase)) continue;
    found.push(phrase);
  }

  // A capital that opens a sentence is not evidence of a name, so it is scored
  // differently from one that appears mid-sentence. A capital followed by another
  // capital is part of a longer phrase — `James Street` is a street, and `James` is
  // not a person when `Street` follows it.
  //
  // 🔴 A lone capital is accepted ONLY when it was seen mid-sentence as well. An
  // earlier version also accepted any word appearing three times anywhere, and a
  // resume then produced *Built* as a person — every occurrence of it began a bullet.
  // A real name in a document appears in running prose at least once; a verb that
  // starts sentences never does.
  const places = new Set(findPlaces(text).map((place) => place.toLowerCase()));
  const lone = new Map<string, { total: number; midSentence: number }>();
  for (const m of text.matchAll(/\b([A-Z][a-z]{2,15})\b/gu)) {
    const word = m[1] ?? '';
    const at = m.index ?? 0;
    const before = at === 0 ? '\n' : text[at - 1] ?? '\n';
    const rest = text.slice(at + word.length);
    if (before !== ' ' && before !== '\n') continue;
    if (!/^\s+[a-z\u2019']/.test(rest)) continue;
    const lower = word.toLowerCase();
    if (NOT_NAMES.has(lower) || GAZETTEER.has(lower) || NOT_NAME_WORDS.has(lower)) continue;
    if ([...places].some((place) => place.includes(lower))) continue;
    const entry = lone.get(word) ?? { total: 0, midSentence: 0 };
    entry.total += 1;
    // "Mid-sentence" has to mean mid-SENTENCE, not merely after a space. The space
    // that follows a full stop is still a space, and counting it was how a resume
    // produced *Built* as a person — every occurrence of the word began a sentence
    // that followed another one.
    //
    // 🔴 And neither is a space that follows a BULLET. A resume's whole body is bullet
    // points, so `- Built the asset pipeline` put a verb after a space, the character
    // before that space being `-`. That made every bullet-opening verb look
    // mid-sentence, and the same resume produced *Built*(7), *Created*, *Worked*,
    // *Led*, *Managed*, *Developed*, *Designed*, *Used*, *Implemented*, *Queried*.
    if (before === ' ') {
      const previous = text.slice(0, at).replace(/\s+$/, '').slice(-1);
      if (previous && !/[.!?\-\u2013\u2014*\u2022\u00b7>|("']/.test(previous)) entry.midSentence += 1;
    }
    lone.set(word, entry);
  }

  for (const [word, seen] of lone) {
    if (seen.midSentence >= 1 && seen.total >= 2) found.push(...Array<string>(seen.total).fill(word));
  }

  return found;
}

/** Money, as written. The currency symbol is kept, because it is part of the fact. */
export function findAmounts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:\b(?:CA|US|AU|NZ)\$|\$|\u20ac|\u00a3)\s?\d[\d,]*(?:\.\d{1,2})?\b|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:dollars|euros|pounds|cents)\b/gi)) {
    out.push(m[0].trim());
  }
  return out;
}

/** Tally values across entries, keeping the order they were first seen in. */
export function tally(values: { value: string; entryIndex: number }[]): Mention[] {
  const map = new Map<string, Mention>();
  for (const { value, entryIndex } of values) {
    const clean = value.trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      if (!existing.entries.includes(entryIndex)) existing.entries.push(entryIndex);
      continue;
    }
    map.set(key, { value: clean, count: 1, entries: [entryIndex] });
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/**
 * Which entry each picture belongs to, by the caption it was written with.
 *
 * Kept separate from `extractImages` because the offsets there are positions in the
 * RAW paste, while an entry's offsets are positions in the NORMALISED text. The two
 * are close but not identical, so the match is by the caption when there is one and
 * otherwise the picture is carried by the document rather than pinned to an entry.
 */
export function imagesByEntry(
  images: ImageRef[],
  entries: { index: number; text: string }[]
): ImageRef[] {
  return images.map((image) => {
    const needle = image.caption?.slice(0, 40);
    if (!needle) return image;
    const owner = entries.find((entry) => entry.text.includes(needle));
    return owner ? { ...image, entryIndex: owner.index } : image;
  });
}

export { GAZETTEER, NOT_NAMES, NOT_NAME_WORDS };
